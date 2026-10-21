import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findMods, Mod, normalizePrefix, readAddon, Addon } from "./arma";
import { createLinks } from "./junctions";
import { log, logError, readSettings, Settings } from "./settings";

/**
 * Everything the extension needs at runtime ships inside the .vsix (vscode-runtime/):
 *
 *   vscode-runtime/mod/@SqfReloader/   the complete SqfReloader mod, exactly as it must look in the
 *                                   Arma folder:
 *                                     mod.cpp
 *                                     logo.paa
 *                                     addons\scripts.pbo
 *                                     SqfReloader_x64.dll
 *
 * `@SqfReloader` is copied to `<Arma 3>\@SqfReloader` (never junctioned - it is not a working
 * copy) and replaced whenever the extension is updated. The DLL sits in the MOD ROOT:
 * Arma resolves extensions from the executable folder or the mod root, and reports
 * "CallExtension 'SqfReloader' could not be found" for anything in a dll\ subfolder.
 *
 * Nothing else is generated into the folder - Arma reads all SQF from scripts.pbo.
 */
export interface Runtime {
    /** Absolute path of the bundled @SqfReloader mod. */
    modDirectory: string;
}

export interface PreparedLaunch {
    armaDirectory: string;
    executable: string;
    /** Mod folders passed to -mod=. */
    mods: string[];
    /** Deployed @SqfReloader folder. */
    modPath: string;
    /** Warnings that did not stop the launch. */
    warnings: string[];
    /** The mods that were found in the workspace (for hot reload). */
    userMods: Mod[];
}

export function runtimeDirectory(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, "vscode-runtime");
}

export function loadRuntime(context: vscode.ExtensionContext): Runtime | undefined {
    const root = runtimeDirectory(context);
    const modDirectory = path.join(root, "mod", "@SqfReloader");

    if (!fs.existsSync(modDirectory) || !fs.existsSync(path.join(modDirectory, "mod.cpp"))) {
        log(`Runtime files are missing in ${root}. Run build-all.ps1 (it bundles @SqfReloader into the extension).`);
        return undefined;
    }

    return { modDirectory };
}

/** Replaces a bundled file/folder with the freshest copy (keeps generated replacement\). */
function syncFile(source: string, target: string): void {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
}

/**
 * Deploys the bundled @SqfReloader mod into the Arma folder and links the user's mods there.
 * Returns everything needed to launch Arma.
 */
export function prepareRuntime(runtime: Runtime, armaDirectory: string, settings: Settings, workspaceMods: Mod[]): PreparedLaunch {
    const warnings: string[] = [];

    // --- 1. @SqfReloader ------------------------------------------------------
    // A plain copy, not a junction: this is the shipped mod, not a working copy. Updating the
    // extension therefore also updates the mod, the PBO and the DLL (like reinstalling it).
    const bundledMod = bundledModFolder(armaDirectory);

    try {
        if (isLink(bundledMod)) {
            fs.rmdirSync(bundledMod);
        }

        fs.mkdirSync(bundledMod, { recursive: true });
        syncFile(path.join(runtime.modDirectory, "mod.cpp"), path.join(bundledMod, "mod.cpp"));

        // mod.cpp declares logo = "logo.paa", so the logo has to sit next to it in the mod root.
        const logo = path.join(runtime.modDirectory, "logo.paa");
        if (fs.existsSync(logo)) {
            syncFile(logo, path.join(bundledMod, "logo.paa"));
        }

        const pbo = path.join(runtime.modDirectory, "addons", "scripts.pbo");
        if (fs.existsSync(pbo)) {
            syncFile(pbo, path.join(bundledMod, "addons", "scripts.pbo"));
        } else {
            warnings.push(`addons\\scripts.pbo is missing in ${runtime.modDirectory}.`);
        }

        // The DLL has to be in the MOD ROOT: a dll\\ subfolder is not searched by Arma.
        const dll = path.join(runtime.modDirectory, "SqfReloader_x64.dll");
        if (fs.existsSync(dll)) {
            syncFile(dll, path.join(bundledMod, "SqfReloader_x64.dll"));
        } else {
            warnings.push(`SqfReloader_x64.dll is missing in ${runtime.modDirectory}.`);
        }
    } catch (error) {
        warnings.push(`Could not deploy @SqfReloader to ${bundledMod}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Older layouts put the DLL next to arma3_x64.exe, inside a dll\ subfolder or in a
    // <Arma 3>\SqfReloader folder, and generated a replacement\ config for hot reload. None of
    // that is used any more, so it is cleaned up to avoid loading a stale copy.
    const legacy = [
        path.join(armaDirectory, "SqfReloader_x64.dll"),
        path.join(armaDirectory, "SqfReloader"),
        path.join(bundledMod, "dll"),
        path.join(bundledMod, "replacement"),
        path.join(bundledMod, "addons", "scripts")
    ];

    for (const stale of legacy) {
        try {
            fs.rmSync(stale, { recursive: true, force: true });
        } catch {
            // Locked by a running game: it only matters for the next launch.
        }
    }

    // --- 2. User mods -----------------------------------------------------
    // The working copy has to be visible to Arma at a stable path. $PBOPREFIX$ folders are
    // linked into z\... (or x\...) so -mod= can also point at the original mod folder.
    const modFolders: string[] = [];

    for (const mod of workspaceMods) {
        if (mod.addons.length > 0) {
            const { warnings: linkWarnings } = createLinks(armaDirectory, [mod], settings.junctionMode);
            warnings.push(...linkWarnings);

            if (settings.junctionMode === "addon") {
                // Register the mod as a module that only contains the linked addons: Arma
                // mounts one -mod= entry whose addons live under z\; the original folder is
                // still handed over for missions/config, see below.
                modFolders.push(mod.directory);
            } else {
                modFolders.push(path.join(armaDirectory, mod.name.startsWith("@") ? mod.name : `@${mod.name}`));
            }
        } else if (mod.hasModFiles) {
            modFolders.push(mod.directory);
        }
    }

    return {
        armaDirectory,
        executable: path.join(armaDirectory, "arma3_x64.exe"),
        mods: [...new Set([...modFolders, bundledMod])],
        modPath: bundledMod,
        warnings,
        userMods: workspaceMods
    };
}

/** True when the path is a junction/symlink rather than a real folder. */
function isLink(target: string): boolean {
    try {
        return fs.lstatSync(target).isSymbolicLink() || !!currentLinkTarget(target);
    } catch {
        return false;
    }
}

/** Folder where @SqfReloader is deployed inside the Arma directory. */
export function bundledModFolder(armaDirectory: string): string {
    return path.join(armaDirectory, "@SqfReloader");
}

/**
 * Links a directory; replaces a link that already points somewhere else, but never a real
 * folder (that would be user data).
 */
function linkDirectory(linkPath: string, target: string, warnings: string[]): void {
    const existing = currentLinkTarget(linkPath);

    if (existing) {
        if (path.resolve(existing).toLowerCase() === path.resolve(target).toLowerCase()) {
            return;
        }

        try {
            fs.rmdirSync(linkPath);
        } catch (error) {
            warnings.push(`Could not refresh ${linkPath}: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
    } else if (fs.existsSync(linkPath)) {
        warnings.push(`${linkPath} exists and is not a link; the bundled @SqfReloader was not linked there.`);
        return;
    }

    try {
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });

        if (process.platform === "win32") {
            require("child_process").execFileSync("cmd", ["/c", "mklink", "/J", linkPath, target], { stdio: "pipe" });
        } else {
            fs.symlinkSync(target, linkPath, "dir");
        }

        log(`Linked ${linkPath} -> ${target}`);
    } catch (error) {
        warnings.push(`Could not link ${linkPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function currentLinkTarget(linkPath: string): string | undefined {
    try {
        const stats = fs.lstatSync(linkPath);

        if (stats.isSymbolicLink()) {
            return fs.readlinkSync(linkPath);
        }

        if (stats.isDirectory()) {
            const real = fs.realpathSync(linkPath);
            return real !== path.resolve(linkPath) ? real : undefined;
        }

        return undefined;
    } catch {
        return undefined;
    }
}

/** Stops a previous SqfReloader instance so the port is free for the new launch. */
export function stopStaleArmaProcesses(armaDirectory: string): void {
    const noTaskLine = "INFO: No tasks";

    try {
        const output = require("child_process").execSync(`tasklist /FI "IMAGENAME eq arma3_x64.exe" /FO CSV /NH`, { encoding: "utf8" });

        if (output.includes("arma3_x64.exe") && !output.includes(noTaskLine)) {
            log("An Arma 3 instance is already running; the new launch will report the port as busy.");
        }
    } catch {
        // tasklist is Windows only; other platforms simply proceed.
    }
}

/** Mods that look like they belong to this workspace (for -mod= and junctions). */
export function workspaceMods(): Mod[] {
    const mods: Mod[] = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        mods.push(...findMods(folder.uri.fsPath));
    }

    return mods.filter(mod => mod.addons.length > 0 || mod.hasModFiles);
}

/** Addons of the workspace mods (used by the reloader for $PBOPREFIX$ lookups). */
export function workspaceAddons(): Addon[] {
    return workspaceMods().flatMap(mod => mod.addons);
}

/** Writes %LOCALAPPDATA%\SqfReloader\config.json so the DLL uses the configured port. */
export function writeApiConfig(settings: Settings): string {
    const directory = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.TEMP ?? ".", "SqfReloader"), "SqfReloader");
    fs.mkdirSync(directory, { recursive: true });

    const url = new URL(settings.apiUrl);
    const file = path.join(directory, "config.json");

    fs.writeFileSync(file, JSON.stringify({
        host: url.hostname || "127.0.0.1",
        port: url.port ? Number(url.port) : 8765,
        autoStart: true,
        sourceDirectory: ""
    }, null, 2), "utf8");

    log(`SqfReloader config written: ${file} (${url.hostname}:${url.port || 8765})`);
    return file;
}

/**
 * Startup call for missions that are launched outside the Eden Editor (e.g. -mission=).
 * Normally unnecessary: @SqfReloader starts itself from its own Cfg3DEN event handler.
 */
export function startupScript(): string {
    return "call SqfReloader_fnc_runStartup;";
}

/**
 * Validates that Arma can see the user's scripts: the $PBOPREFIX$ folder must resolve inside
 * the Arma folder to the working copy.
 */
export function verifyWorkspaceAddons(armaDirectory: string, addons: Addon[]): string[] {
    const warnings: string[] = [];

    for (const addon of addons) {
        const linkPath = path.join(armaDirectory, ...addon.prefix.split("\\"));
        const target = currentLinkTarget(linkPath);

        if (!target) {
            warnings.push(`${addon.prefix} is not linked in the Arma folder (${linkPath}).`);
        } else if (path.resolve(target) !== path.resolve(addon.localDirectory)) {
            warnings.push(`${addon.prefix} points to ${target} instead of ${addon.localDirectory}.`);
        }
    }

    return warnings;
}

/** True when the workspace folder is a mod (or contains one) the launcher can use. */
export function describeWorkspaceMods(mods: Mod[]): string {
    return mods.map(mod => `${mod.name} (${mod.addons.map(addon => addon.prefix).join(", ") || "no addons"})`).join(", ");
}

export function addonPrefixOf(directory: string): string | undefined {
    const addon = readAddon(directory);
    return addon ? normalizePrefix(addon.prefix) : undefined;
}
