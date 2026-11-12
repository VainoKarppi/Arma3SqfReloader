import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { log, logError, logInfo } from "./settings";

/** Read from VS Code settings.json, so both the user and the workspace can configure it. */
const SECTION = "sqfReloader.hemtt";
const PROJECT_CONFIG = path.join(".hemtt", "project.toml");
const ANNOTATIONS_FILE = path.join(".hemttout", "ci_annotations.txt");
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;
const MAX_SCAN_DEPTH = 8;
const MAX_SCANNED_DIRECTORIES = 5000;
/** Files HEMTT compiles or checks; saving anything else cannot change the result. */
const CHECKED_FILE = /\.(sqf|cpp|hpp|h|cfg|sqm|toml|inc|ext|rvmat|fsm)$/i;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "out", "build", "obj", "bin", "target"]);

export interface HemttConfig {
    enabled: boolean;
    /** Seconds between automatic runs. */
    intervalSeconds: number;
    onSave: boolean;
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
let activeRun: Promise<HemttRunResult> | undefined;
let executable: string | undefined;
let previousUris = new Set<string>();

export function readHemttConfig(scope?: vscode.Uri): HemttConfig {
    const config = vscode.workspace.getConfiguration(SECTION, scope);
    const interval = config.get<number>("interval", 30);
    const lints = config.get<string[]>("lints", []);
    return {
        enabled: config.get<boolean>("enabled", true),
        intervalSeconds: Number.isFinite(interval) ? Math.max(1, interval) : 30,
        onSave: config.get<boolean>("onSave", true),
        lints: (Array.isArray(lints) ? lints : []).map(lint => lint.trim()).filter(Boolean),
        executable: (config.get<string>("executable", "") ?? "").trim()
    };
}

/** Starts (or restarts) the periodic check from the current settings. */
export function configureHemttCheck(): void {
    stopHemttCheck();
    const config = readHemttConfig();

    if (!config.enabled) {
        diagnostics?.clear();
        previousUris.clear();
        return;
    }

    timer = setInterval(() => void runHemttCheck(), config.intervalSeconds * 1000);
    void runHemttCheck();
}

export function stopHemttCheck(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = undefined;
}

export function disposeHemttCheck(): void {
    stopHemttCheck();
    diagnostics?.dispose();
    diagnostics = undefined;
    previousUris.clear();
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

/** Runs `hemtt check` for every project in the workspace and mirrors the results into diagnostics. */
export function runHemttCheck(): Promise<HemttRunResult> {
    if (!activeRun) {
        activeRun = executeCheck().finally(() => {
            activeRun = undefined;
        });
    }
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

    const collection = diagnosticCollection();
    const seen = new Set<string>();
    let errors = 0;
    let warnings = 0;

    for (const project of projects) {
        try {
            const counts = await checkProject(collection, command, project, config, seen);
            errors += counts.errors;
            warnings += counts.warnings;
            logInfo(`HEMTT check ${path.basename(project)}: ${counts.errors} error(s), ${counts.warnings} warning(s).`);
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

async function checkProject(
    collection: vscode.DiagnosticCollection,
    command: string,
    project: string,
    config: HemttConfig,
    seen: Set<string>
): Promise<{ errors: number; warnings: number }> {
    const annotationsFile = path.join(project, ANNOTATIONS_FILE);
    // HEMTT appends to this file, so a stale copy from an earlier run must not leak in.
    await fs.promises.rm(annotationsFile, { force: true }).catch(() => undefined);

    const args = ["check", "--no-color"];
    for (const lint of config.lints) args.push("--lints", lint);
    const result = await runProcess(command, args, project);

    const byFile = new Map<string, vscode.Diagnostic[]>();
    let errors = 0;
    let warnings = 0;

    try {
        const text = await fs.promises.readFile(annotationsFile, "utf8");
        for (const annotation of parseAnnotations(text)) {
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

    if (result.code !== 0 && byFile.size === 0) {
        log(`HEMTT check exited with code ${result.code} in ${project}:\n${lastLines(result.output, 12)}`);
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

function isHemttProjectFile(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return false;

    const root = path.resolve(folder.uri.fsPath);
    let directory = path.resolve(path.dirname(uri.fsPath));

    while (true) {
        if (fs.existsSync(path.join(directory, PROJECT_CONFIG))) return true;
        if (directory === root) return false;
        const parent = path.dirname(directory);
        if (parent === directory) return false;
        directory = parent;
    }
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
            child = spawn(target, args, { cwd, windowsHide: true });
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
