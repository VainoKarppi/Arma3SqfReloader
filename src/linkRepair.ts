import * as vscode from "vscode";
import { Mod } from "./arma";
import { createLinks, LinkConflict, LinkResult, replaceRealFolderWithLink } from "./junctions";
import { log, Settings } from "./settings";

export interface RepairOptions {
    /** Never prompt (headless / background flows). */
    silent?: boolean;
    /** Ask again even when the user declined this conflict earlier in the session. */
    force?: boolean;
}

/** Conflicts the user already declined, so startup does not nag on every refresh. */
const declined = new Set<string>();

function conflictKey(conflict: LinkConflict): string {
    return `${conflict.linkPath.toLowerCase()}\u0000${conflict.target.toLowerCase()}`;
}

/**
 * Offers to move a real folder that blocks an addon mount aside and replace it with the
 * junction to the workspace sources. Returns true when at least one folder was replaced.
 */
export async function repairLinkConflicts(conflicts: LinkConflict[], options: RepairOptions = {}): Promise<boolean> {
    const pending = conflicts.filter(conflict => options.force || !declined.has(conflictKey(conflict)));
    if (pending.length === 0) return false;

    if (options.silent) {
        for (const conflict of pending) declined.add(conflictKey(conflict));
        log(`Link conflicts were not repaired (headless): ${pending.map(conflict => conflict.linkPath).join(", ")}`);
        return false;
    }

    const detail = pending
        .map(conflict => `${conflict.linkPath}\n  -> ${conflict.target}`)
        .join("\n\n");
    const choice = await vscode.window.showWarningMessage(
        `Arma 3 SQF Reloader: ${pending.length === 1 ? "a real folder blocks" : `${pending.length} real folders block`} the addon link${pending.length === 1 ? "" : "s"} to your workspace sources.`,
        {
            modal: true,
            detail: `${detail}\n\nThe existing folder is moved to <Arma 3>\\.sqfreloader-backups and replaced with a junction. It is not deleted.`
        },
        "Replace With Junction",
        "Keep Folder"
    );

    if (choice !== "Replace With Junction") {
        for (const conflict of pending) declined.add(conflictKey(conflict));
        return false;
    }

    let repaired = false;
    for (const conflict of pending) {
        const outcome = replaceRealFolderWithLink(conflict);
        if (outcome.ok) {
            repaired = true;
            declined.delete(conflictKey(conflict));
            log(`Replaced real folder with a junction: ${conflict.linkPath} -> ${conflict.target} (backup: ${outcome.backupPath})`);
        } else {
            declined.add(conflictKey(conflict));
            log(`Could not repair ${conflict.linkPath}: ${outcome.error}`);
            void vscode.window.showErrorMessage(`Could not replace ${conflict.linkPath}: ${outcome.error}`);
        }
    }

    return repaired;
}

/** Creates the links and repairs real-folder conflicts the user accepts. */
export async function createLinksWithRepair(
    armaDirectory: string,
    mods: Mod[],
    settings: Settings,
    options: RepairOptions = {}
): Promise<LinkResult> {
    let result = createLinks(armaDirectory, mods, settings.junctionMode);
    if (result.conflicts.length === 0) return result;

    if (await repairLinkConflicts(result.conflicts, options)) {
        result = createLinks(armaDirectory, mods, settings.junctionMode);
    }

    return result;
}

export function resetDeclinedLinkConflicts(): void {
    declined.clear();
}
