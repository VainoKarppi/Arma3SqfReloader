import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { log, logError, logInfo } from "./settings";
import { findMissingAddonPrefixes, writeAddonPrefixes } from "./addonPrefixes";

/** Read from VS Code settings.json, so both the user and the workspace can configure it. */
const SECTION = "sqfReloader.hemtt";
const PROJECT_CONFIG = path.join(".hemtt", "project.toml");
const ANNOTATIONS_FILE = path.join(".hemttout", "ci_annotations.txt");
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;
const CHANGE_DEBOUNCE_MS = 1500;
const MAX_SCAN_DEPTH = 8;
const MAX_SCANNED_DIRECTORIES = 5000;
/** Where shadow copies of the project are built so unsaved buffers can be checked. */
const SHADOW_DIRECTORY = "hemtt-shadow";
/** Files HEMTT compiles or checks; saving anything else cannot change the result. */
const CHECKED_FILE = /\.(sqf|cpp|hpp|h|cfg|sqm|toml|inc|ext|rvmat|fsm)$/i;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "out", "build", "obj", "bin", "target"]);

export interface HemttConfig {
    enabled: boolean;
    /** Seconds between automatic runs. */
    intervalSeconds: number;
    onSave: boolean;
    /** Also check unsaved edits, through a shadow copy of the project. */
    unsaved: boolean;
    lints: string[];
    executable: string;
}

export interface HemttRunResult {
    projects: number;
    errors: number;
    warnings: number;
    /** Set when nothing was run, e.g. hemtt is missing or the workspace has no project. */
    reason?: string;
}

/** One line of `.hemttout/ci_annotations.txt`. */
export interface HemttAnnotation {
    file: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    level: string;
    title: string;
    message: string;
}

let diagnostics: vscode.DiagnosticCollection | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let saveDebounce: ReturnType<typeof setTimeout> | undefined;
let changeDebounce: ReturnType<typeof setTimeout> | undefined;
let activeRun: Promise<HemttRunResult> | undefined;
let rerunRequested = false;
let executable: string | undefined;
let storageDirectory: string | undefined;
let previousUris = new Set<string>();
/** Last HEMTT abort message per project, so a repeating failure is logged once. */
const lastFailure = new Map<string, string>();
/** Projects the `$PBOPREFIX$` prompt was already shown for in this session. */
const prefixPrompted = new Set<string>();
/** Last reported `errors/warnings` signature per project, so a repeating result is logged once. */
const lastReported = new Map<string, string>();
/** Projects announced in the output channel, so the "checking …" line is not repeated. */
let announcedProjects = "";

export function readHemttConfig(scope?: vscode.Uri): HemttConfig {
    const config = vscode.workspace.getConfiguration(SECTION, scope);
    const interval = config.get<number>("interval", 30);
    const lints = config.get<string[]>("lints", []);
    return {
        enabled: config.get<boolean>("enabled", true),
        intervalSeconds: Number.isFinite(interval) ? Math.max(1, interval) : 30,
        onSave: config.get<boolean>("onSave", true),
        unsaved: config.get<boolean>("unsaved", true),
        lints: (Array.isArray(lints) ? lints : []).map(lint => lint.trim()).filter(Boolean),
        executable: (config.get<string>("executable", "") ?? "").trim()
    };
}

/** Enables the checks and remembers where shadow copies of unsaved projects may be built. */
export function activateHemttCheck(storage: string): void {
    storageDirectory = storage;
    configureHemttCheck();
}

/** Starts (or restarts) the periodic check from the current settings. */
export function configureHemttCheck(): void {
    stopHemttCheck();
    const config = readHemttConfig();

    if (!config.enabled) {
        diagnostics?.clear();
        previousUris.clear();
        lastReported.clear();
        announcedProjects = "";
        return;
    }

    // One line per configuration, not per run: the timer would otherwise repeat it every interval.
    logInfo(`HEMTT checks started: ${describeHemttConfig(config)}.`);
    timer = setInterval(() => void runHemttCheck(), config.intervalSeconds * 1000);
    void runHemttCheck();
}

/** Human-readable summary of the options the checks run with. */
function describeHemttConfig(config: HemttConfig): string {
    return [
        `every ${config.intervalSeconds}s`,
        config.onSave ? "on save" : "not on save",
        config.unsaved ? "including unsaved edits" : "saved files only",
        config.lints.length > 0 ? `lints ${config.lints.join(", ")}` : "project lints",
        config.executable ? `executable ${config.executable}` : "executable from PATH"
    ].join(", ");
}

export function stopHemttCheck(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = undefined;
    if (changeDebounce) clearTimeout(changeDebounce);
    changeDebounce = undefined;
}

export function disposeHemttCheck(): void {
    stopHemttCheck();
    diagnostics?.dispose();
    diagnostics = undefined;
    previousUris.clear();
    if (storageDirectory) {
        const root = path.join(storageDirectory, SHADOW_DIRECTORY);
        void removeShadowTree(root);
    }
}

/** Debounced check after saving a file that belongs to a HEMTT project. */
export function onHemttDocumentSaved(document: vscode.TextDocument): void {
    if (document.uri.scheme !== "file" || !CHECKED_FILE.test(document.uri.fsPath)) return;

    const config = readHemttConfig(document.uri);
    if (!config.enabled || !config.onSave || !isHemttProjectFile(document.uri)) return;

    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => {
        saveDebounce = undefined;
        void runHemttCheck();
    }, SAVE_DEBOUNCE_MS);
}

/**
 * Debounced check while a file is edited but not saved.
 *
 * `hemtt check` only reads files from disk, so the unsaved buffers of the project are written into
 * a shadow copy of it (see `buildShadow`) and HEMTT runs there. The real project is never modified.
 */
export function onHemttDocumentChanged(document: vscode.TextDocument): void {
    if (document.uri.scheme !== "file" || !CHECKED_FILE.test(document.uri.fsPath)) return;

    const config = readHemttConfig(document.uri);
    if (!config.enabled || !config.unsaved || !storageDirectory) return;
    if (!isHemttProjectFile(document.uri)) return;

    if (changeDebounce) clearTimeout(changeDebounce);
    changeDebounce = setTimeout(() => {
        changeDebounce = undefined;
        void runHemttCheck();
    }, CHANGE_DEBOUNCE_MS);
}

/** Runs `hemtt check` for every project in the workspace and mirrors the results into diagnostics. */
export function runHemttCheck(): Promise<HemttRunResult> {
    if (activeRun) {
        // Edits that arrive during a run would otherwise wait for the next timer tick.
        rerunRequested = true;
        return activeRun;
    }

    activeRun = (async () => {
        let result = await executeCheck();
        while (rerunRequested) {
            rerunRequested = false;
            result = await executeCheck();
        }
        return result;
    })().finally(() => {
        activeRun = undefined;
        rerunRequested = false;
    });

    return activeRun;
}

async function executeCheck(): Promise<HemttRunResult> {
    const config = readHemttConfig();

    if (!config.enabled) {
        diagnostics?.clear();
        previousUris.clear();
        return { projects: 0, errors: 0, warnings: 0, reason: "sqfReloader.hemtt.enabled is false." };
    }

    const command = await findHemtt(config);
    if (!command) {
        log("HEMTT check skipped: the hemtt command is not installed or not on PATH.");
        return { projects: 0, errors: 0, warnings: 0, reason: "the hemtt command was not found on PATH." };
    }

    const projects = await findHemttProjects();
    if (projects.length === 0) {
        log("HEMTT check skipped: no .hemtt/project.toml was found in this workspace.");
        return { projects: 0, errors: 0, warnings: 0, reason: "no .hemtt/project.toml was found in this workspace." };
    }

    // Announced once (and again only when the set of projects changes), so a timer run does not
    // repeat the same line every interval.
    const projectList = projects.map(project => path.basename(project)).join(", ");
    if (announcedProjects !== projectList) {
        announcedProjects = projectList;
        logInfo(`HEMTT: checking ${projects.length} project(s): ${projectList}.`);
    }

    const collection = diagnosticCollection();
    const seen = new Set<string>();
    const unsaved = config.unsaved ? unsavedFilesByProject() : new Map<string, Map<string, string>>();
    let errors = 0;
    let warnings = 0;

    for (const project of projects) {
        try {
            await offerMissingPboPrefixes(project);
            const dirty = unsaved.get(project);
            const counts = await checkProject(collection, command, project, config, seen, dirty);
            errors += counts.errors;
            warnings += counts.warnings;
            reportProjectResult(project, counts, dirty);
        } catch (error) {
            logError(`HEMTT check failed for ${project}`, error);
        }
    }

    for (const key of previousUris) {
        if (!seen.has(key)) collection.delete(vscode.Uri.parse(key));
    }
    previousUris = seen;

    return { projects: projects.length, errors, warnings };
}

/**
 * Writes a project's result to the output channel only when it changed.
 *
 * The check runs on a timer, so logging every result would repeat "0 error(s), 0 warning(s)" for
 * every project every interval. A clean first result is silent; a changed result (or a recovery
 * back to clean) is logged once, and the Problems panel always has the current state.
 */
function reportProjectResult(project: string, counts: { errors: number; warnings: number }, dirty?: Map<string, string>): void {
    const signature = `${counts.errors}/${counts.warnings}`;
    const previous = lastReported.get(project);
    if (previous === signature) return;
    lastReported.set(project, signature);

    const name = path.basename(project);
    const source = dirty && dirty.size > 0 ? ` (${dirty.size} unsaved file(s))` : "";

    if (counts.errors === 0 && counts.warnings === 0) {
        // A clean first run is not worth a line; recovering from problems is.
        if (previous !== undefined) logInfo(`HEMTT: ${name} is clean again${source}.`);
        return;
    }

    logInfo(`HEMTT: ${name}${source} has ${counts.errors} error(s), ${counts.warnings} warning(s).`);
}

/**
 * Offers to create the `$PBOPREFIX$` files HEMTT needs. HEMTT aborts with "Addon prefix not found"
 * when one is missing, and it never generates them itself, so a HEMTT project that was just
 * created or copied usually needs this once per addon.
 *
 * Asked at most once per project in a session (the check runs on a timer), and only while HEMTT is
 * enabled and installed, because the files are only useful to HEMTT.
 */
async function offerMissingPboPrefixes(project: string): Promise<void> {
    if (prefixPrompted.has(project)) return;

    const missing = findMissingAddonPrefixes(project);
    if (missing.length === 0) return;

    prefixPrompted.add(project);
    const listed = missing.slice(0, 5).map(addon => addon.addonName).join(", ");
    const remaining = missing.length > 5 ? ` and ${missing.length - 5} more` : "";
    const choice = await vscode.window.showWarningMessage(
        `HEMTT needs a $PBOPREFIX$ for ${missing.length} addon(s) in ${path.basename(project)}: ${listed}${remaining}. Generate them?`,
        "Generate",
        "Not Now"
    );

    if (choice !== "Generate") {
        log(`HEMTT: skipped generating $PBOPREFIX$ for ${project} (${missing.length} addon(s)).`);
        return;
    }

    try {
        writeAddonPrefixes(missing);
        logInfo(`HEMTT: generated $PBOPREFIX$ for ${missing.map(addon => addon.addonName).join(", ")} in ${project}.`);
    } catch (error) {
        logError(`could not create $PBOPREFIX$ files in ${project}`, error);
    }
}

async function checkProject(    collection: vscode.DiagnosticCollection,
    command: string,
    project: string,
    config: HemttConfig,
    seen: Set<string>,
    dirty?: Map<string, string>
): Promise<{ errors: number; warnings: number }> {
    let runRoot = project;
    if (dirty && dirty.size > 0 && storageDirectory) {
        try {
            runRoot = await buildShadow(project, dirty);
            log(`HEMTT: checking unsaved edits of ${project} through ${runRoot}.`);
        } catch (error) {
            logError(`could not build a shadow copy of ${project}; checking the saved files instead`, error);
            runRoot = project;
        }
    }

    try {
        return await checkInRoot(collection, command, project, runRoot, config, seen);
    } finally {
        if (runRoot !== project) await removeShadowTree(runRoot);
    }
}

async function checkInRoot(
    collection: vscode.DiagnosticCollection,
    command: string,
    project: string,
    runRoot: string,
    config: HemttConfig,
    seen: Set<string>
): Promise<{ errors: number; warnings: number }> {
    const annotationsFile = path.join(runRoot, ANNOTATIONS_FILE);
    // HEMTT appends to this file, so a stale copy from an earlier run must not leak in.
    await fs.promises.rm(annotationsFile, { force: true }).catch(() => undefined);

    const args = ["check", "--no-color"];
    for (const lint of config.lints) args.push("--lints", lint);
    const result = await runProcess(command, args, runRoot);

    const byFile = new Map<string, vscode.Diagnostic[]>();
    let errors = 0;
    let warnings = 0;

    try {
        const text = await fs.promises.readFile(annotationsFile, "utf8");
        for (const annotation of parseAnnotations(text)) {
            // Annotations are relative to the project, so a shadow run still maps onto real files.
            const file = path.resolve(project, annotation.file.replace(/^[\\/]+/, ""));
            const list = byFile.get(file) ?? [];
            list.push(toDiagnostic(annotation));
            byFile.set(file, list);
            seen.add(vscode.Uri.file(file).toString());
            if (annotation.level.toLowerCase() === "error") errors++;
            else if (annotation.level.toLowerCase() === "warning") warnings++;
        }
    } catch {
        // No annotations file: HEMTT stopped before reporting diagnostics (e.g. a project config error).
    }

    // HEMTT aborts before reporting anything for some project errors (a broken project.toml, a
    // missing $PBOPREFIX$); those have no annotation, so they are surfaced in the output instead.
    // The same failure repeats every run, so only a changed message is logged.
    if (result.code !== 0 && byFile.size === 0) {
        const failure = lastLines(result.output, 12);
        if (lastFailure.get(project) !== failure) {
            lastFailure.set(project, failure);
            logInfo(`HEMTT check exited with code ${result.code} in ${project}:\n${failure}`);
        }
    } else {
        lastFailure.delete(project);
    }

    for (const [file, list] of byFile) {
        collection.set(vscode.Uri.file(file), list);
    }

    return { errors, warnings };
}

/** Parses `startLine||endLine||startColumn||endColumn||level||title||message||path` lines. */
export function parseAnnotations(text: string): HemttAnnotation[] {
    const annotations: HemttAnnotation[] = [];

    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split("||");
        if (parts.length < 8) continue;

        const annotation: HemttAnnotation = {
            startLine: positiveInteger(parts[0]),
            endLine: positiveInteger(parts[1]),
            startColumn: positiveInteger(parts[2]),
            endColumn: positiveInteger(parts[3]),
            level: parts[4].trim(),
            title: parts[5].trim(),
            message: parts.slice(6, -1).join("||").trim(),
            file: parts[parts.length - 1].trim()
        };

        if (annotation.file && annotation.startLine > 0) annotations.push(annotation);
    }

    return annotations;
}

function toDiagnostic(annotation: HemttAnnotation): vscode.Diagnostic {
    const startLine = annotation.startLine - 1;
    const endLine = Math.max(startLine, (annotation.endLine || annotation.startLine) - 1);
    const start = new vscode.Position(startLine, Math.max(0, annotation.startColumn - 1));
    const end = new vscode.Position(endLine, annotation.endColumn > 1 ? annotation.endColumn - 1 : start.character + 1);
    const text = annotation.message && annotation.message !== annotation.title
        ? `${annotation.title}\n${annotation.message}`
        : annotation.title;
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(start, end.compareTo(start) > 0 ? end : start.translate(0, 1)),
        text,
        severityOf(annotation.level)
    );
    diagnostic.source = "HEMTT";
    return diagnostic;
}

function severityOf(level: string): vscode.DiagnosticSeverity {
    switch (level.toLowerCase()) {
        case "error":
            return vscode.DiagnosticSeverity.Error;
        case "warning":
            return vscode.DiagnosticSeverity.Warning;
        case "notice":
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Hint;
    }
}

/** Every workspace folder (recursively) that holds a `.hemtt/project.toml`. */
export async function findHemttProjects(): Promise<string[]> {
    const projects = new Set<string>();
    const pending: Array<{ directory: string; depth: number }> = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === "file") pending.push({ directory: folder.uri.fsPath, depth: 0 });
    }

    let scanned = 0;
    while (pending.length > 0 && scanned < MAX_SCANNED_DIRECTORIES) {
        const next = pending.shift();
        if (!next) break;
        scanned++;

        if (fs.existsSync(path.join(next.directory, PROJECT_CONFIG))) {
            projects.add(path.resolve(next.directory));
        }
        if (next.depth >= MAX_SCAN_DEPTH) continue;

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(next.directory, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            // Symlinked folders are skipped (isDirectory is false for them) so junctions cannot loop.
            if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
            pending.push({ directory: path.join(next.directory, entry.name), depth: next.depth + 1 });
        }
    }

    return [...projects];
}

/** The HEMTT project (folder with `.hemtt/project.toml`) that contains `uri`. */
function hemttProjectFor(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;

    const root = path.resolve(folder.uri.fsPath);
    let directory = path.resolve(path.dirname(uri.fsPath));

    while (true) {
        if (fs.existsSync(path.join(directory, PROJECT_CONFIG))) return directory;
        if (directory === root) return undefined;
        const parent = path.dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
    }
}

function isHemttProjectFile(uri: vscode.Uri): boolean {
    return hemttProjectFor(uri) !== undefined;
}

/** Unsaved buffers of each HEMTT project, keyed by absolute project path, then by lowercased file path. */
function unsavedFilesByProject(): Map<string, Map<string, string>> {
    const byProject = new Map<string, Map<string, string>>();

    for (const document of vscode.workspace.textDocuments) {
        if (!document.isDirty || document.uri.scheme !== "file") continue;
        const file = path.resolve(document.uri.fsPath);
        if (!CHECKED_FILE.test(file)) continue;

        const project = hemttProjectFor(document.uri);
        if (!project) continue;

        const files = byProject.get(project) ?? new Map<string, string>();
        files.set(file.toLowerCase(), document.getText());
        byProject.set(project, files);
    }

    return byProject;
}

/**
 * Builds a directory that mirrors `project`, with the unsaved buffers written over their files.
 *
 * Directories that hold no unsaved file are junctions to the real ones, so only the folders along
 * an edited file are materialized. HEMTT then runs in the shadow, and the real project is never
 * written to; annotations still map back onto the real paths because the layout is identical.
 */
async function buildShadow(project: string, dirty: Map<string, string>): Promise<string> {
    const root = path.join(storageDirectory!, SHADOW_DIRECTORY, crypto.createHash("sha1").update(project).digest("hex").slice(0, 16));
    await removeShadowTree(root);
    await materializeShadow(project, root, dirty, 0);
    return root;
}

async function materializeShadow(realDirectory: string, shadowDirectory: string, dirty: Map<string, string>, depth: number): Promise<void> {
    await fs.promises.mkdir(shadowDirectory, { recursive: true });

    for (const entry of await fs.promises.readdir(realDirectory, { withFileTypes: true })) {
        const real = path.join(realDirectory, entry.name);
        const shadow = path.join(shadowDirectory, entry.name);

        // HEMTT appends to .hemttout/ci_annotations.txt; the shadow gets its own fresh copy.
        if (entry.name === ".hemttout") continue;

        if (entry.isSymbolicLink()) {
            // Point at the same target instead of copying whatever it holds.
            const stats = await fs.promises.stat(real).catch(() => undefined);
            if (stats?.isDirectory()) await linkDirectory(await fs.promises.realpath(real), shadow);
            else await copyEntry(real, shadow);
        } else if (entry.isDirectory()) {
            if (depth < MAX_SCAN_DEPTH && containsUnsavedFile(real, dirty)) {
                await materializeShadow(real, shadow, dirty, depth + 1);
            } else {
                await linkDirectory(real, shadow);
            }
        } else if (entry.isFile()) {
            const content = dirty.get(path.resolve(real).toLowerCase());
            if (content !== undefined) await fs.promises.writeFile(shadow, content, "utf8");
            else await copyEntry(real, shadow);
        }
    }
}

function containsUnsavedFile(directory: string, dirty: Map<string, string>): boolean {
    const prefix = (directory.toLowerCase().endsWith(path.sep) ? directory : directory + path.sep).toLowerCase();
    for (const file of dirty.keys()) {
        if (file.startsWith(prefix)) return true;
    }
    return false;
}

async function linkDirectory(target: string, link: string): Promise<void> {
    try {
        await fs.promises.symlink(target, link, "junction");
    } catch {
        // Junctions need the same volume family and NTFS; a copy keeps the check working elsewhere.
        await copyEntry(target, link);
    }
}

async function copyEntry(source: string, destination: string): Promise<void> {
    const stats = await fs.promises.stat(source);
    if (!stats.isDirectory()) {
        await fs.promises.copyFile(source, destination);
        return;
    }

    await fs.promises.mkdir(destination, { recursive: true });
    for (const name of await fs.promises.readdir(source)) {
        await copyEntry(path.join(source, name), path.join(destination, name));
    }
}

/** Removes a shadow tree without following its junctions into the real project. */
async function removeShadowTree(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const target = path.join(directory, entry.name);
        // Junctions report as symlinks, and unlinking them never touches their target.
        if (entry.isSymbolicLink() || entry.isFile()) {
            await fs.promises.unlink(target).catch(() => undefined);
            continue;
        }
        if (entry.isDirectory()) await removeShadowTree(target);
    }

    await fs.promises.rmdir(directory).catch(() => undefined);
}

async function findHemtt(config: HemttConfig): Promise<string | undefined> {
    if (config.executable) {
        if (fs.existsSync(config.executable)) return config.executable;
        log(`HEMTT: the executable from sqfReloader.hemtt.executable was not found (${config.executable}).`);
    }
    if (executable) return executable;

    const result = await runProcess("hemtt", ["--version"], undefined);
    // `hemtt --version` exits 1 on some releases even though it prints the version.
    if (result.code === 0 || /\bhemtt\s+\d+\.\d+/i.test(result.output)) {
        executable = "hemtt";
        return executable;
    }

    log(`HEMTT: \`hemtt --version\` failed: ${lastLines(result.output, 3)}`);
    return undefined;
}

function runProcess(target: string, args: string[], cwd: string | undefined): Promise<{ code: number; output: string }> {
    return new Promise(resolve => {
        let output = "";
        let finished = false;
        const finish = (code: number) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            resolve({ code, output });
        };

        let child: ReturnType<typeof spawn>;
        try {
            // scoop/Chocolatey install HEMTT as a .cmd/.bat shim. Node refuses to spawn those
            // directly (EINVAL), so they are executed through cmd.exe with quoting that survives
            // the /s /c rules.
            const shim = resolveShim(target);
            if (shim) {
                const commandLine = [`"${shim}"`, ...args.map(quoteForCmd)].join(" ");
                child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${commandLine}"`], {
                    cwd,
                    windowsHide: true,
                    windowsVerbatimArguments: true
                });
            } else {
                child = spawn(target, args, { cwd, windowsHide: true });
            }
        } catch (error) {
            resolve({ code: -1, output: String(error) });
            return;
        }

        const timeout = setTimeout(() => {
            child.kill();
            finish(-1);
        }, RUN_TIMEOUT_MS);

        child.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.on("error", error => {
            output += String(error);
            finish(-1);
        });
        child.on("close", code => finish(code ?? -1));
    });
}

/** Path of a `.cmd`/`.bat` wrapper for `target`, or undefined when it can be spawned directly. */
const shimCache = new Map<string, string | undefined>();
export function resolveShim(target: string): string | undefined {
    if (shimCache.has(target)) return shimCache.get(target);
    const shim = findShim(target);
    shimCache.set(target, shim);
    return shim;
}

function findShim(target: string): string | undefined {
    if (process.platform !== "win32") return undefined;
    if (/\.(cmd|bat)$/i.test(target)) return fs.existsSync(target) ? target : undefined;
    if (path.extname(target)) return undefined;

    // A bare command name: walk PATH in Windows order (directory, then PATHEXT) and decide on
    // the first hit, so a real .exe in the same folder wins over an accompanying shim.
    const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    for (const directory of (process.env.PATH ?? "").split(";").filter(Boolean)) {
        for (const extension of extensions) {
            const candidate = path.join(directory, target + extension.toLowerCase());
            if (!fs.existsSync(candidate)) continue;
            return /\.(cmd|bat)$/i.test(candidate) ? candidate : undefined;
        }
    }

    return undefined;
}

function quoteForCmd(value: string): string {
    return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function positiveInteger(value: string | undefined): number {
    const parsed = Number.parseInt((value ?? "").trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function lastLines(value: string, count: number): string {
    return value.trim().split(/\r?\n/).slice(-count).join("\n");
}

function diagnosticCollection(): vscode.DiagnosticCollection {
    if (!diagnostics) {
        diagnostics = vscode.languages.createDiagnosticCollection("sqfReloader-hemtt");
    }
    return diagnostics;
}
