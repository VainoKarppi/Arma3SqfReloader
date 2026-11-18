import * as path from "path";
import * as vscode from "vscode";
import { readProjectSettings } from "./projectSettings";

/**
 * Folders SqfReloader ignores completely, from the `excludedFolders` project setting.
 *
 * A publish script usually copies the finished mod into a `Publish` folder and zips that copy.
 * The copy defines every function a second time, which blocks every reload with
 * "Function variable '<tag>_fnc_x' is defined by multiple files" and links the copied addons
 * into Arma twice. Listing such folders here removes them from discovery, reload, duplicate
 * checks, links and the API function index.
 *
 * Entries are paths relative to the workspace folder (or absolute paths), matched
 * case-insensitively on Windows.
 */
interface ResolvedExclusions {
    /** The raw setting value the folders were resolved from; identity is the cache key. */
    raw: unknown;
    folders: string[];
}

const resolved = new Map<string, ResolvedExclusions>();

/** `excludedFolders` exactly as written in the project settings file. */
export function excludedFolderPatterns(workspace?: vscode.WorkspaceFolder): string[] {
    const value = readProjectSettings(workspace).excludedFolders;
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map(item => item.trim())
        .filter(Boolean);
}

/** Absolute, lower-cased excluded folders (no trailing separator) for one workspace folder. */
function excludedFoldersFor(workspace: vscode.WorkspaceFolder): string[] {
    const raw = readProjectSettings(workspace).excludedFolders;
    const key = normalizedPath(workspace.uri.fsPath);
    const cached = resolved.get(key);
    if (cached && cached.raw === raw) return cached.folders;

    const folders: string[] = [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (typeof item !== "string" || !item.trim()) continue;
            const configured = item.trim();
            const folder = normalizedPath(path.isAbsolute(configured) ? configured : path.join(workspace.uri.fsPath, configured));
            if (!folders.includes(folder)) folders.push(folder);
        }
    }

    resolved.set(key, { raw, folders });
    return folders;
}

function normalizedPath(target: string): string {
    return path.resolve(target).toLowerCase().replace(/[\\/]+$/, "");
}

/** True when the file or folder lies inside a folder excluded by the project settings. */
export function isExcludedPath(filePath: string): boolean {
    if (!filePath) return false;

    const target = normalizedPath(filePath);
    for (const workspace of vscode.workspace.workspaceFolders ?? []) {
        for (const folder of excludedFoldersFor(workspace)) {
            if (target === folder || target.startsWith(folder + path.sep)) return true;
        }
    }

    return false;
}

/** The entries of `paths` that are not inside an excluded folder. */
export function filterExcludedPaths<T extends string>(paths: T[]): T[] {
    return paths.filter(filePath => !isExcludedPath(filePath));
}
