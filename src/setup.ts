import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
    findArmaDirectory,
    findModForFile,
    findMods,
    Mod,
    Addon
} from "./arma";
import { Link, removeAllLinks, removeOrphanLinks, verifyAddonLink } from "./junctions";
import { createLinksWithRepair } from "./linkRepair";
import { log, Settings } from "./settings";
import { fireHook, runHook } from "./hooks";

export interface SetupResult {
    armaDirectory: string;
    mods: Mod[];
    links: Link[];
    warnings: string[];
}

/**
 * Sets up one mod folder: finds Arma, creates the junctions, stores the Arma directory in
 * the settings and verifies that every addon resolves to the working copy.
 */
export async function setupMod(mod: Mod, settings: Settings, silent = false): Promise<SetupResult | undefined> {
    const armaDirectory = await findArmaDirectory(settings);

    if (!armaDirectory) {
        if (!silent) {
            vscode.window.showErrorMessage("Arma 3 was not found. Set \"armaDirectory\" in .vscode/sqfReloader-settings.json or pick the folder when asked.");
        }

        return undefined;
    }

    if (mod.addons.length === 0) {
        const warning = `${mod.directory} has no addon source folder with config.cpp or functions/, so there is nothing to link.`;
        log(warning);

        if (!silent) {
            vscode.window.showWarningMessage(`Arma 3 SQF Reloader: ${warning}`);
        }

        return { armaDirectory, mods: [mod], links: [], warnings: [warning] };
    }

    const { links, warnings } = await createLinksWithRepair(armaDirectory, [mod], settings, {
        silent: silent || !!process.env.ARMA_API_TEST_OUTPUT,
        force: true
    });

    // Verify every addon resolves to the working copy; a real folder in the way is the most
    // common reason a reload silently reads an old PBO instead of the scripts.
    for (const addon of mod.addons) {
        const check = verifyAddonLink(armaDirectory, addon);

        if (!check.ok) {
            warnings.push(`${addon.prefix} in the Arma folder is not linked to ${addon.localDirectory}${check.resolved ? ` (points to ${check.resolved})` : ""}.`);
        }
    }

    if (!silent) {
        const addonNames = mod.addons.map(addon => addon.prefix).join(", ");
        const summary = links.length > 0
            ? `Linked ${mod.name} ${settings.junctionMode === "module" ? "as a module" : `(${addonNames})`} into ${armaDirectory}.`
            : `Links already in place for ${mod.name}.`;

        if (warnings.length > 0) {
            vscode.window.showWarningMessage(`Arma 3 SQF Reloader: ${summary} ${warnings[0]}`);
        } else {
            vscode.window.showInformationMessage(`Arma 3 SQF Reloader: ${summary}`);
        }
    }

    return { armaDirectory, mods: [mod], links, warnings };
}

/** Sets up every mod found in the workspace. */
export async function setupWorkspace(settings: Settings): Promise<SetupResult | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (folders.length === 0) {
        vscode.window.showWarningMessage("Open a folder with your Arma mod first.");
        return undefined;
    }

    const mods: Mod[] = [];

    for (const folder of folders) {
        mods.push(...findMods(folder.uri.fsPath));
    }

    if (mods.length === 0) {
        vscode.window.showWarningMessage("No Arma mod found in this workspace (expected a folder with addons/ or config.cpp).");
        return undefined;
    }

    const armaDirectory = await findArmaDirectory(settings);

    if (!armaDirectory) {
        vscode.window.showErrorMessage("Arma 3 was not found. Set \"armaDirectory\" in .vscode/sqfReloader-settings.json.");
        return undefined;
    }

    const { links, warnings } = await createLinksWithRepair(armaDirectory, mods, settings, {
        silent: !!process.env.ARMA_API_TEST_OUTPUT,
        force: true
    });

    for (const mod of mods) {
        for (const addon of mod.addons) {
            const check = verifyAddonLink(armaDirectory, addon);

            if (!check.ok) {
                warnings.push(`${addon.prefix} is not linked to ${addon.localDirectory}.`);
            }
        }
    }

    const names = mods.map(mod => mod.name).join(", ");
    const message = links.length > 0
        ? `Linked ${names} into ${armaDirectory}.`
        : `Links already in place for ${names}.`;

    if (warnings.length > 0) {
        vscode.window.showWarningMessage(`Arma 3 SQF Reloader: ${message} ${warnings[0]}`);
    } else {
        vscode.window.showInformationMessage(`Arma 3 SQF Reloader: ${message}`);
    }

    return { armaDirectory, mods, links, warnings };
}

/** Command: set up the mod of the active editor (or the workspace folder). */
export async function setupFromContext(settings: Settings): Promise<void> {
    const active = vscode.window.activeTextEditor?.document.fileName;
    const mod = active ? findModForFile(active) : undefined;

    if (mod) {
        await setupMod(mod, settings);
        return;
    }

    await setupWorkspace(settings);
}

/** Opens the mod folder in the explorer (created by the first setup). */
/** Removes every junction this extension created in the Arma folder. */
export async function removeJunctions(settings: Settings): Promise<void> {
    const armaDirectory = await findArmaDirectory(settings);

    if (!armaDirectory) {
        vscode.window.showWarningMessage("Arma 3 was not found; nothing to clean up.");
        return;
    }

    const { removed, failed } = removeAllLinks(armaDirectory);

    if (removed.length === 0 && failed.length === 0) {
        vscode.window.showInformationMessage("No junctions created by this extension were found.");
        return;
    }

    fireHook("postJunctionCleanup", settings, { armaDirectory });
    const text = `Removed ${removed.length} link(s)${failed.length > 0 ? `, ${failed.length} could not be removed` : ""}.`;

    if (failed.length > 0) {
        vscode.window.showWarningMessage(`Arma 3 SQF Reloader: ${text}`);
    } else {
        vscode.window.showInformationMessage(`Arma 3 SQF Reloader: ${text}`);
    }
}

/**
 * Called on startup/workspace change: when autoJunction is enabled, makes sure the open mod
 * is linked into Arma without prompting.
 */
export async function ensureJunctions(settings: Settings): Promise<void> {
    if (!settings.autoJunction) {
        return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];

    if (folders.length === 0) {
        return;
    }

    const mods: Mod[] = [];

    for (const folder of folders) {
        mods.push(...findMods(folder.uri.fsPath));
    }

    const linkable = mods.filter(mod => mod.addons.length > 0);

    if (linkable.length === 0) {
        log("No addon source folders with config.cpp or functions/ were found; junctions were not created.");
        return;
    }

    // Without a detected Arma folder there is nothing to link into; do not interrupt startup.
    const armaDirectory = await findArmaDirectory(settings);

    if (!armaDirectory) {
        log("Arma 3 not found; junctions were not created. Use \"SqfReloader: Set up this mod\" to pick the folder.");
        return;
    }

    // Links whose workspace no longer exists would otherwise stay in the Arma folder and profile
    // forever (for example after the extension was closed while Arma was running).
    const orphans = removeOrphanLinks(armaDirectory);
    if (orphans.removed.length > 0) {
        log(`Removed ${orphans.removed.length} link(s) whose target no longer exists: ${orphans.removed.join(", ")}`);
    }

    if (!await runHook("preJunction", settings, { armaDirectory })) return;

    const { warnings } = await createLinksWithRepair(armaDirectory, linkable, settings, {
        silent: !!process.env.ARMA_API_TEST_OUTPUT
    });
    const names = linkable.map(mod => mod.name).join(", ");

    log(`Junction check for ${names} in ${armaDirectory}: ${warnings.length === 0 ? "ok" : warnings.join(" | ")}`);
}

/** Describes the addons of the open mod for the output channel. */
export function describeAddons(addons: Addon[]): string {
    return addons.map(addon => `${addon.prefix} -> ${addon.localDirectory}`).join("\n");
}

export function addonExists(directory: string): boolean {
    return fs.existsSync(path.join(directory, "config.cpp")) || fs.existsSync(path.join(directory, "functions"));
}
