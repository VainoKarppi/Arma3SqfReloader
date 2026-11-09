import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { Addon, findAddonForFile, findArmaDirectory, findMissions, readFunctionTag, toArmaPath, toFunctionVariable } from "./arma";
import { evalCode, getStatus, listFunctions, reloadEverything, sqfString } from "./api";
import { Settings, log, logError } from "./settings";
import { workspaceAddons } from "./runtime";

export interface ReloadOutcome {
    ok: boolean;
    message: string;
    detail?: string;
}

function compileAndBroadcastAssignment(variable: string, armaPath: string): string {
    return `${compileAssignment(variable, armaPath)}\n` +
        `if (isServer) then { [${sqfString(variable)}, missionNamespace getVariable ${sqfString(variable)}] remoteExecCall ["SqfReloader_fnc_receiveReloadedFunction", 0, false]; };`;
}

function missionCompileAssignment(variable: string, armaPath: string, multiplayer: boolean): string {
    const assignment = compileAssignment(variable, armaPath);
    return multiplayer ? compileAndBroadcastAssignment(variable, armaPath) : assignment;
}

let snapshotSequence = 0;
const snapshotCleanupOperations = new Map<string, Promise<void>>();

interface CompileSnapshot {
    armaPath: string;
    directory: string;
}

interface MissionFunction {
    directory: string;
    variable: string;
}

let hasWarnedMultiplayerRemoteExec = false;

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
        const mission = findMissions([
            ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
            missionFunction.directory
        ]).find(candidate => path.resolve(candidate.directory).toLowerCase() === missionFunction.directory.toLowerCase());
        if (!mission) {
            return { ok: false, message: "Could not find the mission for this function." };
        }

        const originalArmaPath = `${path.basename(mission.directory)}\\${path.relative(mission.directory, document.fileName).replace(/[\\/]+/g, "\\")}`;
        log(`Saved mission function ${document.fileName} -> ${missionFunction.variable}`);

        try {
            const snapshot = await writeMissionCompileSnapshot(mission.directory, document.fileName, document.getText(), settings);
            scheduleSnapshotCleanup(snapshot.directory);
            const result = await evalCode(settings, missionCompileAssignment(missionFunction.variable, snapshot.armaPath, mission.multiplayer));
            if (mission.multiplayer && result.success && !hasWarnedMultiplayerRemoteExec) {
                hasWarnedMultiplayerRemoteExec = true;
                log("Multiplayer function broadcast uses SqfReloader_fnc_receiveReloadedFunction; allow it in the mission's CfgRemoteExec.");
            }
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
        const message = `${path.basename(document.fileName)} is not inside a recognized addon source folder (config.cpp or functions/). Use "SqfReloader: Set up this mod" first.`;
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
        const code = compileAndBroadcastAssignment(variable, snapshot.armaPath);
        const result = await evalCode(settings, code);

        if (result.success && !hasWarnedMultiplayerRemoteExec) {
            hasWarnedMultiplayerRemoteExec = true;
            log("Mod function broadcast uses SqfReloader_fnc_receiveReloadedFunction; allow it in the mission's CfgRemoteExec.");
        }

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
        throw new Error("Arma 3 was not found; set armaDirectory in .vscode/sqfReloader-settings.json to store the compile snapshot under its z folder.");
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

/** Removes the extension-owned snapshot mount after the Arma process has exited. */
export function cleanupSnapshots(armaDirectory: string): void {
    const snapshotRoot = path.join(armaDirectory, "z", "SqfReloader");
    const key = path.resolve(snapshotRoot).toLowerCase();
    if (snapshotCleanupOperations.has(key)) return;

    const operation = removeSnapshotRoot(snapshotRoot);
    snapshotCleanupOperations.set(key, operation);
    void operation.finally(() => snapshotCleanupOperations.delete(key));
}

async function removeSnapshotRoot(snapshotRoot: string): Promise<void> {
    for (let attempt = 0; attempt <= 10; attempt++) {
        try {
            const stat = await fs.promises.lstat(snapshotRoot);
            // Never recurse through a link if this managed path was replaced by something else.
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                log(`Leaving ${snapshotRoot} in place because it is not a regular directory.`);
                return;
            }

            await fs.promises.rm(snapshotRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            try {
                await fs.promises.lstat(snapshotRoot);
                throw Object.assign(new Error(`SqfReloader snapshot cleanup did not remove ${snapshotRoot}.`), { code: "ENOTEMPTY" });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    log(`Removed SqfReloader snapshots: ${snapshotRoot}`);
                    return;
                }
                throw error;
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return;

            if (["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"].includes(code ?? "") && attempt < 10) {
                log(`SqfReloader snapshot cleanup is waiting for files to unlock (attempt ${attempt + 1}/10).`);
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }

            logError(`could not remove SqfReloader snapshots at ${snapshotRoot}`, error);
            return;
        }
    }
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

/**
 * Restarts SQF scripts originating from the mission folder, then recompiles mission
 * CfgFunctions and reruns the mission startup entry points on their owning machines.
 */
export async function reloadAndRestartMission(settings: Settings, mission: Pick<MissionFunction, "directory">): Promise<ReloadOutcome> {
    if (!fs.existsSync(path.join(mission.directory, "mission.sqm"))) {
        return { ok: false, message: "The selected mission has no mission.sqm." };
    }
    const missionFile = (name: string): string => sqfString(name);
    const missionDirectory = mission.directory.replace(/[\\/]+$/, "").replace(/\\/g, "\\\\") + "\\\\";
    const initSqf = fs.existsSync(path.join(mission.directory, "init.sqf"));
    const initServer = fs.existsSync(path.join(mission.directory, "initServer.sqf"));
    const initPlayerLocal = fs.existsSync(path.join(mission.directory, "initPlayerLocal.sqf"));
    const initPlayerServer = fs.existsSync(path.join(mission.directory, "initPlayerServer.sqf"));
    const serverInitFunction = sqfString("SqfReloader_fnc_runMissionPlayerServerInit");
    const playerServerInitFile = missionFile("initPlayerServer.sqf");
    const script = `private _missionPath = toLower ${sqfString(missionDirectory)};
private _pathPrefix = _missionPath + "/";
private _windowsPathPrefix = _missionPath + "\\";
private _terminated = 0;
private _scriptPathCount = 0;
private _activeScripts = diag_activeSQFScripts;
{
    private _source = toLower (_x param [1, ""]);
    private _thread = _x param [4, scriptNull];
    private _inMission = (_source find _pathPrefix == 0) || {_source find _windowsPathPrefix == 0};
    if (_inMission) then {
        _scriptPathCount = _scriptPathCount + 1;
    };
    if (_inMission && {_thread isEqualType scriptNull}) then {
        terminate _thread;
        _terminated = _terminated + 1;
    };
} forEach _activeScripts;
private _reloaded = [] call SqfReloader_fnc_reloadFunctions;
private _initCount = 0;
${initSqf ? `call compile preprocessFileLineNumbers ${missionFile("init.sqf")}; _initCount = _initCount + 1;` : ""}
if (isServer) then { ${initServer ? `call compile preprocessFileLineNumbers ${missionFile("initServer.sqf")}; _initCount = _initCount + 1;` : ""} };
if (hasInterface) then { ${initPlayerLocal ? `call compile preprocessFileLineNumbers ${missionFile("initPlayerLocal.sqf")}; _initCount = _initCount + 1;` : ""} };
if (isServer && {isMultiplayer} && {${initPlayerServer}}) then {
    {
        private _player = _x;
        [_player, false, ${playerServerInitFile}] remoteExecCall [${serverInitFunction}, 2];
        _initCount = _initCount + 1;
    } forEach allPlayers;
};
[ _terminated, _reloaded, _scriptPathCount, _initCount ]`;

    try {
        const result = await evalCode(settings, script, settings.runTimeout * 1000);
        if (!result.success) {
            return { ok: false, message: result.error ?? "Mission function restart failed." };
        }

        const values = result.result as unknown[];
        const terminated = typeof values?.[0] === "number" ? values[0] : 0;
        const reloaded = typeof values?.[1] === "number" ? values[1] : 0;
        const scriptPaths = typeof values?.[2] === "number" ? values[2] : 0;
        const initialized = typeof values?.[3] === "number" ? values[3] : 0;
        if (scriptPaths > terminated) {
            return { ok: false, message: `Found ${scriptPaths} mission SQF script(s) but could terminate only ${terminated}.` };
        }
        return {
            ok: true,
            message: `Terminated ${terminated} mission script(s), reloaded ${reloaded} mission function(s), and ran ${initialized} applicable initialization script(s).`
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("mission function restart failed", error);
        return { ok: false, message };
    }
}

function compileAssignment(variable: string, armaPath: string): string {
    return `private _sqfReloadFunction = compile preprocessFileLineNumbers ${sqfString(armaPath)};\n` +
        `missionNamespace setVariable [${sqfString(variable)}, _sqfReloadFunction];`;
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
        return { ok: false, message: "No workspace functions found." };
    }

    try {
        const result = await evalCode(settings, assignments.join("\n"));
        if (!result.success) {
            return { ok: false, message: result.error ?? "Function injection failed." };
        }

        log(`Queued injection of ${assignments.length} workspace functions into missionNamespace.`);
        return { ok: true, message: `Queued ${assignments.length} workspace functions for injection.` };
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
        const mission = findMissions([
            ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
            missionFunction.directory
        ])
            .find(candidate => path.resolve(candidate.directory).toLowerCase() === path.resolve(missionFunction.directory).toLowerCase());
        const result = await evalCode(settings, missionCompileAssignment(missionFunction.variable, snapshot.armaPath, mission?.multiplayer === true));
        return result.success
            ? { ok: true, message: `Recompiled ${missionFunction.variable} from the mission snapshot.` }
            : { ok: false, message: result.error ?? "Mission function compile failed" };
    }

    const addon = findAddonForFile(document.fileName);

    if (!addon) {
        return { ok: false, message: "The file is not inside a recognized mod addon (config.cpp or functions/ not found)." };
    }

    const variable = toFunctionVariable(addon, document.fileName);

    if (!variable) {
        return reloadAll(settings);
    }

    const armaPath = toArmaPath(addon, document.fileName);
    const snapshot = await writeCompileSnapshot(addon, document.fileName, document.getText(), settings);
    scheduleSnapshotCleanup(snapshot.directory);
    const code = compileAndBroadcastAssignment(variable, snapshot.armaPath);

    const result = await evalCode(settings, code);

    if (!result.success) {
        return { ok: false, message: result.error ?? "Reload failed" };
    }

    if (!hasWarnedMultiplayerRemoteExec) {
        hasWarnedMultiplayerRemoteExec = true;
        log("Mod function broadcast uses SqfReloader_fnc_receiveReloadedFunction; allow it in the mission's CfgRemoteExec.");
    }

    return { ok: true, message: `Recompiled ${variable} from ${armaPath}.` };
}

/** Executes an SQF file in Arma and waits for its return value through the local API. */
export async function runSqfFile(document: vscode.TextDocument, settings: Settings, withParameters = false): Promise<ReloadOutcome> {
    if (document.uri.scheme !== "file" || !/\.sqf$/i.test(document.fileName)) {
        return { ok: false, message: "Run in Arma works with saved .sqf files." };
    }

    try {
        const status = await getStatus(settings);
        if (status.gameConnected !== true) {
            return {
                ok: false,
                message: "Arma 3 is open, but SqfReloader has not connected to its SQF runtime yet. Start Arma with SqfReloader: Play and wait for startup, or open Eden/the mission if Arma was started another way."
            };
        }
    } catch {
        return {
            ok: false,
            message: "Arma 3 is open, but SqfReloader's API is not ready. Start Arma with SqfReloader: Play and wait for the connection before running SQF."
        };
    }

    if (document.isDirty && !(await document.save())) {
        return { ok: false, message: "Save the SQF file before running it in Arma." };
    }

    let parameters = "[]";
    if (withParameters) {
        const answer = await vscode.window.showInputBox({
            title: `Run ${path.basename(document.fileName)} in Arma`,
            prompt: "Enter the SQF argument array to pass to params (for example [1, 1]).",
            placeHolder: "[1, 1]",
            value: "[]",
            ignoreFocusOut: true
        });

        if (answer === undefined) return { ok: false, message: "Run canceled." };
        parameters = answer.trim() || "[]";

        if (!parameters.startsWith("[") || !parameters.endsWith("]")) {
            return { ok: false, message: "Parameters must be an SQF array, for example [1, 1]." };
        }
    }

    const missionDirectory = findMissionDirectory(document.fileName);
    let snapshot: CompileSnapshot;

    if (missionDirectory) {
        snapshot = await writeMissionCompileSnapshot(missionDirectory, document.fileName, document.getText(), settings);
    } else {
        const addon = findAddonForFile(document.fileName);
        if (!addon) {
            return { ok: false, message: "The file is not inside a recognized addon or mission folder." };
        }
        snapshot = await writeCompileSnapshot(addon, document.fileName, document.getText(), settings);
    }

    scheduleSnapshotCleanup(snapshot.directory);
    const timeoutMs = settings.runTimeout * 1000;
    const sqfCode = `private _sqfRunFunction = compile preprocessFileLineNumbers ${sqfString(snapshot.armaPath)}; (${parameters}) call _sqfRunFunction`;

    try {
        const result = await evalCode(settings, sqfCode, timeoutMs);
        if (!result.success) return { ok: false, message: result.error ?? "Arma rejected the run request." };
        log(`Run completed for ${document.fileName}; snapshot ${snapshot.armaPath}`);
        const resultText = typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? null);
        return { ok: true, message: `Arma result: ${resultText}` };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`run request for ${document.fileName} failed`, error);
        return { ok: false, message };
    }
}

function findMissionDirectory(filePath: string): string | undefined {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    for (const mission of findMissions(roots)) {
        const relative = path.relative(mission.directory, filePath);
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) return path.resolve(mission.directory);
    }
    return undefined;
}

/** Files that should trigger a reload when saved. */
export function isReloadable(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== "file") {
        return false;
    }

    return /\.(sqf|cpp|hpp)$/i.test(document.fileName);
}
