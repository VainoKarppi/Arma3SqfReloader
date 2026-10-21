import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { findArmaDirectory, findMissions, pickArmaDirectory, toArmaPath } from "./arma";
import { getOutput, log, logError, readSettings, Settings, updateSetting } from "./settings";
import { PreparedLaunch, prepareRuntime, Runtime, verifyWorkspaceAddons, workspaceAddons, workspaceMods, writeApiConfig } from "./runtime";
import { createLinks } from "./junctions";
import { cleanupSnapshots } from "./reload";
import { parseApiUrl } from "./ports";

/** Port the configured sqfReloader.apiUrl asks for, before any fallback is applied. */
function requestedApiPort(settings: Settings): number {
    return parseApiUrl(vscode.workspace.getConfiguration("sqfReloader").get<string>("apiUrl", "") || settings.apiUrl).port;
}

export interface LaunchOptions {
    /** Extra launch parameters, e.g. "-window -noSplash". */
    extraArguments?: string[];
    /** Existing game mission launch arguments, if any. */
    mission?: string;
    /** Absolute mission.sqm path; Arma opens this scenario directly in Eden at startup. */
    scenarioFile?: string;
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
        // Probe before starting the game: once Arma runs, its own listener owns the port, so a
        // busy 8764 (EdenOnline, an older SqfReloader instance) has to be detected up front.
        const port = await writeApiConfig(settings, true);

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

        if (port !== requestedApiPort(settings)) {
            vscode.window.setStatusBarMessage(`SqfReloader API moved to port ${port} (${requestedApiPort(settings)} is in use).`, 8000);
        }

        startProcess(launch, settings, options);

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

function startProcess(launch: PreparedLaunch, settings: Settings, options: LaunchOptions): void {
    const args = launchArguments(launch, settings, options);

    log(`Starting: "${launch.executable}" ${args.join(" ")}`);

    // Arma is a native .exe, so the command line is assembled verbatim instead of letting Node
    // quote each argument: the complete "-mod=A;B" value must reach the game as one argument.
    armaProcess = spawn(launch.executable, args, {
        // Match the quoted argv[0] emitted by the working Arma Launcher command line.
        argv0: `"${launch.executable}"`,
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
        cleanupSnapshots(launch.armaDirectory);
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
                // Start at the end of an already-existing RPT. It can contain results and
                // diagnostics from a previous VS Code/Arma session; replaying those makes an
                // old "Run in Arma" result appear as soon as the extension activates.
                rptOffset = fs.statSync(rptFile).size;
                rptPartial = "";
                rptErrorBlock = [];
                return;
            }
            const stat = fs.statSync(rptFile);
            if (stat.size < rptOffset) {
                // Arma may recreate or truncate the current log. Treat its current contents
                // as the new baseline for the same reason as a newly discovered file.
                rptOffset = stat.size;
                rptPartial = "";
                rptErrorBlock = [];
                return;
            }
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
    const runResult = /\[SqfReloader Run:([^\]]+)\]\s*(.*)/.exec(line);
    if (runResult) {
        // Arma wraps diag_log string values in quotes in the RPT; strip its closing quote
        // from the captured payload so it does not appear in either VS Code surface.
        const resultText = runResult[2].replace(/"\s*$/, "").trimEnd();
        const output = getOutput();
        output.appendLine(`[Arma result ${runResult[1]}] ${resultText}`);
        output.show(true);
        void vscode.window.showInformationMessage(`Arma SQF result: ${resultText}`);
        return;
    }

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

    const extra = options.extraArguments ?? parseExtraArguments(settings.extraLaunchArguments);
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

    // Arma expects the whole -mod value quoted as one argument, with semicolons separating
    // paths inside it. Quoting each path separately makes Arma ignore the startup scenario.
    if (launch.mods.length > 0) {
        args.push(`"-mod=${launch.mods.map(uppercaseDriveLetter).join(";")}"`);
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


