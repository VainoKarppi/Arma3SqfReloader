import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { findArmaDirectory, pickArmaDirectory, toArmaPath } from "./arma";
import { getStatus } from "./api";
import { log, logError, readSettings, Settings, updateSetting } from "./settings";
import { PreparedLaunch, prepareRuntime, Runtime, verifyWorkspaceAddons, workspaceAddons, workspaceMods, writeApiConfig } from "./runtime";
import { createLinks } from "./junctions";

export interface LaunchOptions {
    /** Extra launch parameters, e.g. "-window -noSplash". */
    extraArguments?: string[];
    /** Maps/missions to open after starting (passed as -mission/-worldPosition). */
    mission?: string;
}

let armaProcess: ReturnType<typeof spawn> | undefined;

/**
 * One-click launch: prepares the DLL + mods, starts arma3_x64.exe with -mod= and waits for
 * the REST API to answer. This is what a developer uses every day.
 */
export async function launchArma(runtime: Runtime, settings: Settings, options: LaunchOptions = {}, silent = false): Promise<boolean> {
    const armaDirectory = await findArmaDirectory(settings) ?? await pickArmaDirectory(settings);

    if (!armaDirectory) {
        log("launch: no Arma directory (findArmaDirectory returned nothing).");

        if (!silent) {
            vscode.window.showErrorMessage("Arma 3 was not found. Pick the folder once: \"sqfReloader.armaDirectory\".");
        }

        return false;
    }

    if (settings.armaDirectory !== armaDirectory) {
        await updateSetting("armaDirectory", armaDirectory);
    }

    const executable = path.join(armaDirectory, "arma3_x64.exe");

    if (!fs.existsSync(executable)) {
        log(`launch: ${executable} does not exist.`);
        vscode.window.showErrorMessage(`arma3_x64.exe not found in ${armaDirectory}.`);
        return false;
    }

    if (isRunning()) {
        log("An Arma 3 instance is already running, so a new launch was skipped.");
        return false;
    }

    try {
        writeApiConfig(settings);

        const mods = workspaceMods();
        const launch = prepareRuntime(runtime, armaDirectory, settings, mods);

        const linkWarnings = verifyWorkspaceAddons(armaDirectory, workspaceAddons());
        launch.warnings.push(...linkWarnings);

        for (const warning of launch.warnings) {
            log(`Warning: ${warning}`);
        }

        if (mods.length > 0) {
            log(`Mods: ${mods.map(mod => `${mod.name} [${mod.addons.map(addon => addon.prefix).join(", ")}]`).join(" | ")}`);
        } else {
            log("No mod found in the workspace; launching with @SqfReloader only.");
        }

        startProcess(launch, settings, options);

        // Wait for the API so the first save is not lost.
        const ready = await waitForApi(settings, 60000);

        if (ready) {
            log("SqfReloader is online; saving SQF now recompiles it in the running game.");
        } else {
            log(`SqfReloader did not answer within 60 s. Check the Arma log (${armaLogHint()}) and the extension output.`);
        }

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
export function armaLogDirectory(): string {
    const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(require("os").homedir(), "AppData", "Local");

    return path.join(localAppData, "Arma 3");
}

/** Path hint used in log messages: <c>...\Arma 3\arma3_x64_*.rpt</c>. */
function armaLogHint(): string {
    return path.join(armaLogDirectory(), "arma3_x64_*.rpt");
}

function startProcess(launch: PreparedLaunch, settings: Settings, options: LaunchOptions): void {
    const args = launchArguments(launch, settings, options);

    log(`Starting: "${launch.executable}" ${args.join(" ")}`);

    // Arma is a native .exe, so the command line is assembled verbatim instead of letting Node
    // quote each argument: -mod="A";"B" must reach the game unchanged. Arma splits -mod on ';',
    // so the quotes matter (paths may contain spaces).
    armaProcess = spawn(launch.executable, args, {
        cwd: launch.armaDirectory,
        detached: false,
        stdio: "ignore",
        windowsVerbatimArguments: true
    });

    log(`Launched pid ${armaProcess.pid ?? "?"}.`);

    armaProcess.on("error", error => logError("arma3_x64.exe could not be started", error));
    armaProcess.on("exit", (code, signal) => {
        log(`Arma 3 exited (${signal ?? code ?? "?"}).`);
        armaProcess = undefined;
    });
}

/** Command line handed to arma3_x64.exe (also used by scripts/verify-launch-args.js). */
export function launchArguments(launch: PreparedLaunch, settings: Settings, options: LaunchOptions): string[] {
    // File patching is required twice: user mods are junctions to the working copy, and
    // @SqfReloader's replacement config must override the config inside scripts.pbo.
    const args: string[] = ["-filePatching"];

    // -mod entries are separated by ';' (each entry may be quoted).
    if (launch.mods.length > 0) {
        args.push(`-mod=${launch.mods.map(folder => `"${folder}"`).join(";")}`);
    }

    // No -init=: @SqfReloader starts itself from its own Cfg3DEN >> EventHandlers >> init (Eden
    // Editor, including Play from the main menu) and from Cfg3DEN onMissionNew/onMissionLoad.
    // Missions started outside Eden get SqfReloader through "SqfReloader: Check connection" or the
    // SqfReloader >> StartupCode hook in description.ext.

    const extra = options.extraArguments ?? parseExtraArguments(settings.extraLaunchArguments);

    // BattlEye cannot load unsigned extensions, so it is off unless the user asks for it.
    if (!extra.some(argument => /^-(no)?be$/i.test(argument))) {
        args.push("-noBattlEye");
    }

    if (extra.length > 0) {
        args.push(...extra);
    }

    if (options.mission) {
        args.push(`-mission=${options.mission}`);
    }

    return args;
}

function parseExtraArguments(value: string): string[] {
    return value
        .split(/\s+/)
        .map(part => part.trim())
        .filter(part => part.length > 0);
}

export function isRunning(): boolean {
    if (armaProcess && !armaProcess.killed) {
        return true;
    }

    if (process.platform !== "win32") {
        return false;
    }

    // Localised hint that tasklist prints when no matching process exists.
    const noTaskLine = "INFO: No tasks";

    try {
        const output = require("child_process").execSync('tasklist /FI "IMAGENAME eq arma3_x64.exe" /FO CSV /NH', { encoding: "utf8" });

        if (!output.includes("arma3_x64.exe") && !output.includes(noTaskLine)) {
            log(`tasklist output: ${output.split(/\r?\n/).slice(0, 3).join(" | ")}`);
        }

        return output.includes("arma3_x64.exe");
    } catch {
        return false;
    }
}

/** Polls GET /api/status until the game answers (or the timeout expires). */
export async function waitForApi(settings: Settings, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            const status = await getStatus(settings);

            if (status.status === "ok" && status.gameConnected) {
                log(`SqfReloader ready: version ${status.version}, ${settings.apiUrl}`);
                return true;
            }

            if (status.status === "ok") {
                // REST is up, waiting for the SQF callback (mission/editor still loading).
                log("SqfReloader REST is up, waiting for the game callback...");
            }
        } catch (error) {
            lastError = error;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (lastError) {
        log(`Last connection error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }

    return false;
}

/**
 * Ensures the user's addons are linked before Arma starts. Called when the game is already
 * running (editing a script triggers this through the save handler).
 */
export function ensureAddonLinks(armaDirectory: string, settings: Settings): string[] {
    const mods = workspaceMods();
    const addons = workspaceAddons();

    if (mods.length === 0) {
        return ["No mod found in this workspace (expected a folder with addons/ and $PBOPREFIX$)."];
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


