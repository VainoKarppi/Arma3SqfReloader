import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { findArmaDirectory, pickArmaDirectory, toArmaPath } from "./arma";
import { getStatus } from "./api";
import { log, logError, readSettings, Settings, updateSetting } from "./settings";
import { PreparedLaunch, ensurePrefixFile, prepareRuntime, Runtime, verifyWorkspaceAddons, workspaceAddons, workspaceMods, writeApiConfig } from "./runtime";
import { createLinks } from "./junctions";

export interface LaunchOptions {
    /** Extra launch parameters, e.g. "-window -noSplash". */
    extraArguments?: string[];
    /** Maps/missions to open after starting (passed as -mission/-worldPosition). */
    mission?: string;
}

let armaProcess: ReturnType<typeof spawn> | undefined;
let rptPoll: ReturnType<typeof setInterval> | undefined;
let rptFile = "";
let rptOffset = 0;
let rptPartial = "";
let rptErrorBlock: string[] = [];
let rptDiagnostics: vscode.DiagnosticCollection | undefined;

export function setRptDiagnosticCollection(collection: vscode.DiagnosticCollection): void {
    rptDiagnostics = collection;
}

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
        // Play is the one step that makes a mod playable: it writes missing $PBOPREFIX$ files
        // and then the config (which lists those prefixes for the SQF reloader).
        for (const addon of workspaceAddons()) {
            ensurePrefixFile(addon);
        }

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

        log(`-mod= entries: ${launch.mods.join(" ; ")}`);

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
    startRptMonitor();

    armaProcess.on("error", error => logError("arma3_x64.exe could not be started", error));
    armaProcess.on("exit", (code, signal) => {
        log(`Arma 3 exited (${signal ?? code ?? "?"}).`);
        armaProcess = undefined;
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
        try {
            const files = fs.readdirSync(armaLogDirectory())
                .filter(name => /^arma3_x64_.*\.rpt$/i.test(name))
                .map(name => path.join(armaLogDirectory(), name))
                .filter(file => fs.statSync(file).isFile())
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            const latest = files[0];
            if (!latest) return;
            if (latest !== rptFile) {
                rptFile = latest;
                rptOffset = 0;
            }
            const stat = fs.statSync(rptFile);
            if (stat.size < rptOffset) rptOffset = 0;
            if (stat.size === rptOffset) return;
            // Keep the RPT descriptor open only for the duration of this read.
            const fd = fs.openSync(rptFile, "r");
            const buffer = Buffer.alloc(stat.size - rptOffset);
            try {
                fs.readSync(fd, buffer, 0, buffer.length, rptOffset);
            } finally {
                fs.closeSync(fd);
            }
            rptOffset = stat.size;
            const lines = (rptPartial + buffer.toString("utf8")).split(/\r?\n/);
            rptPartial = lines.pop() ?? "";
            for (const line of lines) consumeRptLine(line);
        } catch {
            // The log may not exist until Arma starts; retry on the next poll.
        }
    }, 1000);
    rptPoll.unref?.();
}

export function stopRptMonitor(): void {
    if (rptPoll) clearInterval(rptPoll);
    rptPoll = undefined;
}

function consumeRptLine(line: string): void {
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

    return undefined;
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


