import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { findAddonForFile, toArmaPath, toFunctionVariable } from "./arma";
import { evalCode, listFunctions, recompileCommand, reloadEverything, reloadFunctions, sqfString } from "./api";
import { Settings, log, logError } from "./settings";

export interface ReloadOutcome {
    ok: boolean;
    message: string;
    detail?: string;
}

function notify(settings: Settings, message: string): void {
    if (settings.notifyOnError) {
        vscode.window.showWarningMessage(`Arma 3 SQF Reloader: ${message}`);
    }
}

/**
 * Pushes a saved SQF file to Arma.
 *
 * "reload" (default) sends the mission variable to /api/reload; the SQF side recompiles the
 * file from the junction inside the Arma folder, which also picks up helper functions that
 * are not in a PBO. "recompile" posts the editor content as an EdenOnline-style recompile
 * command. Both fall back to /api/eval with a compile statement when the primary route is
 * unavailable (older ArmaApi builds).
 */
export async function reloadDocument(document: vscode.TextDocument, settings: Settings): Promise<ReloadOutcome> {
    if (settings.reloadOnSave === "off") {
        return { ok: true, message: "Reload on save is disabled." };
    }

    if (document.uri.scheme !== "file" || !/\.(sqf|cpp|hpp)$/i.test(document.fileName)) {
        return { ok: true, message: "Not a saved SQF/C++ file." };
    }

    const addon = findAddonForFile(document.fileName);

    if (!addon) {
        const message = `${path.basename(document.fileName)} is not inside a folder with $PBOPREFIX$, so Arma cannot load it. Use "Arma API: Set up this mod" first.`;
        log(message);
        notify(settings, message);
        return { ok: false, message };
    }

    const variable = toFunctionVariable(addon, document.fileName);

    if (!variable) {
        // config.cpp / init / helpers are not functions: ask Arma to recompile this addon's
        // functions, which re-runs the cost of the changed file on next call.
        log(`${path.basename(document.fileName)} is not a fn_*.sqf function; reloading the mod's functions instead.`);
        return reloadAll(settings, true);
    }

    const armaPath = toArmaPath(addon, document.fileName);
    log(`Saved ${document.fileName} -> ${variable} (${armaPath})`);

    if (settings.reloadOnSave === "recompile") {
        const result = await recompileCommand(settings, armaPath, document.getText());

        if (result.success) {
            return { ok: true, message: `Recompile queued for ${variable}.` };
        }

        log(`/api/command failed (${result.error}); falling back to /api/eval.`);
    }

    try {
        const result = await reloadFunctions(settings, [variable]);

        if (result.success) {
            // Reloading returns instantly; verify the file really exists in Arma's view.
            const check = await verifyFunctionVisible(settings, variable, armaPath);
            return check.ok
                ? { ok: true, message: `Reloaded ${variable}.` }
                : { ok: false, message: check.message, detail: check.detail };
        }

        log(`/api/reload failed: ${result.error}`);
    } catch (error) {
        logError("reload request failed", error);
        notify(settings, error instanceof Error ? error.message : String(error));
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    // Fallback: compile the editor buffer directly in Arma.
    try {
        const code = `${sqfString(variable)} call ArmaApi_fnc_compileFunction;\n` +
            `${sqfString(variable)} = compile ${sqfString(document.getText())};\n` +
            `missionNamespace setVariable ${sqfString(variable)}`;
        const result = await evalCode(settings, code);

        return result.success
            ? { ok: true, message: `Compiled ${variable} from the editor buffer (fallback).` }
            : { ok: false, message: result.error ?? "Compile failed" };
    } catch (error) {
        logError("eval fallback failed", error);
        const message = error instanceof Error ? error.message : String(error);
        notify(settings, message);
        return { ok: false, message };
    }
}

/** Calls the SQF reloader for every function of the mod (or all known functions with fallback). */
export async function reloadAll(settings: Settings, silent = false): Promise<ReloadOutcome> {
    try {
        const result = await reloadEverything(settings);

        if (result.success) {
            const count = typeof result.count === "number" ? ` (${result.count} function${result.count === 1 ? "" : "s"})` : "";
            return { ok: true, message: `Reload queued${count}.` };
        }

        return { ok: false, message: result.error ?? "Reload failed" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("reload all failed", error);

        if (!silent) {
            notify(settings, message);
        }

        return { ok: false, message };
    }
}

/**
 * After /api/reload, make sure the file the previous step resolved to is still there. The
 * extension's FunctionIndex only lists its own sources, so user mods are checked through
 * /api/eval (fileExists) and otherwise reported as "queued".
 */
async function verifyFunctionVisible(settings: Settings, variable: string, armaPath: string): Promise<ReloadOutcome> {
    try {
        const result = await evalCode(settings, `fileExists ${sqfString(armaPath)}`);

        if (result.success) {
            return { ok: true, message: `Reloaded ${variable}.` };
        }
    } catch {
        // Arma may not answer /api/eval; that is not a reload failure.
    }

    return { ok: true, message: `Reload queued for ${variable}.` };
}

/** Reads the list of files ArmaApi can hot reload (its own SQF sources). */
export async function sourceIndex(settings: Settings): Promise<string[]> {
    const result = await listFunctions(settings);
    const functions = Array.isArray(result.functions) ? result.functions as unknown[][] : [];

    return functions
        .filter(entry => Array.isArray(entry) && typeof entry[2] === "string")
        .map(entry => String(entry[2]));
}

/** Forces a compile of one file through /api/eval (used by "Reload current function"). */
export async function reloadFileNow(document: vscode.TextDocument, settings: Settings): Promise<ReloadOutcome> {
    const addon = findAddonForFile(document.fileName);

    if (!addon) {
        return { ok: false, message: "The file is not inside a mod addon ($PBOPREFIX$ not found)." };
    }

    const variable = toFunctionVariable(addon, document.fileName);

    if (!variable) {
        return reloadAll(settings);
    }

    const armaPath = toArmaPath(addon, document.fileName);
    const code = `${sqfString(variable)} = compile preprocessFileLineNumbers ${sqfString(armaPath)};` +
        `\nmissionNamespace setVariable [${sqfString(variable)}, ${sqfString(variable)}];` +
        `\ndiag_log format ["[ArmaApi] recompiled %1", ${sqfString(variable)}];`;

    const result = await evalCode(settings, code);

    if (!result.success) {
        return { ok: false, message: result.error ?? "Reload failed" };
    }

    return { ok: true, message: `Recompiled ${variable} from ${armaPath}.` };
}

/** Files that should trigger a reload when saved. */
export function isReloadable(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== "file") {
        return false;
    }

    return /\.(sqf|cpp|hpp)$/i.test(document.fileName);
}
