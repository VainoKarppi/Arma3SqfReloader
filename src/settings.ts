import * as vscode from "vscode";
import { currentApiPort } from "./runtime";

export type ReloadMode = "reload" | "recompile" | "off";
export type JunctionMode = "addon" | "module";

export interface Settings {
    enabled: boolean;
    apiUrl: string;
    defaultPort: number;
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
}

const SECTION = "sqfReloader";

export function readSettings(): Settings {
    const config = vscode.workspace.getConfiguration(SECTION);
    const defaultPort = normalizePort(config.get<number>("defaultPort", 8764));
    const configuredApiUrl = config.get<string>("apiUrl", "http://127.0.0.1/api");

    return {
        enabled: config.get<boolean>("enabled", true),
        apiUrl: trimSlash(resolveApiUrl(withDefaultPort(configuredApiUrl, defaultPort))),
        defaultPort,
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
        clearArmaMissionArtifacts: config.get<boolean>("clearArmaMissionArtifacts", true)
    };
}

function normalizePort(port: number): number {
    return Number.isFinite(port) ? Math.min(65535, Math.max(1, Math.trunc(port))) : 8764;
}

/** Use defaultPort only when apiUrl has no explicit port. */
function withDefaultPort(apiUrl: string, defaultPort: number): string {
    try {
        const url = new URL(apiUrl);
        if (!url.port) url.port = String(defaultPort);
        return url.toString();
    } catch {
        return apiUrl;
    }
}

export async function updateSetting<T>(key: string, value: T, target = vscode.ConfigurationTarget.Global): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
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
    getOutput().appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    mirrorToTestOutput(`LOG ${message}`);
}

export function logError(message: string, error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    getOutput().appendLine(`[${new Date().toLocaleTimeString()}] ERROR: ${message} - ${detail}`);
    mirrorToTestOutput(`LOG ERROR: ${message} - ${detail}`);
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
