import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Settings, log } from "./settings";

/** A folder that Arma mounts, described by its $PBOPREFIX$. */
export interface Addon {
    /** Folder that contains $PBOPREFIX$ (e.g. ...\MyMod\addons\core). */
    localDirectory: string;
    /** Prefix from $PBOPREFIX$, e.g. z\mymod\addons\core. */
    prefix: string;
    /**
     * Mod tag used by the SQF reloader (second segment: mymod for z\mymod\addons\core).
     * The first segment is the mount root (z, x) and is not a tag.
     */
    tag: string;
    /** Addon name (last prefix segment). */
    name: string;
}

/** A mod folder that can be handed to Arma (-mod=). */
export interface Mod {
    /** Folder that contains addons/ and config.cpp, e.g. ...\@MyMod. */
    directory: string;
    /** Folder name, e.g. @MyMod. */
    name: string;
    /** Addon folders found below directory/addons. */
    addons: Addon[];
    /** True when directory/mod.cpp or config.cpp exists at the top level of the mod. */
    hasModFiles: boolean;
}

const ARMA_EXECUTABLES = ["arma3_x64.exe", "arma3.exe", "arma3server_x64.exe"];

/**
 * Finds the Arma 3 folder. Order: the explicit setting, the registry (Steam / retail),
 * Steam library folders, then a few common install paths.
 */
export async function findArmaDirectory(settings: Settings): Promise<string | undefined> {
    if (settings.armaDirectory) {
        if (isArmaDirectory(settings.armaDirectory)) {
            return settings.armaDirectory;
        }

        log(`sqfReloader.armaDirectory does not contain arma3_x64.exe: ${settings.armaDirectory}`);
    }

    const candidates = [...readRegistryPaths(), ...readSteamLibraryPaths(), ...readCommonPaths()];

    for (const candidate of dedupe(candidates)) {
        if (isArmaDirectory(candidate)) {
            log(`Detected Arma 3 at ${candidate}`);
            return candidate;
        }
    }

    log("Arma 3 was not found automatically.");
    return undefined;
}

export function isArmaDirectory(directory: string): boolean {
    return ARMA_EXECUTABLES.some(exe => fs.existsSync(path.join(directory, exe)));
}

/** Reads the "main" value Arma 3 writes to the registry. */
function readRegistryPaths(): string[] {
    const result: string[] = [];

    if (process.platform !== "win32") {
        return result;
    }

    // Reading HKCU/HKLM through reg.exe keeps the extension free of native modules.
    const queries: Array<[string, string]> = [
        ["HKLM\\SOFTWARE\\WOW6432Node\\Bohemia Interactive\\ArmA 3", "main"],
        ["HKLM\\SOFTWARE\\Bohemia Interactive\\ArmA 3", "main"],
        ["HKCU\\SOFTWARE\\Bohemia Interactive\\ArmA 3", "main"]
    ];

    for (const [key, value] of queries) {
        try {
            const output = require("child_process").execSync(`reg query "${key}" /v ${value}`, { encoding: "utf8" });
            const match = /REG_SZ\s+(.+)$/m.exec(output);

            if (match) {
                const exe = match[1].trim();
                result.push(fs.existsSync(exe) ? path.dirname(exe) : exe);
            }
        } catch {
            // Key not present.
        }
    }

    return result;
}

/** Expands steamapps\libraryfolders.vdf of every known Steam installation. */
function readSteamLibraryPaths(): string[] {
    const result: string[] = [];

    if (process.platform !== "win32") {
        return result;
    }

    const steamRoots = new Set<string>();

    try {
        const output = require("child_process").execSync('reg query "HKCU\\SOFTWARE\\Valve\\Steam" /v SteamPath', { encoding: "utf8" });
        const match = /REG_SZ\s+(.+)$/m.exec(output);

        if (match) {
            steamRoots.add(match[1].trim().replace(/\//g, "\\"));
        }
    } catch {
        // Steam not installed for this user.
    }

    steamRoots.add("C:\\Program Files (x86)\\Steam");

    for (const root of steamRoots) {
        if (!fs.existsSync(root)) {
            continue;
        }

        const libraries = new Set<string>([root]);
        const libraryFile = path.join(root, "steamapps", "libraryfolders.vdf");

        try {
            const content = fs.readFileSync(libraryFile, "utf8");
            const regex = /"path"\s+"([^"]+)"/g;
            let match: RegExpExecArray | null;

            while ((match = regex.exec(content)) !== null) {
                libraries.add(match[1].replace(/\\\\/g, "\\"));
            }
        } catch {
            // No library files, only the default folder.
        }

        for (const library of libraries) {
            result.push(path.join(library, "steamapps", "common", "Arma 3"));
        }
    }

    return result;
}

function readCommonPaths(): string[] {
    const drivers = ["C:", "D:", "E:", "F:", "G:"];

    return drivers.map(drive => `${drive}\\SteamLibrary\\steamapps\\common\\Arma 3`);
}

function dedupe(values: string[]): string[] {
    return [...new Set(values.filter(value => !!value))];
}

/**
 * Finds mods (folders with addons/) below a workspace folder. The workspace root itself is
 * included when it already contains addons, otherwise direct child folders are checked.
 */
export function findMods(root: string): Mod[] {
    const result: Mod[] = [];

    if (!fs.existsSync(root)) {
        return result;
    }

    if (looksLikeMod(root)) {
        result.push(describeMod(root));
    } else {
        for (const child of safeReadDirs(root)) {
            if (looksLikeMod(child)) {
                result.push(describeMod(child));
            }
        }
    }

    // A workspace can also open a single addon folder (contains $PBOPREFIX$).
    if (result.length === 0 && fs.existsSync(path.join(root, "$PBOPREFIX$"))) {
        const addon = readAddon(root);

        if (addon) {
            result.push({
                directory: path.dirname(path.dirname(root)),
                name: path.basename(path.dirname(path.dirname(root))),
                addons: [addon],
                hasModFiles: false
            });
        }
    }

    return result;
}

/** True when the folder is a mod root (@Mod) or a single addon. */
export function looksLikeMod(directory: string): boolean {
    return fs.existsSync(path.join(directory, "addons"))
        || fs.existsSync(path.join(directory, "config.cpp"))
        || fs.existsSync(path.join(directory, "mod.cpp"))
        || fs.existsSync(path.join(directory, "$PBOPREFIX$"));
}

/** Looks for the mod that contains the given file by walking up from it. */
export function findModForFile(filePath: string): Mod | undefined {
    let directory = path.dirname(filePath);

    while (true) {
        if (looksLikeMod(directory)) {
            return describeMod(directory);
        }

        const parent = path.dirname(directory);
        if (parent === directory) {
            return undefined;
        }

        directory = parent;
    }
}

function describeMod(directory: string): Mod {
    const addonsRoot = path.join(directory, "addons");
    const addons: Addon[] = [];

    if (fs.existsSync(addonsRoot)) {
        for (const child of safeReadDirs(addonsRoot)) {
            const addon = readAddon(child);
            if (addon) {
                addons.push(addon);
            }
        }
    } else {
        // The folder itself is the addon ($PBOPREFIX$ directly inside it).
        const addon = readAddon(directory);
        if (addon) {
            addons.push(addon);
        }
    }

    return {
        directory,
        name: path.basename(directory),
        addons,
        hasModFiles: fs.existsSync(path.join(directory, "mod.cpp")) || fs.existsSync(path.join(directory, "config.cpp"))
    };
}

/** Reads the addon description from a folder, if it has a valid $PBOPREFIX$. */
export function readAddon(directory: string): Addon | undefined {
    const prefixFile = path.join(directory, "$PBOPREFIX$");

    if (!fs.existsSync(prefixFile)) {
        return undefined;
    }

    const prefix = normalizePrefix(fs.readFileSync(prefixFile, "utf8"));
    const segments = prefix.split("\\").filter(Boolean);

    if (segments.length < 1) {
        return undefined;
    }

    // z\mymod\addons\core -> tag "mymod"; the first segment (z/x) is the mount root.
    // A $PBOPREFIX$ without a mount root (mymod\addons\core) still names its tag first.
    const first = segments[0].toLowerCase();
    const tagIsFirst = first !== "z" && first !== "x";
    const tag = tagIsFirst || segments.length < 2 ? segments[0] : segments[1];

    return {
        localDirectory: directory,
        prefix,
        tag: tag.toLowerCase(),
        name: (segments[segments.length - 1] ?? path.basename(directory)).toLowerCase()
    };
}

export function normalizePrefix(value: string): string {
    return value
        .replace(/^\uFEFF/, "")
        .replace(/[\/\\]+/g, "\\")
        .replace(/^\\+/, "")
        .replace(/\\+$/, "")
        .trim();
}

/** Arma path of a script inside an addon, e.g. \z\tag\addons\core\fn_thing.sqf. */
export function toArmaPath(addon: Addon, filePath: string): string {
    const relative = path.relative(addon.localDirectory, filePath).replace(/[\/\\]+/g, "\\");
    return `\\${addon.prefix}\\${relative}`;
}

/** Mission variable for a function file, e.g. fn_reload -> Tag_fnc_reload (undefined when not a fn_*.sqf). */
export function toFunctionVariable(addon: Addon, filePath: string): string | undefined {
    const fileName = path.basename(filePath);

    if (!/^fn_[\w-]+\.sqf$/i.test(fileName)) {
        return undefined;
    }

    const functionName = fileName.slice(3, -4);
    return `${addon.tag}_fnc_${functionName}`;
}

/** Finds the addon that owns a file (the deepest $PBOPREFIX$ above it). */
export function findAddonForFile(filePath: string): Addon | undefined {
    let directory = path.dirname(filePath);

    while (true) {
        const addon = readAddon(directory);

        if (addon) {
            return addon;
        }

        const parent = path.dirname(directory);
        if (parent === directory) {
            return undefined;
        }

        directory = parent;
    }
}

export function safeReadDirs(directory: string): string[] {
    try {
        return fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory() || isJunction(entry))
            .map(entry => path.join(directory, entry.name));
    } catch {
        return [];
    }
}

function isJunction(entry: fs.Dirent): boolean {
    // Junctions report as symlinks on some Node versions and as directories on others.
    try {
        return entry.isSymbolicLink();
    } catch {
        return false;
    }
}

export async function pickArmaDirectory(settings: Settings): Promise<string | undefined> {
    const detected = await findArmaDirectory(settings);

    if (detected) {
        return detected;
    }

    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: "Use this Arma 3 folder",
        title: "Select the Arma 3 folder (contains arma3_x64.exe)"
    });

    if (!picked || picked.length === 0) {
        return undefined;
    }

    return picked[0].fsPath;
}
