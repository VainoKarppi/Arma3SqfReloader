import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { findArmaDirectory, findMissions, findMods, MissionFolder, pickArmaDirectory, toArmaPath } from "./arma";
import { getOutput, log, logError, readSettings, Settings } from "./settings";
import { projectSetting } from "./projectSettings";
import { PreparedLaunch, prepareRuntime, Runtime, verifyWorkspaceAddons, workspaceAddons, workspaceMods, writeApiConfig } from "./runtime";
import { createLinks, linkMissions } from "./junctions";
import { createLinksWithRepair } from "./linkRepair";
import { cleanupSnapshots } from "./reload";
import { parseApiUrl } from "./ports";
import { modTypeForDirectory } from "./modTypes";
import { launchModFolders, launchServerModFolders, modFoldersOnce } from "./launchMods";
import { fireHook, HookContext, runHook } from "./hooks";

/** Port the resolved project API URL requests, before any fallback is applied. */
function requestedApiPort(settings: Settings): number {
    return parseApiUrl(settings.apiUrl).port;
}

export interface LaunchOptions {
    /** Extra launch parameters, e.g. "-window -noSplash". */
    extraArguments?: string[];
    /** Existing game mission launch arguments, if any. */
    mission?: string;
    /** Absolute mission.sqm path; Arma opens this scenario directly in Eden at startup. */
    scenarioFile?: string;
    /** Mission to ensure is linked into the selected profile's Missions/MPMissions folder. */
    missionFolder?: MissionFolder;
    /** Host the selected mission in a listen-server session. */
    hostMission?: boolean;
    /** Start arma3server_x64.exe with the selected server config and mission. */
    dedicatedServer?: boolean;
    serverConfig?: string;
    /** Extra mod roots to include in the Arma launch (for generated server examples). */
    additionalModDirectories?: string[];
    /** Show the exact dedicated-server command and ask before starting. */
    confirmLaunch?: boolean;
}

let armaProcess: ReturnType<typeof spawn> | undefined;
let dedicatedServerProcess: ReturnType<typeof spawn> | undefined;
let externalArmaRunning = false;
let externalDedicatedServerRunning = false;
let runningStatusPromise: Promise<boolean> | undefined;
let dedicatedServerStatusPromise: Promise<boolean> | undefined;
const processStatusErrors = new Set<string>();
let rptPoll: ReturnType<typeof setInterval> | undefined;
let rptFile = "";
let rptOffset = 0;
let rptPartial = "";
let rptErrorBlock: string[] = [];
let rptDiagnostics: vscode.DiagnosticCollection | undefined;
let rptReadInProgress = false;

export function setRptDiagnosticCollection(collection: vscode.DiagnosticCollection): void {
    rptDiagnostics = collection;
}

/**
 * One-click launch: prepares the DLL + mods, starts arma3_x64.exe with -mod= and waits for
 * the REST API to answer. This is what a developer uses every day.
 */
export async function launchArma(runtime: Runtime, settings: Settings, options: LaunchOptions = {}, silent = false): Promise<boolean> {
    // A manual pick only selects the folder for this launch; armaDirectory is not written.
    const armaDirectory = await findArmaDirectory(settings) ?? await pickArmaDirectory(settings);

    if (!armaDirectory) {
        log("launch: no Arma directory (findArmaDirectory returned nothing).");

        if (!silent) {
            vscode.window.showErrorMessage("Arma 3 was not found. Pick the folder once, or set \"armaDirectory\" in .vscode/sqfReloader-settings.json.");
        }

        return false;
    }

    const executable = path.join(
        armaDirectory,
        options.dedicatedServer ? "arma3server_x64.exe" : "arma3_x64.exe"
    );

    if (!fs.existsSync(executable)) {
        log(`launch: ${executable} does not exist.`);
        vscode.window.showErrorMessage(`${path.basename(executable)} not found in ${armaDirectory}.`);
        return false;
    }

    if (!options.dedicatedServer && await refreshRunningStatus()) {
        log("An Arma 3 instance is already running, so a new launch was skipped.");
        return false;
    }

    const hookContext: HookContext = {
        armaDirectory,
        apiUrl: settings.apiUrl,
        missionFolder: options.missionFolder?.directory,
        file: options.serverConfig
    };

    try {
        // Builds and other setup run first; a failing command keeps Arma from starting.
        if (options.dedicatedServer) {
            if (!await runHook("preServerLaunch", settings, hookContext)) return false;
        } else {
            if (!await runHook("preClientLaunch", settings, hookContext)) return false;
            if (options.hostMission && !await runHook("preHostMission", settings, hookContext)) return false;
        }

        // Probe before starting the game: once Arma runs, its own listener owns the port, so a
        // busy 8764 (EdenOnline, an older SqfReloader instance) has to be detected up front.
        // A dedicated launch writes the config too but must not probe, because a running client
        // already owns the port we are about to share with it.
        if (!options.dedicatedServer) {
            const port = await writeApiConfig(settings, true);
            if (port !== requestedApiPort(settings)) {
                vscode.window.setStatusBarMessage(`SqfReloader API moved to port ${port} (${requestedApiPort(settings)} is in use).`, 8000);
            }
        } else {
            await writeApiConfig(settings, false);
        }

        const workspaceModsFound = workspaceMods().filter(mod => modTypeForDirectory(mod.directory) !== "off");
        const disabledMods = workspaceMods().filter(mod => modTypeForDirectory(mod.directory) === "off");
        if (disabledMods.length > 0) {
            log(`Not passing these workspace mods to Arma (mod type "off"): ${disabledMods.map(mod => mod.directory).join(", ")}`);
        }
        const classifiedServerMods = workspaceModsFound.filter(mod => modTypeForDirectory(mod.directory) === "server");
        const clientAndSharedMods = workspaceModsFound.filter(mod => modTypeForDirectory(mod.directory) !== "server");
        // Link the sources before Arma starts. A real folder sitting on a mount path would
        // otherwise make Arma read a stale copy; the user is offered to move it aside.
        await createLinksWithRepair(armaDirectory, workspaceModsFound, settings, { silent });

        const additionalServerMods = (options.additionalModDirectories ?? []).flatMap(directory => findMods(directory));
        const serverMods = [...classifiedServerMods, ...additionalServerMods];
        const launch = prepareRuntime(runtime, armaDirectory, settings, clientAndSharedMods, serverMods);
        launch.executable = executable;

        // -mod= is the workspace mod folders plus the configured external mods. A folder that is
        // both (very common: the workspace folder is a copy of the one in the Arma directory)
        // used to be listed twice, e.g. "@APMS;...\@APMS", and Arma then loaded it twice.
        const clientAndSharedDirectories = clientAndSharedMods.map(mod => mod.directory);
        launch.mods = modFoldersOnce([
            ...clientAndSharedDirectories,
            ...launchModFolders(),
            launch.modPath
        ]);
        launch.serverMods = modFoldersOnce([
            ...launch.serverMods,
            ...launchServerModFolders()
        ]);

        if (options.missionFolder) {
            if (!await runHook("preMissionLink", settings, hookContext)) return false;
            const missionLinks = linkMissions(armaDirectory, launch.profile.directory, [options.missionFolder]);
            launch.warnings.push(...missionLinks.warnings);
            if (missionLinks.links.length === 0 && missionLinks.warnings.length > 0) {
                throw new Error(missionLinks.warnings[0]);
            }
            if (missionLinks.links.length > 0) {
                log(`Mission linked to Arma profile and installation: ${missionLinks.links.map(link => link.linkPath).join(", ")}`);
            }
            fireHook("postMissionLink", settings, hookContext);
        }

        const linkWarnings = verifyWorkspaceAddons(armaDirectory, workspaceAddons());
        launch.warnings.push(...linkWarnings);
        if (linkWarnings.length > 0 && !silent) {
            // The repair prompt was declined or failed; do not launch silently on a stale copy.
            void vscode.window.showWarningMessage(`Arma 3 SQF Reloader: ${linkWarnings[0]}`);
        }
        if (options.dedicatedServer && options.missionFolder) {
            const serverMissionPath = path.join(armaDirectory, "MPMissions", path.basename(options.missionFolder.directory));
            if (!fs.existsSync(path.join(serverMissionPath, "mission.sqm"))) {
                throw new Error(`Dedicated-server mission folder was not prepared at ${serverMissionPath}.`);
            }
        }

        for (const warning of launch.warnings) {
            log(`Warning: ${warning}`);
        }

        if (workspaceModsFound.length > 0) {
            log(`Mods: ${workspaceModsFound.map(mod => `${mod.name} (${modTypeForDirectory(mod.directory) ?? "unclassified"}) [${mod.addons.map(addon => addon.prefix).join(", ")}]`).join(" | ")}`);
        } else {
            log("No mod found in the workspace; launching with @SqfReloader only.");
        }

        log(`-mod= entries: ${launch.mods.join(" ; ")}`);
        if (launch.serverMods.length > 0) log(`-serverMod= entries: ${launch.serverMods.join(" ; ")}`);

        if (options.hostMission && options.missionFolder) {
            if (options.missionFolder.maxPlayers === undefined || options.missionFolder.maxPlayers <= 1) {
                throw new Error("Only missions with maxPlayers greater than 1 can be hosted. Add maxPlayers > 1 to description.ext.");
            }
            options.scenarioFile = path.join(options.missionFolder.directory, "mission.sqm");
        }

        const args = launchArguments(launch, settings, options);
        if (options.confirmLaunch) {
            const command = `"${launch.executable}" ${args.join(" ")}`;
            const choice = await vscode.window.showInformationMessage(
                "Review the dedicated-server launch command before starting.",
                { modal: true, detail: command },
                "Start Dedicated Server",
                "Cancel"
            );
            if (choice !== "Start Dedicated Server") return false;
        }

        startProcess(launch, settings, options, args);

        fireHook(options.dedicatedServer ? "postServerLaunch" : "postClientLaunch", settings, hookContext);
        if (options.hostMission) fireHook("postHostMission", settings, hookContext);

        return true;
    } catch (error) {
        logError("launch failed", error);
        log(`launch stack: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        vscode.window.showErrorMessage(`Arma 3 SQF Reloader: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Folder Arma writes its .rpt logs to: <c>%LOCALAPPDATA%\Arma 3</c> (single player profile).
 * Resolved at runtime because the output channel does not expand environment variables.
 */
export function armaLogDirectory(): string {    const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(require("os").homedir(), "AppData", "Local");

    return path.join(localAppData, "Arma 3");
}

function startProcess(launch: PreparedLaunch, settings: Settings, options: LaunchOptions, args = launchArguments(launch, settings, options)): void {

    const output = getOutput();
    const rawCommand = `"${launch.executable}" ${args.join(" ")}`;
    output.appendLine("--- Raw Arma launch command ---");
    output.appendLine(rawCommand);
    output.appendLine(`Raw argument vector: ${JSON.stringify(args)}`);
    output.appendLine(`Executable: ${launch.executable}`);
    output.appendLine(`Arguments (${args.length}):`);
    args.forEach((argument, index) => output.appendLine(`  [${index}] ${JSON.stringify(argument)}`));
    output.show(true);
    log(`Starting: ${rawCommand}`);

    // Arma is a native .exe, so the command line is assembled verbatim instead of letting Node
    // quote each argument: the complete "-mod=A;B" value must reach the game as one argument.
    const processHandle = spawn(launch.executable, args, {
        // Match the quoted argv[0] emitted by the working Arma Launcher command line.
        argv0: `"${launch.executable}"`,
        cwd: launch.armaDirectory,
        detached: false,
        stdio: "ignore",
        windowsVerbatimArguments: true
    });
    if (options.dedicatedServer) dedicatedServerProcess = processHandle;
    else armaProcess = processHandle;

    log(`Launched pid ${processHandle.pid ?? "?"}.`);
    startRptMonitor();

    processHandle.on("error", error => logError(`${path.basename(launch.executable)} could not be started`, error));
    processHandle.on("exit", (code, signal) => {
        log(`${path.basename(launch.executable)} exited (${signal ?? code ?? "?"}).`);
        if (options.dedicatedServer) dedicatedServerProcess = undefined;
        else {
            cleanupSnapshots(launch.armaDirectory);
            armaProcess = undefined;
        }
    });
}

/** Forward new SQF diagnostics for files mounted under z\\ into the VS Code output channel. */
export function startRptMonitor(): void {
    if (rptPoll) return;
    rptFile = "";
    rptOffset = 0;
    rptPartial = "";
    rptErrorBlock = [];
    rptPoll = setInterval(() => {
        if (rptReadInProgress) return;
        rptReadInProgress = true;
        void pollRptFile().catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                logError("could not read the Arma RPT file", error);
            }
        }).finally(() => {
            rptReadInProgress = false;
        });
    }, 1000);
    rptPoll.unref?.();
}

async function pollRptFile(): Promise<void> {
    const names = await fs.promises.readdir(armaLogDirectory());
    const files = await Promise.all(names
        .filter(name => /^arma3_x64_.*\.rpt$/i.test(name))
        .map(async name => {
            const file = path.join(armaLogDirectory(), name);
            try {
                const stat = await fs.promises.stat(file);
                return stat.isFile() ? { file, modified: stat.mtimeMs } : undefined;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                throw error;
            }
        }));
    const latest = files
        .filter((entry): entry is { file: string; modified: number } => !!entry)
        .sort((left, right) => right.modified - left.modified)[0]?.file;
    if (!latest) return;
    if (latest !== rptFile) {
        rptFile = latest;
        // Skip existing output so previous-session diagnostics are not replayed on activation.
        const stat = await fs.promises.stat(rptFile);
        rptOffset = stat.size;
        rptPartial = "";
        rptErrorBlock = [];
        return;
    }
    const stat = await fs.promises.stat(rptFile);
    if (stat.size < rptOffset) {
        rptOffset = stat.size;
        rptPartial = "";
        rptErrorBlock = [];
        return;
    }
    if (stat.size === rptOffset) return;
    const handle = await fs.promises.open(rptFile, "r");
    let buffer: Buffer;
    try {
        buffer = Buffer.alloc(stat.size - rptOffset);
        await handle.read(buffer, 0, buffer.length, rptOffset);
    } finally {
        await handle.close();
    }
    rptOffset = stat.size;
    const lines = (rptPartial + buffer.toString("utf8")).split(/\r?\n/);
    rptPartial = lines.pop() ?? "";
    for (const line of lines) consumeRptLine(line);
}

export function stopRptMonitor(): void {
    if (rptPoll) clearInterval(rptPoll);
    rptPoll = undefined;
}

function consumeRptLine(line: string): void {
    const openMissionResult = /\[SqfReloader OpenMission:([^\]]+)\]\s*(.*)/.exec(line);
    if (openMissionResult) {
        const resultText = openMissionResult[2].replace(/"\s*$/, "").trimEnd();
        if (resultText.toLowerCase() === "true") {
            log("[Arma] Mission opened in Eden.");
            void vscode.window.showInformationMessage("Mission opened in Eden.");
        } else {
            log("[Arma] Could not open the mission. Eden Editor must be active.");
            void vscode.window.showWarningMessage("Arma is running, but Eden Editor is not active. Return to Eden and try again.");
        }
        return;
    }

    if (/Invalid path \(only relative paths supported\)/i.test(line)) return;

    if (/\bError in expression\b/i.test(line)) {
        rptErrorBlock = [line];
        return;
    }

    if (rptErrorBlock.length === 0) return;
    rptErrorBlock.push(line);

    const sourceLine = /File\s+(.+?),\s*line\s+(\d+)/i.exec(line);
    if (sourceLine) {
        reportRptError(rptErrorBlock, sourceLine[1], Number(sourceLine[2]));
        rptErrorBlock = [];
    } else if (rptErrorBlock.length >= 24) {
        rptErrorBlock = [];
    }
}

function reportRptError(block: string[], reportedPath: string, lineNumber: number): void {
    const filePath = resolveWorkspaceSqfPath(reportedPath);
    if (!filePath) return;

    const positionText = block.map(line => /Error position:\s*(.*)/i.exec(line)?.[1]).find(Boolean);
    const messageText = block
        .map(line => /\bError\s+(?!in expression|position)(.+)/i.exec(line)?.[1])
        .find(Boolean) ?? "SQF compile error";
    const detail = `${messageText.replace(/\s+/g, " ").trim()}${positionText ? ` — position: ${positionText.replace(/\s+/g, " ").trim()}` : ""}`;
    log(`[Arma RPT] ${path.basename(filePath)}:${lineNumber}: ${detail}`);

    const diagnostics = rptDiagnostics;
    if (!diagnostics) return;
    const uri = vscode.Uri.file(filePath);
    const document = vscode.workspace.textDocuments.find(open => open.uri.fsPath.toLowerCase() === filePath.toLowerCase());
    const line = Math.max(0, lineNumber - 1);
    const character = document ? document.lineAt(Math.min(line, document.lineCount - 1)).range.end.character : 0;
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, character),
        `Arma: ${detail}`,
        vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = "Arma RPT";
    diagnostics.set(uri, [diagnostic]);
    void vscode.window.showErrorMessage(`[Arma RPT] ${path.basename(filePath)}:${lineNumber}: ${detail}`);
}

function resolveWorkspaceSqfPath(reportedPath: string): string | undefined {
    const normalized = reportedPath.replace(/^['"]|['"]$/g, "").replace(/\.\.\.$/, "").replace(/\//g, "\\").replace(/^\\+/, "");
    const lower = normalized.toLowerCase();

    for (const addon of workspaceAddons()) {
        const marker = `addons\\${addon.name.toLowerCase()}\\`;
        const markerIndex = lower.lastIndexOf(marker);
        if (markerIndex < 0) continue;
        const relative = normalized.slice(markerIndex + marker.length)
            .replace(/\.sqfreloader-\d+-\d+\.sqf$/i, ".sqf")
            .replace(/\\/g, path.sep);
        if (!/\.sqf$/i.test(relative)) continue;
        const candidate = path.resolve(addon.localDirectory, relative);
        if (fs.existsSync(candidate)) return candidate;
    }

    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    for (const mission of findMissions(roots)) {
        const marker = `missions\\${path.basename(mission.directory).toLowerCase()}\\`;
        const markerIndex = lower.lastIndexOf(marker);
        if (markerIndex < 0) continue;
        const relative = normalized.slice(markerIndex + marker.length)
            .replace(/\.sqfreloader-\d+-\d+\.sqf$/i, ".sqf")
            .replace(/\\/g, path.sep);
        if (!/\.sqf$/i.test(relative)) continue;
        const candidate = path.resolve(mission.directory, relative);
        const fromMission = path.relative(mission.directory, candidate);
        if (!fromMission.startsWith("..") && !path.isAbsolute(fromMission) && fs.existsSync(candidate)) return candidate;
    }

    return undefined;
}

/** Command line handed to arma3_x64.exe (also used by scripts/verify-launch-args.js). */
export function launchArguments(launch: PreparedLaunch, settings: Settings, options: LaunchOptions): string[] {
    // File patching is required twice: user mods are junctions to the working copy, and
    // @SqfReloader's replacement config must override the config inside scripts.pbo.
    const args: string[] = ["-filePatching"];

    if (options.dedicatedServer) {
        args.push("-autoInit");
    }

    if (options.hostMission) {
        args.push("-host");
    }

    if (options.dedicatedServer && options.serverConfig) {
        const config = options.serverConfig.replace(/"/g, "\\\"");
        args.push(`-config="${config}"`);
    }

    const serverExtraArguments = options.dedicatedServer
        ? parseExtraArguments(projectSetting("serverLaunchArguments", ""))
        : [];
    const extra = [...(options.extraArguments ?? parseExtraArguments(settings.extraLaunchArguments)), ...serverExtraArguments];
    const launchExtras = settings.armaProfile?.trim() ? withoutProfileName(extra) : extra;

    // BattlEye cannot load unsigned extensions, so it is off unless the user asks for it.
    if (!launchExtras.some(argument => /^-(no)?be$/i.test(argument))) {
        args.push("-noBattlEye");
    }

    if (launchExtras.length > 0) {
        args.push(...launchExtras);
    }

    // When profile auto-detection picked a named profile, explicitly launch that same profile.
    // Otherwise Arma would default to Documents\Arma 3 while the mission junction targets the
    // detected Documents\Arma 3 - Other Profiles\<name> folder.
    if (launch.profile.launchName && !launchExtras.some(argument => /^-name(?:=|$)/i.test(argument))) {
        const profileName = launch.profile.launchName.replace(/"/g, "\\\"");
        args.push(/\s/.test(profileName) ? `-name="${profileName}"` : `-name=${profileName}`);
    }

    // Arma parses a bare mission.sqm argument as the editor startup scenario. Keep it after
    // profile and gameplay options, matching the working launcher command line; add its
    // memory-load switch after the path, then put -mod last as in the known-good invocation.
    if (options.scenarioFile) {
        const scenarioFile = options.scenarioFile.replace(/"/g, "\\\"");
        args.push(/\s/.test(scenarioFile) ? `"${scenarioFile}"` : scenarioFile);
        args.push("-loadMissionToMemory");
    }

    if (options.hostMission && options.missionFolder) {
        args.push(`-mission=${path.basename(options.missionFolder.directory)}.pbo`);
    }

    // Arma expects the whole -mod value quoted as one argument, with semicolons separating
    // paths inside it. Quoting each path separately makes Arma ignore the startup scenario.
    const mods = launch.mods;
    if (mods.length > 0) {
        args.push(`"-mod=${mods.map(uppercaseDriveLetter).join(";")}"`);
    }

    const serverMods = launch.serverMods;
    if (options.dedicatedServer && serverMods.length > 0) {
        args.push(`"-serverMod=${serverMods.map(uppercaseDriveLetter).join(";")}"`);
    }

    if (options.mission) {
        args.push(`-mission=${options.mission}`);
    }

    return args;
}

function uppercaseDriveLetter(value: string): string {
    return value.replace(/^([a-z]):/i, (_match, drive: string) => `${drive.toUpperCase()}:`);
}


function withoutProfileName(argumentsList: string[]): string[] {
    const result: string[] = [];
    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (/^-name$/i.test(argument)) {
            if (index + 1 < argumentsList.length) index++;
            continue;
        }
        if (/^-name=/i.test(argument)) continue;
        result.push(argument);
    }
    return result;
}

function parseExtraArguments(value: string): string[] {
    const argumentsList: string[] = [];
    let current = "";
    let quote: "\"" | "'" | undefined;

    for (const character of value) {
        if (quote) {
            current += character;
            if (character === quote) quote = undefined;
        } else if (character === "\"" || character === "'") {
            quote = character;
            current += character;
        } else if (/\s/.test(character)) {
            if (current) argumentsList.push(current);
            current = "";
        } else {
            current += character;
        }
    }

    if (current) argumentsList.push(current);
    return argumentsList;
}

export function isRunning(): boolean {
    if (armaProcess && !armaProcess.killed) {
        return true;
    }

    return externalArmaRunning;
}

export function refreshRunningStatus(): Promise<boolean> {
    if (armaProcess && !armaProcess.killed) return Promise.resolve(true);
    if (process.platform !== "win32") return Promise.resolve(false);
    if (runningStatusPromise) return runningStatusPromise;

    runningStatusPromise = new Promise(resolve => {
        void queryProcessImage("arma3_x64.exe").then(running => {
            externalArmaRunning = running;
            runningStatusPromise = undefined;
            resolve(externalArmaRunning);
        }, error => {
            reportProcessStatusError("arma3_x64.exe", "could not check whether Arma 3 is running", error);
            runningStatusPromise = undefined;
            resolve(externalArmaRunning);
        });
    });
    return runningStatusPromise;
}

export function refreshDedicatedServerStatus(): Promise<boolean> {
    if (dedicatedServerProcess && !dedicatedServerProcess.killed) return Promise.resolve(true);
    if (process.platform !== "win32") return Promise.resolve(false);
    if (dedicatedServerStatusPromise) return dedicatedServerStatusPromise;

    dedicatedServerStatusPromise = new Promise(resolve => {
        void queryProcessImage("arma3server_x64.exe").then(running => {
            externalDedicatedServerRunning = running;
            dedicatedServerStatusPromise = undefined;
            resolve(externalDedicatedServerRunning);
        }, error => {
            reportProcessStatusError("arma3server_x64.exe", "could not check whether the dedicated server is running", error);
            dedicatedServerStatusPromise = undefined;
            resolve(externalDedicatedServerRunning);
        });
    });
    return dedicatedServerStatusPromise;
}

function queryProcessImage(imageName: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        execFile("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], { timeout: 2000 }, (error, stdout, stderr) => {
            if (!error) {
                processStatusErrors.delete(imageName);
                resolve(stdout.toLowerCase().includes(imageName.toLowerCase()));
                return;
            }

            const tasklistError = [error.message, stderr?.trim()].filter(Boolean).join("\n");
            const processName = imageName.replace(/\.exe$/i, "");
            const command = `(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName) -join '\n'`;
            execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 3000 }, (fallbackError, fallbackStdout, fallbackStderr) => {
                if (!fallbackError) {
                    processStatusErrors.delete(imageName);
                    resolve(fallbackStdout.toLowerCase().includes(processName.toLowerCase()));
                    return;
                }

                reject(new Error(
                    `tasklist failed: ${tasklistError}; PowerShell fallback failed: ${fallbackError.message}${fallbackStderr ? ` (${fallbackStderr.trim()})` : ""}`
                ));
            });
        });
    });
}

function reportProcessStatusError(imageName: string, message: string, error: unknown): void {
    if (processStatusErrors.has(imageName)) return;
    processStatusErrors.add(imageName);
    logError(message, error);
}

export async function stopDedicatedServer(): Promise<boolean> {
    // A handle that outlived its process would otherwise make kill() look like success.
    if (dedicatedServerProcess && (dedicatedServerProcess.killed || dedicatedServerProcess.exitCode !== null)) {
        dedicatedServerProcess = undefined;
        externalDedicatedServerRunning = false;
    }

    if (dedicatedServerProcess && !dedicatedServerProcess.killed) {
        const processHandle = dedicatedServerProcess;
        const stopped = await new Promise<boolean>(resolve => {
            const timeout = setTimeout(() => resolve(false), 2000);
            processHandle.once("exit", () => {
                clearTimeout(timeout);
                resolve(true);
            });
            processHandle.kill();
            timeout.unref();
        });
        if (stopped) {
            dedicatedServerProcess = undefined;
            externalDedicatedServerRunning = false;
            return true;
        }
    }

    if (process.platform !== "win32") return false;
    await new Promise<void>((resolve, reject) => {
        execFile("taskkill", ["/IM", "arma3server_x64.exe", "/F"], { timeout: 5000 }, error => {
            if (error && (error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
            else resolve();
        });
    });
    externalDedicatedServerRunning = false;
    return true;
}

/**
 * Ensures the user's addons are linked before Arma starts. Called when the game is already
 * running (editing a script triggers this through the save handler).
 */
export function ensureAddonLinks(armaDirectory: string, settings: Settings): string[] {
    const mods = workspaceMods();
    const addons = workspaceAddons();

    if (mods.length === 0) {
        return ["No mod addons found in this workspace. Add an addon folder with config.cpp or functions/."];
    }

    const { warnings } = createLinks(armaDirectory, mods, settings.junctionMode);
    return [...warnings, ...verifyWorkspaceAddons(armaDirectory, addons)];
}

/** Arma path of a file inside one of the workspace addons, for log messages. */
export function workspaceArmaPath(filePath: string): string | undefined {
    for (const addon of workspaceAddons()) {
        const relative = path.relative(addon.localDirectory, filePath);

        if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
            return toArmaPath(addon, filePath);
        }
    }

    return undefined;
}
