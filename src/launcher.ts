import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { execFile, spawn } from "child_process";
import { findArmaDirectory, findMissions, findMods, pickArmaDirectory, toArmaPath } from "./arma";
import { getOutput, log, logError, Settings } from "./settings";
import { PreparedLaunch, prepareRuntime, Runtime, verifyWorkspaceAddons, workspaceAddons, workspaceMods, writeApiConfig } from "./runtime";
import { createLinks, linkMissions, reconcileLinks } from "./junctions";
import { createLinksWithRepair } from "./linkRepair";
import { cleanupSnapshots } from "./reload";
import { parseApiUrl } from "./ports";
import { modLaunchesInArma, modTypeForDirectory } from "./modTypes";
import { launchModFolders, launchServerModFolders, modFoldersOnce } from "./launchMods";
import { fireHook, HookContext, runHook } from "./hooks";
import { buildWorkspaceAddonPbos } from "./pbo";
import { blockedDllWarning } from "./dllIntegrity";
import { armaLogDirectory } from "./rpt";
import { formatLaunchArgument, launchArguments } from "./launchArgs";
import type { LaunchOptions } from "./launchArgs";

// Re-exported because scripts/verify-launch-args.js requires them from this module.
export { launchArguments } from "./launchArgs";
export type { LaunchOptions } from "./launchArgs";

/** Port the resolved project API URL requests, before any fallback is applied. */
function requestedApiPort(settings: Settings): number {
    return parseApiUrl(settings.apiUrl).port;
}

let armaProcess: StartedGame | undefined;
let dedicatedServerProcess: StartedGame | undefined;
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
let rptLaunchStartedAt = 0;
let rptPathLoggedForLaunch = false;
let rptDiagnostics: vscode.DiagnosticCollection | undefined;
let rptReadInProgress = false;
/** Set after a launch reported a blocked DLL, so the same warning is not shown on every launch. */
let reportedDllPolicyWarning = false;

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

        const discoveredMods = workspaceMods();
        const workspaceModsFound = discoveredMods.filter(mod => modLaunchesInArma(mod.directory));
        const skippedMods = discoveredMods.filter(mod => !modLaunchesInArma(mod.directory));
        if (skippedMods.length > 0) {
            log(`Not passing these workspace mods to Arma (role "off" or no role saved in modTypes): ${skippedMods.map(mod => mod.directory).join(", ")}`);
        }
        const classifiedServerMods = workspaceModsFound.filter(mod => modTypeForDirectory(mod.directory) === "server");
        const clientMods = workspaceModsFound.filter(mod => modTypeForDirectory(mod.directory) !== "server");
        const additionalServerMods = (options.additionalModDirectories ?? []).flatMap(directory => findMods(directory));
        if (!await buildWorkspaceAddonPbos([...workspaceModsFound, ...additionalServerMods])) return false;
        // Link the sources before Arma starts. A real folder sitting on a mount path would
        // otherwise make Arma read a stale copy; the user is offered to move it aside.
        reconcileLinks(armaDirectory, workspaceModsFound, settings.junctionMode);
        await createLinksWithRepair(armaDirectory, workspaceModsFound, settings, { silent });

        const serverMods = [...classifiedServerMods, ...additionalServerMods];
        const launch = prepareRuntime(runtime, armaDirectory, settings, clientMods, serverMods);
        launch.executable = executable;

        // Smart App Control refuses the unsigned DLL, so Arma starts without SqfReloader and the
        // status bar would wait for a callback that can never arrive. Say what happened instead.
        const policyWarning = await blockedDllWarning(path.join(launch.modPath, "SqfReloader_x64.dll"));
        if (policyWarning) {
            launch.warnings.push(policyWarning.message);
            for (const line of policyWarning.detail) log(line);
            reportDllPolicyWarning(policyWarning.message, silent);
        }

        // -mod= is the workspace mod folders plus the configured external mods. A folder that is
        // both (very common: the workspace folder is a copy of the one in the Arma directory)
        // used to be listed twice, e.g. "@APMS;...\@APMS", and Arma then loaded it twice.
        const clientDirectories = clientMods.map(mod => mod.directory);
        launch.mods = modFoldersOnce([
            ...clientDirectories,
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
            if (missionLinks.links.length > 0) {
                log(`Mission linked to Arma profile and installation: ${missionLinks.links.map(link => link.linkPath).join(", ")}`);
            } else if (missionLinks.warnings.length > 0) {
                // A mission that cannot be linked is a warning, not a reason to keep the game
                // closed: the mod still launches and the mission can be opened from the editor.
                log(`Warning: the mission folder could not be linked: ${missionLinks.warnings[0]}`);
                if (!silent) {
                    void vscode.window.showWarningMessage(
                        `Arma 3 will start, but the mission folder could not be linked into the Arma profile: ${missionLinks.warnings[0]}`,
                        "Show output"
                    ).then(choice => { if (choice === "Show output") getOutput().show(true); });
                }
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
                // Same rule as the client mission link: report and keep going.
                const message = `Dedicated-server mission folder was not prepared at ${serverMissionPath}; the server starts without it.`;
                launch.warnings.push(message);
                log(`Warning: ${message}`);
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

        if (!options.dedicatedServer && !await ensureSteamReady(silent)) {
            return false;
        }

        await startProcess(launch, settings, options, args);

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
 * Reports a DLL that a code-integrity policy refuses to load. Shown once per session: the fix is a
 * Windows setting, so repeating it on every launch would only be noise.
 */
function reportDllPolicyWarning(message: string, silent: boolean): void {
    if (silent || reportedDllPolicyWarning) return;
    reportedDllPolicyWarning = true;

    void vscode.window.showWarningMessage(message, "Open Windows Security", "Show output").then(choice => {
        if (choice === "Open Windows Security") {
            // The App & browser control page, where every Smart App Control setting lives.
            void vscode.env.openExternal(vscode.Uri.parse("windowsdefender://appbrowsercontrol")).then(
                undefined,
                error => logError("could not open Windows Security", error)
            );
        } else if (choice === "Show output") {
            getOutput().show(true);
        }
    });
}

async function ensureSteamReady(silent: boolean): Promise<boolean> {
    if (await queryProcessImage("steam.exe")) {
        log("Steam is running.");
        return true;
    }

    log("Steam is not running.");
    if (silent) return false;

    const choice = await vscode.window.showInformationMessage(
        "Steam is not running. Start Steam before launching Arma 3?",
        "Start Steam",
        "Cancel"
    );
    if (choice !== "Start Steam") return false;

    void vscode.window.showInformationMessage("Steam is starting... Please wait.");

    const executable = await findSteamExecutable();
    if (!executable) {
        throw new Error("Steam.exe was not found. Start Steam manually, then launch Arma 3 again.");
    }

    await startSteam(executable);
    if (!await waitForSteam()) {
        throw new Error("Steam did not start within 2 minutes. Start Steam manually, then launch Arma 3 again.");
    }

    log("Steam is running. Waiting for the user to confirm sign-in before launching Arma.");
    const ready = await vscode.window.showInformationMessage(
        "Steam is running. Sign in to Steam if needed, then continue to launch Arma 3.",
        "Continue",
        "Cancel"
    );
    if (ready !== "Continue") return false;

    await new Promise(resolve => setTimeout(resolve, 3000));
    if (!await queryProcessImage("steam.exe")) {
        throw new Error("Steam closed before Arma 3 could be launched. Start Steam and try again.");
    }
    return true;
}

async function findSteamExecutable(): Promise<string | undefined> {
    if (process.platform !== "win32") return undefined;

    let installPath: string | undefined;
    try {
        const output = await new Promise<string>((resolve, reject) => {
            execFile("reg", ["query", "HKCU\\SOFTWARE\\Valve\\Steam", "/v", "SteamPath"], {
                encoding: "utf8",
                timeout: 1500
            }, (error, stdout) => error ? reject(error) : resolve(stdout));
        });
        installPath = /REG_SZ\s+(.+)$/m.exec(output)?.[1].trim().replace(/\//g, "\\");
    } catch {
        // Steam's per-user registry key may be absent.
    }

    const candidates = [
        ...(installPath ? [path.join(installPath, "steam.exe")] : []),
        "C:\\Program Files (x86)\\Steam\\steam.exe",
        "C:\\Program Files\\Steam\\steam.exe"
    ];
    return candidates.find(candidate => fs.existsSync(candidate));
}

function startSteam(executable: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let started = false;
        const processHandle = spawn(executable, [], {
            detached: true,
            stdio: "ignore"
        });
        processHandle.on("error", error => {
            logError("Steam could not be started", error);
            if (!started) reject(error);
        });
        processHandle.once("spawn", () => {
            started = true;
            processHandle.unref();
            log(`Started Steam from ${executable}.`);
            resolve();
        });
    });
}

async function waitForSteam(): Promise<boolean> {
    const deadline = Date.now() + 2 * 60 * 1000;
    while (Date.now() < deadline) {
        if (await queryProcessImage("steam.exe")) return true;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
}

/**
 * Folder Arma writes its .rpt logs to: <c>%LOCALAPPDATA%\Arma 3</c> (single player profile).
 * Resolved at runtime because the output channel does not expand environment variables.
 */
/**
 * A game process this window started.
 *
 * Arma is created by the WMI provider (see {@link startProcessOutsideTree}), so it is not a child
 * of the extension host and only its PID is known. The `handle` is set when the launch had to
 * fall back to a plain child process.
 */
interface StartedGame {
    pid?: number;
    handle?: ReturnType<typeof spawn>;
    /** Set once the process was seen running, so a startup race cannot forget it too early. */
    confirmed?: boolean;
}

function startProcess(launch: PreparedLaunch, settings: Settings, options: LaunchOptions, args = launchArguments(launch, settings, options)): Promise<void> {
    const output = getOutput();
    const rawCommand = `"${launch.executable}" ${args.join(" ")}`;
    output.appendLine(`Arma directory: ${pathToFileURL(launch.armaDirectory).href}`);
    output.appendLine(`Executable: ${pathToFileURL(launch.executable).href}`);
    output.appendLine(`Arguments (${args.length}):`);
    args.forEach((argument, index) => {
        const [firstLine, ...continuationLines] = formatLaunchArgument(argument);
        output.appendLine(`  [${index}] ${firstLine}`);
        continuationLines.forEach(line => output.appendLine(line));
    });
    output.show(true);
    log(`Starting: ${rawCommand}`);

    rptLaunchStartedAt = Date.now();
    rptPathLoggedForLaunch = false;
    return startGameProcess(launch, options, args);
}

/**
 * Starts the game so a VS Code window reload keeps it running.
 *
 * VS Code terminates the extension host together with its child processes (a `taskkill /T`-style
 * tree kill), which used to close Arma whenever the window reloaded. A process created by the WMI
 * provider is not a descendant of VS Code, so it survives; `detached: true` does not help because
 * the process stays in the tree. When the WMI call is unavailable the launch falls back to a
 * child process, which still works but closes with the window.
 */
async function startGameProcess(launch: PreparedLaunch, options: LaunchOptions, args: string[]): Promise<void> {
    const started: StartedGame = {};

    const outOfTreePid = await startProcessOutsideTree(launch.executable, args, launch.armaDirectory);
    if (outOfTreePid !== undefined) {
        started.pid = outOfTreePid;
    } else {
        log("Could not create the Arma process outside the VS Code process tree; starting it as a child process (it closes when the VS Code window reloads).");
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
        started.handle = processHandle;
        started.pid = processHandle.pid;

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

    if (options.dedicatedServer) dedicatedServerProcess = started;
    else armaProcess = started;

    log(`Launched pid ${started.pid ?? "?"}.`);
    startedGameListener?.(options.dedicatedServer === true ? "server" : "client", started.pid);
    startRptMonitor();
}

/** Told about every game process this window starts, so the PID can survive an extension restart. */
let startedGameListener: ((kind: "client" | "server", pid: number | undefined) => void) | undefined;

export function setStartedGameListener(listener: (kind: "client" | "server", pid: number | undefined) => void): void {
    startedGameListener = listener;
}

/**
 * Creates a process with `Win32_Process.Create`, which runs it from the WMI provider instead of from
 * this extension host, and returns its PID.
 *
 * This is how the game is started: a child process is part of the extension host's process tree and
 * is killed by VS Code when the window reloads, a WMI-created one is not. The command line is passed
 * through base64 so neither quotes in `-mod=` paths nor argument separators reach a shell.
 *
 * Exported for `scripts/verify-detached-launch.js`, which checks the survival property with a fake
 * game executable.
 */
export function startProcessOutsideTree(executable: string, args: string[], workingDirectory: string): Promise<number | undefined> {
    if (process.platform !== "win32") return Promise.resolve(undefined);

    const commandLine = `"${executable}" ${args.join(" ")}`;
    const script = [
        "$ErrorActionPreference='Stop'",
        `$commandLine=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Text(commandLine)}'))`,
        `$workingDirectory=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Text(workingDirectory)}'))`,
        "$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine; CurrentDirectory=$workingDirectory}",
        "$createdPid=[int]$result.ProcessId",
        "if ($createdPid -le 0) { throw \"Win32_Process.Create returned $($result.ReturnValue)\" }",
        "Write-Output $createdPid"
    ].join("; ");

    return new Promise(resolve => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
            { timeout: 20000 },
            (error, stdout, stderr) => {
                if (error) {
                    logError("could not create the Arma process through WMI", new Error([error.message, stderr?.trim()].filter(Boolean).join("\n")));
                    resolve(undefined);
                    return;
                }

                const created = Number.parseInt(stdout.trim(), 10);
                if (!Number.isFinite(created) || created <= 0) {
                    log(`Win32_Process.Create returned no PID (${stdout.trim() || stderr?.trim() || "no output"}).`);
                    resolve(undefined);
                    return;
                }

                resolve(created);
            }
        );
    });
}

function base64Text(text: string): string {
    return Buffer.from(text, "utf8").toString("base64");
}

/** Liveness of the game process, whether it is our child or was created by the WMI provider. */
function isStartedGameRunning(started: StartedGame): boolean {
    if (started.handle) return !started.handle.killed && started.handle.exitCode === null;
    if (started.pid === undefined) return false;
    if (!processIsRunning(started.pid)) return false;

    started.confirmed = true;
    return true;
}

/** `kill(pid, 0)` only tests whether the PID exists; nothing is signalled. */
function processIsRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
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
        .filter(name => /^arma3(?:server)?_x64_.*\.rpt$/i.test(name))
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
        reportRptPath(rptFile, stat.mtimeMs);
        rptOffset = stat.size;
        rptPartial = "";
        rptErrorBlock = [];
        return;
    }
    const stat = await fs.promises.stat(rptFile);
    reportRptPath(rptFile, stat.mtimeMs);
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

function reportRptPath(file: string, modified: number): void {
    if (rptLaunchStartedAt === 0 || rptPathLoggedForLaunch || modified < rptLaunchStartedAt) return;
    getOutput().appendLine(`\nRPT: ${pathToFileURL(file).href}`);
    rptPathLoggedForLaunch = true;
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

export function isRunning(): boolean {
    if (armaProcess && isStartedGameRunning(armaProcess)) {
        return true;
    }

    return externalArmaRunning;
}

/** PID of the Arma 3 process this VS Code window started, if it is still running. */
export function trackedArmaPid(): number | undefined {
    if (!armaProcess || !isStartedGameRunning(armaProcess)) return undefined;
    return armaProcess.pid;
}

export interface StopArmaResult {
    ok: boolean;
    /** `tracked`: our own process tree was terminated; `external`: an outside session was closed. */
    method: "tracked" | "external" | "none";
    error?: string;
}

/**
 * Closes Arma 3 without touching sessions the user started elsewhere.
 *
 * The process started by `launchArma` is targeted by PID (`/T` closes its children too). The
 * image-name kill is only used when the caller explicitly allows it, which the command does after
 * telling the user that the instance was not started by VS Code.
 */
export async function stopArma(options: { allowExternal?: boolean } = {}): Promise<StopArmaResult> {
    const pid = trackedArmaPid();

    if (pid !== undefined && await processMatchesImage(pid, "arma3_x64.exe")) {
        const stopped = await killProcessTree(armaProcess?.handle, pid);
        if (stopped) {
            armaProcess = undefined;
            externalArmaRunning = false;
            return { ok: true, method: "tracked" };
        }

        const error = `taskkill /PID ${pid} /T /F failed.`;
        logError("could not close Arma 3", new Error(error));
        return { ok: false, method: "tracked", error };
    }

    if (process.platform !== "win32") return { ok: false, method: "none", error: "Windows only." };
    if (!externalArmaRunning) return { ok: false, method: "none", error: "No Arma 3 process was found." };

    if (!options.allowExternal) {
        return { ok: false, method: "none", error: "Arma 3 was not started by VS Code." };
    }

    try {
        await execFileAsync("taskkill", ["/IM", "arma3_x64.exe", "/F"]);
        externalArmaRunning = false;
        return { ok: true, method: "external" };
    } catch (error) {
        logError("could not close Arma 3", error);
        return { ok: false, method: "external", error: error instanceof Error ? error.message : String(error) };
    }
}

/** Terminates one process and its children, resolving true once it is gone. */
async function killProcessTree(handle: ReturnType<typeof spawn> | undefined, pid: number | undefined): Promise<boolean> {
    if (pid !== undefined && process.platform === "win32") {
        try {
            await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
            return true;
        } catch {
            // The process may have exited between the check and the call; the handle decides.
        }
    }

    if (handle && !handle.killed) {
        handle.kill();
        return true;
    }

    return false;
}

function execFileAsync(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 5000 }, (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ESRCH") {
                reject(new Error([error.message, stderr?.trim()].filter(Boolean).join("\n")));
                return;
            }
            resolve(stdout);
        });
    });
}

export function refreshRunningStatus(): Promise<boolean> {
    // A child process reports its own exit; a WMI-created game only has a PID, so the process
    // list decides and a stale record is dropped as soon as the game is gone.
    if (armaProcess?.handle && isStartedGameRunning(armaProcess)) return Promise.resolve(true);
    if (process.platform !== "win32") return Promise.resolve(false);
    if (runningStatusPromise) return runningStatusPromise;

    runningStatusPromise = new Promise(resolve => {
        void queryProcessImage("arma3_x64.exe").then(running => {
            if (!running && armaProcess?.confirmed) armaProcess = undefined;
            if (running && armaProcess) armaProcess.confirmed = true;
            externalArmaRunning = running;
            runningStatusPromise = undefined;
            resolve(armaProcess !== undefined || running);
        }, error => {
            reportProcessStatusError("arma3_x64.exe", "could not check whether Arma 3 is running", error);
            runningStatusPromise = undefined;
            resolve(armaProcess !== undefined || externalArmaRunning);
        });
    });
    return runningStatusPromise;
}

export function refreshDedicatedServerStatus(): Promise<boolean> {
    if (dedicatedServerProcess?.handle && isStartedGameRunning(dedicatedServerProcess)) return Promise.resolve(true);
    if (process.platform !== "win32") return Promise.resolve(false);
    if (dedicatedServerStatusPromise) return dedicatedServerStatusPromise;

    dedicatedServerStatusPromise = new Promise(resolve => {
        void queryProcessImage("arma3server_x64.exe").then(running => {
            if (!running && dedicatedServerProcess?.confirmed) dedicatedServerProcess = undefined;
            if (running && dedicatedServerProcess) dedicatedServerProcess.confirmed = true;
            externalDedicatedServerRunning = running;
            dedicatedServerStatusPromise = undefined;
            resolve(dedicatedServerProcess !== undefined || running);
        }, error => {
            reportProcessStatusError("arma3server_x64.exe", "could not check whether the dedicated server is running", error);
            dedicatedServerStatusPromise = undefined;
            resolve(dedicatedServerProcess !== undefined || externalDedicatedServerRunning);
        });
    });
    return dedicatedServerStatusPromise;
}

/**
 * Adopts the game this window started before the extension host restarted.
 *
 * The window's state survives a reload, the launcher's memory does not: without this, "Stop Arma 3"
 * would offer to close "an instance that was not started by VS Code" after **Reload Window**.
 * A PID that is no longer the game is dropped by the next status check.
 */
export function adoptTrackedArmaPid(pid: number | undefined): void {
    if (pid === undefined || armaProcess) return;
    armaProcess = { pid, confirmed: true };
}

/** Same as {@link adoptTrackedArmaPid}, for the dedicated server. */
export function adoptTrackedServerPid(pid: number | undefined): void {
    if (pid === undefined || dedicatedServerProcess) return;
    dedicatedServerProcess = { pid, confirmed: true };
}

/**
 * True when the PID currently belongs to `imageName`, so a reused PID is never killed. */function processMatchesImage(pid: number, imageName: string): Promise<boolean> {
    if (process.platform !== "win32") return Promise.resolve(false);

    return new Promise(resolve => {
        execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 2000 }, (error, stdout) => {
            if (error) {
                // Cannot verify: assume the tracked process, because it was launched from here.
                resolve(true);
                return;
            }

            resolve(stdout.toLowerCase().includes(imageName.toLowerCase()));
        });
    });
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
    // A record that outlived its process would otherwise make the kill look like success.
    if (dedicatedServerProcess && !isStartedGameRunning(dedicatedServerProcess)) {
        dedicatedServerProcess = undefined;
        externalDedicatedServerRunning = false;
    }

    if (dedicatedServerProcess) {
        const stopped = await killProcessTree(dedicatedServerProcess.handle, dedicatedServerProcess.pid);
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
