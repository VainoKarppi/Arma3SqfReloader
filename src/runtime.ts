import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findMods, findMissions, Mod, normalizePrefix, readAddon, Addon, toArmaPath, toFunctionVariable } from "./arma";
import { createLinks, addonLinkPath, linkMissions, removeModInZLink } from "./junctions";
import { DEFAULT_HOST, DEFAULT_PORT, findFreePort } from "./ports";
import { log, logError, readSettings, Settings } from "./settings";
import { ArmaProfileSelection, selectArmaProfile } from "./profile";

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
/** Port SqfReloader answered on during this VS Code session (from config.json/last launch). */
let activePort: number | undefined;

/** Port the last written API config used, or undefined before the first launch/setup. */
export function currentApiPort(): number | undefined {
    return activePort;
}

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
    /** Profile folder containing the mission links, plus an inferred profile name if needed. */
    profile: ArmaProfileSelection;
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
export function prepareRuntime(runtime: Runtime, armaDirectory: string, settings: Settings, mods: Mod[]): PreparedLaunch {
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
    // The working copy has to be visible to Arma at a stable path. Addons are linked into
    // SqfReloader's z\... runtime tree; developer PBO-prefix files are left untouched.
    const modFolders: string[] = [];

    for (const mod of mods) {
        const open = openModFolder(armaDirectory, mod);
        if (!open) {
            continue;
        }

        if (mod.addons.length > 0) {
            const { warnings: linkWarnings } = createLinks(armaDirectory, [mod], settings.junctionMode);
            warnings.push(...linkWarnings);

            // No <Arma 3>\z\@Mod junction: it duplicated the mod at z\@ExampleMod next to the
            // addon link at z\<tag>\addons\<addon>, so Arma listed the same files twice and the
            // reloader could pick the copy that was not refreshed. The addon link below z\ is
            // the single mount point; -mod= mounts the workspace @Mod folder directly.
            removeModInZLink(armaDirectory, mod);
            modFolders.push(mod.directory);
        }

        // The -mod= entry is the workspace @Mod folder itself (or the generated one when the
        // folder has no mod.cpp), so Arma reads addons from the junctioned working copy.
        modFolders.push(open);
    }

    // --- 3. Missions -------------------------------------------------------
    // Mission folders belong to the selected user profile, not the Arma install directory.
    const missions = findMissions((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath));
    const profile = selectArmaProfile(armaDirectory, settings.extraLaunchArguments, settings.armaProfile);
    const missionLinks = linkMissions(armaDirectory, profile.directory, missions);
    warnings.push(...missionLinks.warnings);

    log(`Arma profile mission folder: ${profile.directory} (${profile.reason}).`);
    if (missions.length > 0) {
        log(`Mission links: ${missionLinks.links.map(link => link.linkPath).join(", ")}`);
    }

    return {
        armaDirectory,
        executable: path.join(armaDirectory, "arma3_x64.exe"),
        mods: [...new Set([...modFolders, bundledMod])],
        modPath: bundledMod,
        warnings,
        userMods: mods,
        profile
    };
}

/** True when the path is a junction/symlink rather than a real folder. */
export function isLink(target: string): boolean {
    return currentLinkTarget(target) !== undefined;
}

/** Folder where @SqfReloader is deployed inside the Arma directory. */
export function bundledModFolder(armaDirectory: string): string {
    return path.join(armaDirectory, "@SqfReloader");
}

/** Folder name of a mod as Arma expects it: @ExampleMod, @My-Mod, ... */
export function modFolderName(mod: Mod): string {
    return mod.name.startsWith("@") ? mod.name : `@${mod.name}`;
}

/**
 * Folder where the user's mod is handed to Arma (-mod=).
 *
 * A bare addon folder (`addons\example`, or a prefix without a mount root) must never be
 * linked at its source prefix path - that used to produce `<Arma 3>\example\addons\example`,
 * which Arma does not mount. Instead a real @Mod folder is created next to the bundled mod:
 *
 *   <Arma 3>\@ExampleMod\mod.cpp       generated (name = "ExampleMod")
 *   <Arma 3>\@ExampleMod\addons\example -> <workspace>\@ExampleMod\addons\example
 *
 * and, in `addon` junction mode, `<Arma 3>\z\example\addons\example` points at the same
 * working copy so the reloader can resolve `z\<tag>\addons\<name>\...`.
 */
function openModFolder(armaDirectory: string, mod: Mod): string | undefined {
    // A folder that already is a proper mod (@Mod with mod.cpp or config.cpp) is passed as is.
    if (mod.hasModFiles) {
        return mod.directory;
    }

    const target = path.join(armaDirectory, modFolderName(mod));
    const addonsFolder = path.join(target, "addons");

    try {
        if (isLink(target)) {
            fs.rmdirSync(target);
        }

        fs.mkdirSync(addonsFolder, { recursive: true });

        const modCpp = path.join(target, "mod.cpp");
        const modCppContent = `name = "${path.basename(mod.directory)}";\n`;

        if (!fs.existsSync(modCpp) || fs.readFileSync(modCpp, "utf8") !== modCppContent) {
            fs.writeFileSync(modCpp, modCppContent, "utf8");
        }

        for (const addon of mod.addons) {
            const linkPath = path.join(addonsFolder, path.basename(addon.localDirectory));
            linkDirectory(linkPath, addon.localDirectory, []);
        }

        log(`Mod folder: ${target} -> ${mod.directory}`);
        return target;
    } catch (error) {
        log(`Could not prepare ${target}: ${error instanceof Error ? error.message : String(error)}`);
        return mod.directory;
    }
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

/** Addons of the workspace mods, discovered from config.cpp/functions source folders. */
export function workspaceAddons(): Addon[] {
    return workspaceMods().flatMap(mod => mod.addons);
}

/**
 * Writes %LOCALAPPDATA%\SqfReloader\config.json so the DLL uses the configured port.
 *
 * `pboPrefixes` is a legacy API field containing SqfReloader's derived z\ runtime paths, not
 * developer `$PBOPREFIX$` values. The API uses these paths to map function tags to addons.
 *
 * When the preferred port is taken - 8764 is also used by other Arma tooling such as
 * EdenOnline, and Windows then refuses the HttpListener prefix with "conflicts with an
 * existing registration on the machine" - the first free port is written instead. The chosen
 * port is also exposed through {@link currentApiPort} so every request targets the same one.
 *
 * `probe` skips the check while Arma is running: the game itself holds the port then.
 */
export async function writeApiConfig(settings: Settings, probe = true): Promise<number> {
    const directory = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.TEMP ?? ".", "SqfReloader"), "SqfReloader");
    fs.mkdirSync(directory, { recursive: true });

    const url = new URL(settings.apiUrl);
    const host = url.hostname || DEFAULT_HOST;
    const preferredPort = url.port ? Number(url.port) : DEFAULT_PORT;
    const port = probe ? await findFreePort(preferredPort, host) : (activePort ?? preferredPort);

    if (probe && port !== preferredPort) {
        log(`Port ${preferredPort} is already in use (another Arma tool or a previous SqfReloader run); using ${port}.`);
    }

    activePort = port;
    const file = path.join(directory, "config.json");
    const addons = workspaceAddons();
    const pboPrefixes = addons.map(addon => addon.prefix.replace(/\\/g, "/"));
    const workspaceFunctions: [string, string][] = [];

    for (const addon of addons) {
        const visit = (sourceDirectory: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(sourceDirectory, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const sourcePath = path.join(sourceDirectory, entry.name);
                if (entry.isDirectory()) {
                    visit(sourcePath);
                    continue;
                }

                if (!entry.isFile() || !/^fn_[\w-]+\.sqf$/i.test(entry.name)) continue;
                const variable = toFunctionVariable(addon, sourcePath);
                if (variable) workspaceFunctions.push([variable, toArmaPath(addon, sourcePath)]);
            }
        };

        visit(addon.localDirectory);
    }

    fs.writeFileSync(file, JSON.stringify({
        host,
        port,
        autoStart: true,
        sourceDirectory: "",
        pboPrefixes,
        workspaceFunctions
    }, null, 2), "utf8");

    log(`SqfReloader config written: ${file} (${host}:${port}); addons: ${pboPrefixes.join(", ") || "none"}; functions: ${workspaceFunctions.length}`);
    return port;
}

/**
 * Startup call for a mission after Arma creates its missionNamespace (including Eden Preview).
 * The Cfg3DEN handler starts the API in the editor namespace; mission startup must register the
 * functions again after the editor-to-mission transition.
 */
export function startupScript(): string {
    return "[] call SqfReloader_fnc_runStartup; [] call SqfReloader_fnc_reloadFunctions;";
}

/**
 * Validates that Arma can see the user's scripts through SqfReloader's z\ runtime links.
 */
export function verifyWorkspaceAddons(armaDirectory: string, addons: Addon[]): string[] {
    const warnings: string[] = [];

    for (const addon of addons) {
        const linkPath = addonLinkPath(armaDirectory, addon);
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
