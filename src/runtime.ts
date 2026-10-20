import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findMods, Mod, normalizePrefix, readAddon, Addon } from "./arma";
import { createLinks } from "./junctions";
import { writeReplacement } from "./reloader";
import { log, logError, readSettings, Settings } from "./settings";

/**
 * Everything the extension needs at runtime ships inside the .vsix (vscode-runtime/):
 *
 *   vscode-runtime/ArmaApi_x64.dll   native extension
 *   vscode-runtime/mod/@ArmaApi/     ArmaApi mod: mod.cpp + addons\armaapi.pbo (AddonBuilder)
 *   vscode-runtime/mod/armaapi-src/  config.cpp + functions\ the PBO was built from
 *
 * Nothing has to be installed by hand: on launch the DLL is copied to a folder inside the
 * Arma directory (which is on the DLL search path of arma3_x64.exe) and @ArmaApi is linked
 * next to the game together with the user's own mod.
 *
 * ArmaApi's own SQF functions stay hot reloadable although they ship inside the PBO: the
 * extension writes @ArmaApi\replacement\armaapi\config.cpp (a file-patching config with a
 * `reloader` for every CfgFunctions class) plus a plain copy of the fn_*.sqf files
 * (src/reloader.ts), and the game runs with -filePatching.
 */
export interface Runtime {
    /** Absolute path of ArmaApi_x64.dll shipped in the VSIX. */
    dll: string;
    /** Absolute path of the bundled @ArmaApi mod (mod.cpp + addons\armaapi.pbo). */
    modDirectory: string;
    /** Absolute path of the plain SQF sources the PBO was built from. */
    sourcesDirectory: string;
}

export interface PreparedLaunch {
    armaDirectory: string;
    executable: string;
    /** Mod folders passed to -mod=. */
    mods: string[];
    /** Deployed copy of ArmaApi_x64.dll. */
    dllPath: string;
    /** Warnings that did not stop the launch. */
    warnings: string[];
    /** The mods that were found in the workspace (for hot reload). */
    userMods: Mod[];
    /**
     * True when @ArmaApi was deployed as a PBO. Arma then loads ArmaApi's SQF from the PBO,
     * so the game must run with -filePatching for the replacement config to apply.
     */
    pboRuntime: boolean;
}

export function runtimeDirectory(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, "vscode-runtime");
}

export function loadRuntime(context: vscode.ExtensionContext): Runtime | undefined {
    const root = runtimeDirectory(context);
    const dll = path.join(root, "ArmaApi_x64.dll");
    const modDirectory = path.join(root, "mod", "@ArmaApi");
    const sourcesDirectory = path.join(root, "mod", "armaapi-src");

    if (!fs.existsSync(dll) || !fs.existsSync(modDirectory) || !fs.existsSync(sourcesDirectory)) {
        log(`Runtime files are missing in ${root}. Run build-all.ps1 (it bundles the DLL, the PBO and the sources into the extension).`);
        return undefined;
    }

    return { dll, modDirectory, sourcesDirectory };
}

/**
 * Deploys the bundled DLL next to the game and links the bundled @ArmaApi mod plus the
 * user's mods into the Arma folder. Returns everything needed to launch Arma.
 */
export function prepareRuntime(runtime: Runtime, armaDirectory: string, settings: Settings, workspaceMods: Mod[]): PreparedLaunch {
    const warnings: string[] = [];

    // --- 1. DLL ------------------------------------------------------------
    // Arma searches the folder of arma3_x64.exe; a sub folder is enough and keeps the game
    // directory tidy. A copy also goes into @ArmaApi\dll\ (the place the standalone installer
    // uses) once the mod is linked below.
    const toolDirectory = path.join(armaDirectory, "ArmaApi");
    fs.mkdirSync(toolDirectory, { recursive: true });

    const dllTarget = path.join(armaDirectory, "ArmaApi_x64.dll");
    const dllInTool = path.join(toolDirectory, "ArmaApi_x64.dll");

    for (const target of [dllTarget, dllInTool]) {
        try {
            fs.copyFileSync(runtime.dll, target);
        } catch (error) {
            warnings.push(`Could not copy ArmaApi_x64.dll to ${target}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // --- 2. ArmaApi mod ---------------------------------------------------
    const bundledMod = bundledModFolder(armaDirectory);
    linkDirectory(bundledMod, runtime.modDirectory, warnings);

    // The mod is linked by now, so the copy lands inside @ArmaApi instead of creating a
    // plain "dll" folder that would then block the junction.
    const dllInMod = path.join(bundledMod, "dll", "ArmaApi_x64.dll");

    try {
        fs.mkdirSync(path.dirname(dllInMod), { recursive: true });
        fs.copyFileSync(runtime.dll, dllInMod);
    } catch (error) {
        warnings.push(`Could not copy ArmaApi_x64.dll to ${dllInMod}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // --- 2b. Keep ArmaApi's own SQF hot reloadable -------------------------
    // The addon ships as a PBO; the replacement config (file patching) points CfgFunctions at
    // generated reloader scripts in @ArmaApi\replacement so a save recompiles the class.
    const pboRuntime = fs.existsSync(path.join(runtime.modDirectory, "addons", "armaapi.pbo"));

    if (pboRuntime) {
        try {
            const prefix = normalizePrefix(fs.readFileSync(path.join(runtime.sourcesDirectory, "$PBOPREFIX$"), "utf8"));
            writeReplacement({
                modDirectory: bundledMod,
                prefix: prefix || "z\\armaapi\\addons\\armaapi",
                sourcesDirectory: runtime.sourcesDirectory
            });
        } catch (error) {
            warnings.push(`Could not prepare the file-patching config for @ArmaApi: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // --- 3. User mods -----------------------------------------------------
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
        mods: [...new Set([...modFolders.map(folder => folder), bundledMod])],
        dllPath: dllTarget,
        warnings,
        userMods: workspaceMods,
        pboRuntime
    };
}

/** Folder where @ArmaApi is linked inside the Arma directory. */
export function bundledModFolder(armaDirectory: string): string {
    return path.join(armaDirectory, "@ArmaApi");
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
        warnings.push(`${linkPath} exists and is not a link; the bundled @ArmaApi was not linked there.`);
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

/** Stops a previous ArmaApi instance so the port is free for the new launch. */
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

/** Writes %LOCALAPPDATA%\ArmaApi\config.json so the DLL uses the configured port. */
export function writeApiConfig(settings: Settings): string {
    const directory = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.TEMP ?? ".", "ArmaApi"), "ArmaApi");
    fs.mkdirSync(directory, { recursive: true });

    const url = new URL(settings.apiUrl);
    const file = path.join(directory, "config.json");

    fs.writeFileSync(file, JSON.stringify({
        host: url.hostname || "127.0.0.1",
        port: url.port ? Number(url.port) : 8765,
        autoStart: true,
        sourceDirectory: ""
    }, null, 2), "utf8");

    log(`ArmaApi config written: ${file} (${url.hostname}:${url.port || 8765})`);
    return file;
}

/**
 * Startup call for missions that are launched outside the Eden Editor (e.g. -mission=).
 * Normally unnecessary: @ArmaApi starts itself from its own Cfg3DEN event handler.
 */
export function startupScript(): string {
    return "call ArmaApi_fnc_runStartup;";
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
