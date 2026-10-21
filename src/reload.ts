import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { Addon, findAddonForFile, findArmaDirectory, findMissions, readFunctionTag, toArmaPath, toFunctionVariable } from "./arma";
import { evalCode, listFunctions, reloadEverything, sqfString } from "./api";
import { Settings, log, logError } from "./settings";
import { workspaceAddons } from "./runtime";

export interface ReloadOutcome {
    ok: boolean;
    message: string;
    detail?: string;
}

let snapshotSequence = 0;

interface CompileSnapshot {
    armaPath: string;
    directory: string;
}

interface MissionFunction {
    directory: string;
    variable: string;
}

function notify(settings: Settings, message: string): void {
    if (settings.notifyOnError) {
        vscode.window.showWarningMessage(`Arma 3 SQF Reloader: ${message}`);
    }
}

/**
 * Pushes a saved SQF file to Arma.
 *
 * Compile directly from the workspace's Arma alias, so the result does not depend on the
 * function appearing in CfgFunctions or on SqfReloader's config scan.
 */
export async function reloadDocument(document: vscode.TextDocument, settings: Settings): Promise<ReloadOutcome> {
    if (settings.reloadOnSave === "off") {
        return { ok: true, message: "Reload on save is disabled." };
    }

    if (document.uri.scheme !== "file" || !/\.(sqf|cpp|hpp)$/i.test(document.fileName)) {
        return { ok: true, message: "Not a saved SQF/C++ file." };
    }

    const missionFunction = findMissionFunction(document.fileName);

    if (missionFunction) {
        const mission = findMissions((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath))
            .find(candidate => path.resolve(candidate.directory).toLowerCase() === missionFunction.directory.toLowerCase());
        if (!mission) {
            return { ok: false, message: "Could not find the mission for this function." };
        }

        const originalArmaPath = `${path.basename(mission.directory)}\\${path.relative(mission.directory, document.fileName).replace(/[\\/]+/g, "\\")}`;
        log(`Saved mission function ${document.fileName} -> ${missionFunction.variable}`);

        try {
            const snapshot = await writeMissionCompileSnapshot(mission.directory, document.fileName, document.getText(), settings);
            scheduleSnapshotCleanup(snapshot.directory);
            const result = await evalCode(settings, compileAssignment(missionFunction.variable, snapshot.armaPath));
            return result.success
                ? { ok: true, message: `Recompiled ${missionFunction.variable} from saved mission snapshot (${originalArmaPath}).` }
                : { ok: false, message: result.error ?? "Mission function compile failed" };
        } catch (error) {
            logError("mission function compile request failed", error);
            const message = error instanceof Error ? error.message : String(error);
            notify(settings, message);
            return { ok: false, message };
        }
    }

    const addon = findAddonForFile(document.fileName);

    if (!addon) {
        const message = `${path.basename(document.fileName)} is not inside a folder with $PBOPREFIX$, so Arma cannot load it. Use "SqfReloader: Set up this mod" first.`;
        log(message);
        notify(settings, message);
        return { ok: false, message };
    }

    const variable = toFunctionVariable(addon, document.fileName);

    if (!variable) {
        // config.cpp / init / helpers are not functions: ask Arma to recompile this addon's
        // functions, which re-runs the cost of the changed file on next call.
        log(`${path.basename(document.fileName)} is not a fn_*.sqf function; reloading the mod's functions instead.`);
        return reloadAll(settings, true);
    }

    const armaPath = toArmaPath(addon, document.fileName);
    log(`Saved ${document.fileName} -> ${variable} (${armaPath})`);

    try {
        const snapshot = await writeCompileSnapshot(addon, document.fileName, document.getText(), settings);
        scheduleSnapshotCleanup(snapshot.directory);
        const code = compileAssignment(variable, snapshot.armaPath);
        const result = await evalCode(settings, code);

        return result.success
            ? { ok: true, message: `Recompiled ${variable} from saved snapshot of ${armaPath}.` }
            : { ok: false, message: result.error ?? "Compile failed" };
    } catch (error) {
        logError("compile request failed", error);
        const message = error instanceof Error ? error.message : String(error);
        notify(settings, message);
        return { ok: false, message };
    }
}

/**
 * Arma can keep a file-patching source open briefly while preprocessing it. Compile an
 * immutable copy under the Arma installation's z tree so no generated files appear beside
 * workspace sources. The addon's relative directory layout is mirrored for #include paths.
 */
async function writeCompileSnapshot(addon: Addon, sourcePath: string, content: string, settings: Settings): Promise<CompileSnapshot> {
    const hash = snapshotHash(addon.localDirectory);
    return writeSnapshot(addon.localDirectory, sourcePath, content, settings, [hash], ["addons", addon.name]);
}

async function writeMissionCompileSnapshot(missionDirectory: string, sourcePath: string, content: string, settings: Settings): Promise<CompileSnapshot> {
    const hash = snapshotHash(missionDirectory);
    return writeSnapshot(missionDirectory, sourcePath, content, settings, ["Missions", hash], ["missions", path.basename(missionDirectory)]);
}

function snapshotHash(directory: string): string {
    return require("crypto").createHash("sha1")
        .update(path.resolve(directory).toLowerCase())
        .digest("hex")
        .slice(0, 10) as string;
}

async function writeSnapshot(
    sourceRoot: string,
    sourcePath: string,
    content: string,
    settings: Settings,
    cacheSegments: string[],
    sourceSegments: string[]
): Promise<CompileSnapshot> {
    const armaDirectory = await findArmaDirectory(settings);
    if (!armaDirectory) {
        throw new Error("Arma 3 was not found; set sqfReloader.armaDirectory to store the compile snapshot under its z folder.");
    }

    const id = `${Date.now()}-${++snapshotSequence}`;
    const cacheRoot = path.join(armaDirectory, "z", "SqfReloader", "Snapshots", ...cacheSegments, id);
    const cacheSourceRoot = path.join(cacheRoot, ...sourceSegments);
    const relativeSource = path.relative(sourceRoot, sourcePath);
    const relativeDirectory = path.dirname(relativeSource);
    const sourceName = path.basename(sourcePath);
    const snapshotName = sourceName.replace(/\.sqf$/i, `.sqfreloader-${id}.sqf`);
    const snapshotPath = path.join(cacheSourceRoot, relativeDirectory, snapshotName);

    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, content, { encoding: "utf8", flag: "wx" });

    // Copy quoted, relative #include dependencies into the parallel cache tree. This keeps
    // them resolvable from the snapshot's mirrored directory without copying the whole addon.
    const copyIncludes = (includedFile: string, includedText: string, visited: Set<string>): void => {
        const key = path.resolve(includedFile).toLowerCase();
        if (visited.has(key)) return;
        visited.add(key);

        const includePattern = /^\s*#\s*include\s+"([^\"]+)"/gim;
        for (const match of includedText.matchAll(includePattern)) {
            const includePath = path.resolve(path.dirname(includedFile), match[1]);
            if (!fs.existsSync(includePath) || !fs.statSync(includePath).isFile()) continue;

            const relativeInclude = path.relative(sourceRoot, includePath);
            const destination = path.resolve(cacheSourceRoot, relativeInclude);
            const relativeToCache = path.relative(cacheRoot, destination);
            if (relativeToCache.startsWith("..") || path.isAbsolute(relativeToCache)) continue;

            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(includePath, destination);
            copyIncludes(includePath, fs.readFileSync(includePath, "utf8"), visited);
        }
    };

    copyIncludes(sourcePath, content, new Set());

    const relativeCacheFile = path.relative(path.join(armaDirectory, "z"), snapshotPath).replace(/[\\/]+/g, "\\");
    const armaPath = `z\\${relativeCacheFile}`;
    return { armaPath, directory: cacheRoot };
}

function findMissionFunction(filePath: string): MissionFunction | undefined {
    if (!/^fn_[\w-]+\.sqf$/i.test(path.basename(filePath))) return undefined;

    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    for (const mission of findMissions(roots)) {
        const relative = path.relative(mission.directory, filePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;

        const tag = readFunctionTag(mission.directory);
        if (!tag) continue;

        return {
            directory: path.resolve(mission.directory),
            variable: `${tag}_fnc_${path.basename(filePath).slice(3, -4)}`
        };
    }

    return undefined;
}

function scheduleSnapshotCleanup(snapshotDirectory: string, attempt = 0): void {
    const timer = setTimeout(() => {
        try {
            fs.rmSync(snapshotDirectory, { recursive: true, force: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < 10) {
                scheduleSnapshotCleanup(snapshotDirectory, attempt + 1);
            }
        }
    }, 10 * 60_000);
    timer.unref?.();
}

/** Calls the SQF reloader for every function of the mod (or all known functions with fallback). */
export async function reloadAll(settings: Settings, silent = false): Promise<ReloadOutcome> {
    try {
        const result = await reloadEverything(settings);

        if (result.success) {
            const count = typeof result.count === "number" ? ` (${result.count} function${result.count === 1 ? "" : "s"})` : "";
            return { ok: true, message: `Reload queued${count}.` };
        }

        return { ok: false, message: result.error ?? "Reload failed" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("reload all failed", error);

        if (!silent) {
            notify(settings, message);
        }

        return { ok: false, message };
    }
}

function compileAssignment(variable: string, armaPath: string): string {
    return `private _sqfReloadFunction = compile preprocessFileLineNumbers ${sqfString(armaPath)};\n` +
        `missionNamespace setVariable [${sqfString(variable)}, _sqfReloadFunction];\n` +
        `diag_log format ["[SqfReloader] registered %1 from %2 (isNil=%3)", ${sqfString(variable)}, ${sqfString(armaPath)}, isNil {missionNamespace getVariable ${sqfString(variable)}}];`;
}

/** Injects every workspace fn_*.sqf into missionNamespace through its z\ mod junction. */
export async function registerWorkspaceFunctions(settings: Settings): Promise<ReloadOutcome> {
    const assignments: string[] = [];

    for (const addon of workspaceAddons()) {
        const visit = (directory: string): void => {
            let entries: fs.Dirent[];

            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const filePath = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    visit(filePath);
                    continue;
                }

                if (!entry.isFile() || !/^fn_[\w-]+\.sqf$/i.test(entry.name)) {
                    continue;
                }

                const variable = toFunctionVariable(addon, filePath);
                if (variable) {
                    assignments.push(compileAssignment(variable, toArmaPath(addon, filePath)));
                }
            }
        };

        visit(addon.localDirectory);
    }

    if (assignments.length === 0) {
        log("No workspace fn_*.sqf functions found to inject.");
        return { ok: false, message: "No workspace functions found." };
    }

    assignments.push(`diag_log format ["[SqfReloader] workspace injection finished: %1 functions", ${assignments.length}];`);

    try {
        const result = await evalCode(settings, assignments.join("\n"));
        if (!result.success) {
            return { ok: false, message: result.error ?? "Function injection failed." };
        }

        log(`Queued injection of ${assignments.length - 1} workspace functions into missionNamespace.`);
        return { ok: true, message: `Queued ${assignments.length - 1} workspace functions for injection.` };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("workspace function injection failed", error);
        return { ok: false, message };
    }
}

/** Reads the list of files SqfReloader can hot reload (its own SQF sources). */
export async function sourceIndex(settings: Settings): Promise<string[]> {
    const result = await listFunctions(settings);
    const functions = Array.isArray(result.functions) ? result.functions as unknown[][] : [];

    return functions
        .filter(entry => Array.isArray(entry) && typeof entry[2] === "string")
        .map(entry => String(entry[2]));
}

/** Forces a compile of one file through /api/eval (used by "Reload current function"). */
export async function reloadFileNow(document: vscode.TextDocument, settings: Settings): Promise<ReloadOutcome> {
    const missionFunction = findMissionFunction(document.fileName);
    if (missionFunction) {
        const snapshot = await writeMissionCompileSnapshot(missionFunction.directory, document.fileName, document.getText(), settings);
        scheduleSnapshotCleanup(snapshot.directory);
        const result = await evalCode(settings, compileAssignment(missionFunction.variable, snapshot.armaPath));
        return result.success
            ? { ok: true, message: `Recompiled ${missionFunction.variable} from the mission snapshot.` }
            : { ok: false, message: result.error ?? "Mission function compile failed" };
    }

    const addon = findAddonForFile(document.fileName);

    if (!addon) {
        return { ok: false, message: "The file is not inside a mod addon ($PBOPREFIX$ not found)." };
    }

    const variable = toFunctionVariable(addon, document.fileName);

    if (!variable) {
        return reloadAll(settings);
    }

    const armaPath = toArmaPath(addon, document.fileName);
    const snapshot = await writeCompileSnapshot(addon, document.fileName, document.getText(), settings);
    scheduleSnapshotCleanup(snapshot.directory);
    const code = compileAssignment(variable, snapshot.armaPath);

    const result = await evalCode(settings, code);

    if (!result.success) {
        return { ok: false, message: result.error ?? "Reload failed" };
    }

    return { ok: true, message: `Recompiled ${variable} from ${armaPath}.` };
}

/** Files that should trigger a reload when saved. */
export function isReloadable(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== "file") {
        return false;
    }

    return /\.(sqf|cpp|hpp)$/i.test(document.fileName);
}
