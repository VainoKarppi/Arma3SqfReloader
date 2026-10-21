import * as vscode from "vscode";

export type ReloadMode = "reload" | "recompile" | "off";
export type JunctionMode = "addon" | "module";

export interface Settings {
    enabled: boolean;
    apiUrl: string;
    armaDirectory: string;
    requestTimeout: number;
    autoJunction: boolean;
    junctionMode: JunctionMode;
    reloadOnSave: ReloadMode;
    notifyOnError: boolean;
    /** Arguments added after -mod/-init when launching Arma (e.g. "-window -noSplash"). */
    extraLaunchArguments: string;
    /** "Create example mod" also writes a minimal test mission. */
    createExampleWithMission: boolean;
}

const SECTION = "sqfReloader";

export function readSettings(): Settings {
    const config = vscode.workspace.getConfiguration(SECTION);

    return {
        enabled: config.get<boolean>("enabled", true),
        apiUrl: trimSlash(config.get<string>("apiUrl", "http://127.0.0.1:8765/api")),
        armaDirectory: config.get<string>("armaDirectory", "").trim(),
        requestTimeout: Math.max(500, config.get<number>("requestTimeout", 3000)),
        autoJunction: config.get<boolean>("autoJunction", true),
        junctionMode: config.get<JunctionMode>("junctionMode", "addon"),
        reloadOnSave: config.get<ReloadMode>("reloadOnSave", "reload"),
        notifyOnError: config.get<boolean>("notifyOnError", true),
        extraLaunchArguments: config.get<string>("extraLaunchArguments", "-noSplash -skipIntro -noPause"),
        createExampleWithMission: config.get<boolean>("createExampleWithMission", true)
    };
}

export async function updateSetting<T>(key: string, value: T, target = vscode.ConfigurationTarget.Global): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/, "");
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
