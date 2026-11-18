import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ensureProjectSettings, readProjectSettings, setProjectSetting, PROJECT_SETTING_DEFAULTS } from "./projectSettings";
import { log, readSettings } from "./settings";
import { fireHook } from "./hooks";

export type ModType = "client" | "server" | "off";

const MOD_TYPES_SETTING = "modTypes";

/**
 * Launch role of a workspace mod: undefined when the folder has no saved role, "off" when the
 * folder was discovered but must not be passed to Arma at all. Whether an unclassified folder
 * launches is decided by {@link modLaunchesInArma}.
 *
 * The removed "both" (Shared Mod) role is read as unclassified, so an older settings file keeps
 * launching that folder as a client mod.
 */
export function modTypeForDirectory(directory: string): ModType | undefined {
    const context = modRoleContext(directory);
    if (!context) return undefined;

    const value = context.configured[context.key];
    return isModType(value) ? value : undefined;
}

/**
 * True when a discovered workspace folder reaches Arma (-mod= / -serverMod=).
 *
 * A folder with a saved role launches unless the role is "off". An unclassified folder launches as
 * a client mod only while the project has saved no role at all; once it classifies mods, folders
 * the user did not opt into - a `Publish` copy written by a build script, for example - stay out of
 * the launch instead of being mounted a second time.
 */
export function modLaunchesInArma(directory: string): boolean {
    const type = modTypeForDirectory(directory);
    if (type) return type !== "off";
    return !hasSavedModRoles(directory);
}

/** True when the project that owns the folder saves at least one mod role in `modTypes`. */
export function hasSavedModRoles(directory: string): boolean {
    const context = modRoleContext(directory);
    return !!context && Object.keys(context.configured).length > 0;
}

interface ModRoleContext {
    /** Path of the folder relative to the workspace root, as used as the `modTypes` key. */
    key: string;
    configured: Record<string, unknown>;
}

function modRoleContext(directory: string): ModRoleContext | undefined {
    const workspace = workspaceForDirectory(directory);
    if (!workspace) return undefined;

    return {
        key: relativeModPath(workspace.uri.fsPath, directory),
        configured: readConfiguredTypes(workspace)
    };
}

export async function setModTypeForDirectory(directory: string, type: ModType | undefined): Promise<void> {
    const workspace = workspaceForDirectory(directory);
    if (!workspace) {
        throw new Error("The selected mod folder is not inside an open workspace folder.");
    }

    const addonsPath = path.join(directory, "addons");
    let hasAddonsDirectory = false;
    try {
        hasAddonsDirectory = fs.statSync(addonsPath).isDirectory();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // An addons folder with loose sources and no PBOs is a normal unpacked development mod, so it
    // is saved without a confirmation. Only a folder without addons/ at all asks first.
    if (type && type !== "off" && !hasAddonsDirectory) {
        const proceed = await vscode.window.showWarningMessage(
            `${path.basename(directory)} has no root addons folder and does not look like a conventional Arma mod. Assign a launch type anyway?`,
            { modal: true },
            "Assign Anyway"
        );
        if (proceed !== "Assign Anyway") return;
    }

    const configured = readConfiguredTypes(workspace);
    const next = { ...configured };
    const key = relativeModPath(workspace.uri.fsPath, directory);

    if (type) {
        next[key] = type;
    } else {
        delete next[key];
    }

    // The project settings file is created on demand so the launch role survives a restart.
    await ensureProjectSettings(PROJECT_SETTING_DEFAULTS, workspace);
    await setProjectSetting(MOD_TYPES_SETTING, next, workspace);
    log(`${type ? `Set ${path.basename(directory)} mod type to ${type}` : `Cleared mod type for ${path.basename(directory)}`}.`);
    fireHook("onModConfigChanged", readSettings(), { file: directory });
}

function readConfiguredTypes(workspace: vscode.WorkspaceFolder): Record<string, unknown> {
    const value = readProjectSettings(workspace)[MOD_TYPES_SETTING];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        log(`${MOD_TYPES_SETTING} in the ${workspace.name} project settings must be an object.`);
        return {};
    }

    return value as Record<string, unknown>;
}

function workspaceForDirectory(directory: string): vscode.WorkspaceFolder | undefined {
    const resolved = path.resolve(directory);
    return (vscode.workspace.workspaceFolders ?? [])
        .filter(folder => {
            const relative = path.relative(folder.uri.fsPath, resolved);
            return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
        })
        .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0];
}

function relativeModPath(workspaceDirectory: string, directory: string): string {
    return path.relative(workspaceDirectory, path.resolve(directory)).replace(/\\/g, "/") || ".";
}

function isModType(value: unknown): value is ModType {
    return value === "client" || value === "server" || value === "off";
}
