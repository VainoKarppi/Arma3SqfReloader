import * as vscode from "vscode";
import { currentApiPort } from "./runtime";
import { DEFAULT_PORT, makeApiUrl, normalizeApiHost } from "./ports";

export type ReloadMode = "reload" | "recompile" | "off";
export type JunctionMode = "addon" | "module";
export type LogLevel = "error" | "warning" | "info" | "verbose";

export interface Settings {
    enabled: boolean;
    apiUrl: string;
    apiPort: number;
    armaDirectory: string;
    armaProfile: string;
    requestTimeout: number;
    /** Maximum time to wait for an SQF file run to return its value, in seconds. */
    runTimeout: number;
    autoJunction: boolean;
    junctionMode: JunctionMode;
    reloadOnSave: ReloadMode;
    notifyOnError: boolean;
    /** Extra arguments added when launching Arma (e.g. "-window -noSplash"). */
    extraLaunchArguments: string;
    /** "Create example mod" also writes a minimal test mission. */
    createExampleWithMission: boolean;
    /** Remove Arma-generated ~Mission.World preview copies from the active profile. */
    clearArmaMissionArtifacts: boolean;
    /** Diagnostic verbosity in the VS Code output and Arma RPT. */
    logLevel: LogLevel;
}

const SECTION = "sqfReloader";

export function readSettings(): Settings {
    const config = vscode.workspace.getConfiguration(SECTION);
    const apiPort = readApiPort(config);
    const configuredApiUrl = config.get<string>("apiUrl", "http://127.0.0.1");

    return {
        enabled: config.get<boolean>("enabled", true),
        apiUrl: trimSlash(resolveApiUrl(makeApiUrl(configuredApiUrl, apiPort))),
        apiPort,
        armaDirectory: config.get<string>("armaDirectory", "").trim(),
        armaProfile: config.get<string>("armaProfile", "").trim(),
        requestTimeout: Math.max(500, config.get<number>("requestTimeout", 3000)),
        runTimeout: Math.min(300, Math.max(1, config.get<number>("runTimeout", 30))),
        autoJunction: config.get<boolean>("autoJunction", true),
        junctionMode: config.get<JunctionMode>("junctionMode", "addon"),
        reloadOnSave: config.get<ReloadMode>("reloadOnSave", "reload"),
        notifyOnError: config.get<boolean>("notifyOnError", true),
        extraLaunchArguments: config.get<string>("extraLaunchArguments", "-noSplash -skipIntro -noPause"),
        createExampleWithMission: config.get<boolean>("createExampleWithMission", true),
        clearArmaMissionArtifacts: config.get<boolean>("clearArmaMissionArtifacts", true),
        logLevel: normalizeLogLevel(config.get<string>("logLevel", "info"))
    };
}

export function readApiPort(config = vscode.workspace.getConfiguration(SECTION)): number {
    const configured = typeof config.inspect === "function" ? config.inspect<number>("apiPort") : undefined;
    const explicitApiPort = configured?.workspaceFolderValue
        ?? configured?.workspaceValue
        ?? configured?.globalValue;
    return normalizePort(explicitApiPort ?? config.get<number>("defaultPort", DEFAULT_PORT));
}

function normalizeLogLevel(level: string): LogLevel {
    switch (level.trim().toLowerCase()) {
        case "error":
            return "error";
        case "warning":
            return "warning";
        case "verbose":
            return "verbose";
        default:
            return "info";
    }
}

function normalizePort(port: number): number {
    return Number.isFinite(port) ? Math.min(65535, Math.max(1, Math.trunc(port))) : DEFAULT_PORT;
}

export async function updateSetting<T>(key: string, value: T, target = vscode.ConfigurationTarget.Global): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}

export function configuredLogLevel(): LogLevel {
    return readSettings().logLevel;
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

/**
 * Overrides the configured port with the port that was written to SqfReloader's config.json.
 *
 * Port 8764 is commonly taken by other Arma tools (EdenOnline, an earlier SqfReloader build),
 * and the DLL then answers "Failed to listen ... conflicts with an existing registration on
 * the machine". The launcher writes the resolved port back, so requests have to follow it.
 */
function resolveApiUrl(apiUrl: string): string {
    const port = currentApiPort();

    if (!port) {
        return apiUrl;
    }

    try {
        const url = new URL(apiUrl);
        if (Number(url.port || 0) === port) {
            return apiUrl;
        }

        url.port = String(port);
        return url.toString();
    } catch {
        return apiUrl;
    }
}

let channel: vscode.OutputChannel | undefined;

export function getOutput(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel("Arma 3 SQF Reloader");
    }

    return channel;
}

export function log(message: string): void {
    if (configuredLogLevel() !== "verbose") {
        return;
    }

    getOutput().appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    mirrorToTestOutput(`LOG ${message}`);
}

export function logError(message: string, error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (configuredLogLevel() !== "error") {
        getOutput().appendLine(`[${new Date().toLocaleTimeString()}] ERROR: ${message} - ${detail}`);
        mirrorToTestOutput(`LOG ERROR: ${message} - ${detail}`);
    }
}

/** Dev aid: scripts/verify-launch.js points ARMA_API_TEST_OUTPUT at a file and reads the log from there. */
function mirrorToTestOutput(line: string): void {
    const target = process.env.ARMA_API_TEST_OUTPUT;

    if (!target) {
        return;
    }

    try {
        require("fs").appendFileSync(target, `${line}\n`, "utf8");
    } catch {
        // The test output file is best effort only.
    }
}

export function disposeOutput(): void {
    channel?.dispose();
    channel = undefined;
}
