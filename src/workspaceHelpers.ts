import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { findMissions, MissionFolder } from "./arma";
import { ensureProjectSettings, projectSettingsPath, PROJECT_SETTING_DEFAULTS } from "./projectSettings";
import { workspaceMods } from "./runtime";

/**
 * Small workspace queries used by the command handlers: which mods/missions exist, which mission
 * the active editor belongs to, and how to open the project settings file.
 */

export function apiPort(apiUrl: string): string {
    try {
        return new URL(apiUrl).port || "?";
    } catch {
        return "?";
    }
}

export function findCurrentMission(): { directory: string } | undefined {
    const document = vscode.window.activeTextEditor?.document;
    if (!document?.uri.fsPath) return undefined;

    let directory = fs.existsSync(document.uri.fsPath) && fs.statSync(document.uri.fsPath).isDirectory()
        ? document.uri.fsPath : path.dirname(document.uri.fsPath);
    const roots = [
        ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
        directory
    ];
    while (true) {
        const match = findMissions(roots).find(mission => path.resolve(mission.directory).toLowerCase() === path.resolve(directory).toLowerCase());
        if (match) return match;
        const parent = path.dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
    }
}

export function hasArmaWorkspace(): boolean {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    return roots.length > 0 && (workspaceMods().length > 0 || findMissions(roots).length > 0);
}

export async function workspaceHasNoFiles(): Promise<boolean> {
    const files = await vscode.workspace.findFiles("**/*", "**/{.git,.vscode,node_modules}/**", 1);
    return files.length === 0;
}

export function findMissionForCurrentEditor(): MissionFolder | undefined {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    const active = vscode.window.activeTextEditor?.document;
    const activePath = active?.uri.scheme === "file" ? active.fileName : undefined;
    const scanRoots = activePath ? [...roots, path.dirname(activePath)] : roots;
    const missions = findMissions(scanRoots);

    if (activePath) {
        const containing = missions
            .filter(mission => {
                const relative = path.relative(mission.directory, activePath);
                return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
            })
            .sort((left, right) => left.directory.length - right.directory.length);
        if (containing.length > 0) return containing[0];
    }

    return missions.find(mission => roots.some(root => path.resolve(root).toLowerCase() === path.resolve(mission.directory).toLowerCase()))
        ?? missions[0];
}

export async function openProjectSettingsFile(): Promise<void> {
    const file = projectSettingsPath();
    if (!file) return;
    if (!fs.existsSync(file)) await ensureProjectSettings(PROJECT_SETTING_DEFAULTS);
    if (!fs.existsSync(file)) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { preview: false });
}
