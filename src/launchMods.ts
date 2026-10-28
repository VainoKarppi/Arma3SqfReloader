import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

interface ExternalModSetting {
    path: string;
    type: "client" | "server" | "both";
}

function isModType(value: unknown): value is ExternalModSetting["type"] {
    return value === "client" || value === "server" || value === "both";
}

/** Unique key for a mod folder: Arma must never receive the same folder twice. */
export function modKey(directory: string): string {
    return path.resolve(directory).replace(/[\\/]+$/, "").toLowerCase();
}

/** Keeps the first occurrence of every folder (case, separator and trailing-slash insensitive). */
export function modFoldersOnce(folders: string[]): string[] {
    const seen = new Set<string>();
    return folders.filter(folder => {
        const key = modKey(folder);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** sqfReloader.externalMods entries that name an existing folder. */
export function configuredExternalMods(): ExternalModSetting[] {
    const value = vscode.workspace.getConfiguration("sqfReloader").get<unknown>("externalMods", []);
    if (!Array.isArray(value)) return [];

    const mods: ExternalModSetting[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as { path?: unknown; type?: unknown };
        if (typeof item.path !== "string") continue;
        try {
            if (!fs.statSync(item.path).isDirectory()) continue;
        } catch {
            continue;
        }
        mods.push({ path: item.path, type: isModType(item.type) ? item.type : "client" });
    }
    return mods;
}

/**
 * -mod= entries for the configured external mods.
 *
 * A folder is listed once even when it is also passed as a workspace mod (very common: the
 * workspace holds a copy of a mod installed in the Arma folder), because Arma loads a mod folder
 * that appears twice in -mod= twice: duplicated event handlers and doubled PBOs.
 */
export function launchModFolders(): string[] {
    return modFoldersOnce(configuredExternalMods()
        .filter(mod => mod.type !== "server")
        .map(mod => path.resolve(mod.path)));
}

/** -serverMod= entries from the configured external mods. */
export function launchServerModFolders(): string[] {
    return modFoldersOnce(configuredExternalMods()
        .filter(mod => mod.type === "server")
        .map(mod => path.resolve(mod.path)));
}
