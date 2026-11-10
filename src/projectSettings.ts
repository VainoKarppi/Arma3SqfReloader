import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_PORT } from "./ports";

/** Project settings live in their own file so the extension never touches settings.json. */
export const PROJECT_SETTINGS_FILE = "sqfReloader-settings.json";

export const DEFAULT_HOOK_PRESENTATION = {
    echo: true,
    reveal: "always",
    focus: false,
    panel: "shared"
};

/** Built-in defaults, written when a project settings file is created. */
export const PROJECT_SETTING_DEFAULTS: Record<string, unknown> = {
    enabled: true,
    armaProfile: "",
    apiUrl: "http://127.0.0.1",
    apiPort: DEFAULT_PORT,
    requestTimeout: 3000,
    runTimeout: 30,
    autoJunction: true,
    junctionMode: "addon",
    reloadOnSave: "reload",
    deletedFunctionBehavior: "keep",
    notifyOnError: true,
    extraLaunchArguments: "-noSplash -skipIntro -noPause",
    serverLaunchArguments: "",
    createExampleWithMission: true,
    clearArmaMissionArtifacts: true,
    logLevel: "info",
    watchInterval: 1000,
    watchExpressions: [],
    modTypes: {},
    externalMods: [],
    hooks: {},
    hookPresentation: { ...DEFAULT_HOOK_PRESENTATION }
};

export function projectSettingsPath(workspace: vscode.WorkspaceFolder | undefined = currentWorkspace()): string | undefined {
    return workspace ? path.join(workspace.uri.fsPath, ".vscode", PROJECT_SETTINGS_FILE) : undefined;
}

export function projectSettingsExists(workspace: vscode.WorkspaceFolder | undefined = currentWorkspace()): boolean {
    const file = projectSettingsPath(workspace);
    return !!file && fs.existsSync(file);
}

export function readProjectSettings(workspace: vscode.WorkspaceFolder | undefined = currentWorkspace()): Record<string, unknown> {
    const file = projectSettingsPath(workspace);
    if (!file) return {};

    try {
        const parsed = parseJsonc(fs.readFileSync(file, "utf8"));
        return isRecord(parsed) ? parsed : {};
    } catch {
        // A malformed file is treated as empty so the defaults keep the extension usable.
        return {};
    }
}

export function projectSetting<T>(key: string, fallback: T, workspace: vscode.WorkspaceFolder | undefined = currentWorkspace()): T {
    const values = readProjectSettings(workspace);
    if (!(key in values)) return fallback;
    const value = values[key];
    // A hand-edited file can contain the wrong type; the fallback keeps callers safe.
    return typeof value === typeof fallback && value !== null ? value as T : fallback;
}

export async function writeProjectSettings(values: Record<string, unknown>, workspace: vscode.WorkspaceFolder | undefined = currentWorkspace()): Promise<void> {
    const file = projectSettingsPath(workspace);
    if (!file) throw new Error("Open an Arma project folder first.");
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(values, null, 4)}\n`, "utf8");
}

export async function setProjectSetting(key: string, value: unknown, workspace: vscode.WorkspaceFolder | undefined = currentWorkspace()): Promise<void> {
    const values = readProjectSettings(workspace);
    values[key] = value;
    await writeProjectSettings(values, workspace);
}

/** Adds keys the file does not contain yet, leaving every existing value untouched. */
export async function ensureProjectSettings(defaults: Record<string, unknown>, workspace: vscode.WorkspaceFolder | undefined = currentWorkspace()): Promise<void> {
    const values = readProjectSettings(workspace);
    let changed = !projectSettingsExists(workspace);

    for (const [key, value] of Object.entries(defaults)) {
        if (!(key in values)) {
            values[key] = value;
            changed = true;
        }
    }

    if (changed) await writeProjectSettings(values, workspace);
}

/** Accepts plain JSON and the whole-line comments the scaffold template uses. */
function parseJsonc(text: string): unknown {
    const stripped = text
        .split(/\r?\n/)
        .filter(line => !line.trim().startsWith("//"))
        .join("\n")
        .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(stripped);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function currentWorkspace(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}
