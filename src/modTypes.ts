import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./settings";

export type ModType = "client" | "server" | "both" | "off";

const MOD_TYPES_SETTING = "modTypes";

/**
 * Launch role of a workspace mod: undefined when unclassified (the default, launched with -mod),
 * "off" when the folder was discovered but must not be passed to Arma at all.
 */
export function modTypeForDirectory(directory: string): ModType | undefined {
    const workspace = workspaceForDirectory(directory);
    if (!workspace) return undefined;

    const key = relativeModPath(workspace.uri.fsPath, directory);
    const configured = readConfiguredTypes(workspace);
    const value = configured[key];

    return isModType(value) ? value : undefined;
}

export async function setModTypeForDirectory(directory: string, type: ModType | undefined): Promise<void> {
    const workspace = workspaceForDirectory(directory);
    if (!workspace) {
        throw new Error("The selected mod folder is not inside an open workspace folder.");
    }

    const settingsFile = path.join(workspace.uri.fsPath, ".vscode", "settings.json");
    if (!fs.existsSync(settingsFile)) {
        const create = await vscode.window.showInformationMessage(
            `This project has no .vscode/settings.json. Create it to save the mod launch role?`,
            "Create Settings",
            "Cancel"
        );
        if (create !== "Create Settings") return;
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        try {
            fs.writeFileSync(settingsFile, "{}\n", { encoding: "utf8", flag: "wx" });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
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

    const configuration = vscode.workspace.getConfiguration("sqfReloader", workspace.uri);
    const configured = readConfiguredTypes(workspace);
    const next = { ...configured };
    const key = relativeModPath(workspace.uri.fsPath, directory);

    if (type) {
        next[key] = type;
    } else {
        delete next[key];
    }

    await configuration.update(MOD_TYPES_SETTING, next, vscode.ConfigurationTarget.Workspace);
    log(`${type ? `Set ${path.basename(directory)} mod type to ${type}` : `Cleared mod type for ${path.basename(directory)}`}.`);
}

function readConfiguredTypes(workspace: vscode.WorkspaceFolder): Record<string, unknown> {
    const value = vscode.workspace.getConfiguration("sqfReloader", workspace.uri)
        .get<unknown>(MOD_TYPES_SETTING, {});
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        log(`sqfReloader.${MOD_TYPES_SETTING} in ${workspace.name} must be an object.`);
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
    return value === "client" || value === "server" || value === "both" || value === "off";
}
