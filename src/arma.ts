import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { Settings, log } from "./settings";

/** A source addon folder mounted by SqfReloader at its derived runtime path. */
export interface Addon {
    /** Folder containing config.cpp and/or functions (e.g. ...\MyMod\addons\core). */
    localDirectory: string;
    /**
     * SqfReloader runtime mount path `z\<tag>\addons\<addon>`, derived from CfgFunctions.
     * This is independent of the developer's PBO prefix file, which is never modified.
     */
    prefix: string;
    /**
     * Mod tag used by the SQF reloader (second segment: mymod for z\mymod\addons\core).
     * Comes from CfgFunctions `tag = "mymod"`, not from the folder name.
     */
    tag: string;
    /** Addon name (last prefix segment). */
    name: string;
    /** Folder name without the mount root, e.g. instance for z\example\addons\instance. */
    instance: string;
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

/** Path detected from the registry/Steam installs; kept in memory for this VS Code session. */
let detectedDirectory: string | undefined;
let detection: Promise<string | undefined> | undefined;

/**
 * Finds the Arma 3 folder. Order: the explicit setting, the folder detected earlier in this
 * session, the registry (Steam / retail), Steam library folders, then a few common install paths.
 */
export async function findArmaDirectory(settings: Settings): Promise<string | undefined> {
    if (settings.armaDirectory) {
        if (isArmaDirectory(settings.armaDirectory)) {
            return settings.armaDirectory;
        }

        log(`armaDirectory does not contain arma3_x64.exe: ${settings.armaDirectory}`);
    }

    const detected = await detectArmaDirectory();

    if (detected) {
        return detected;
    }

    log("Arma 3 was not found automatically.");
    return undefined;
}

/**
 * Detects Arma 3 from the registry / Steam libraries once per session and remembers the result
 * so later lookups (reload, snapshots, status) do not spawn `reg` again.
 * armaDirectory stays empty on purpose: nothing is written back to the project settings.
 */
export function detectArmaDirectory(): Promise<string | undefined> {
    if (detectedDirectory) {
        return Promise.resolve(detectedDirectory);
    }

    // Failed lookups are cached too; otherwise every reload would retry the registry.
    detection ??= detectArmaDirectoryOnce().then(directory => {
        detectedDirectory = directory;
        return directory;
    });

    return detection;
}

/** Forgets the in-memory detection so the next lookup scans the registry / Steam again. */
export function resetArmaDetection(): void {
    detectedDirectory = undefined;
    detection = undefined;
}

async function detectArmaDirectoryOnce(): Promise<string | undefined> {
    const [registryPaths, steamPaths] = await Promise.all([
        readRegistryPaths(),
        readSteamLibraryPaths()
    ]);
    const candidates = [...registryPaths, ...steamPaths, ...readCommonPaths()];

    for (const candidate of dedupe(candidates)) {
        if (isArmaDirectory(candidate)) {
            log(`Detected Arma 3 at ${candidate}`);
            return candidate;
        }
    }

    return undefined;
}

export function isArmaDirectory(directory: string): boolean {
    return ARMA_EXECUTABLES.some(exe => fs.existsSync(path.join(directory, exe)));
}

/** Reads the "main" value Arma 3 writes to the registry. */
async function readRegistryPaths(): Promise<string[]> {
    if (process.platform !== "win32") {
        return [];
    }

    // Reading HKCU/HKLM through reg.exe keeps the extension free of native modules.
    const queries: Array<[string, string]> = [
        ["HKLM\\SOFTWARE\\WOW6432Node\\Bohemia Interactive\\ArmA 3", "main"],
        ["HKLM\\SOFTWARE\\Bohemia Interactive\\ArmA 3", "main"],
        ["HKCU\\SOFTWARE\\Bohemia Interactive\\ArmA 3", "main"]
    ];

    return (await Promise.all(queries.map(async ([key, value]) => {
        try {
            const output = await executeFile("reg", ["query", key, "/v", value]);
            const match = /REG_SZ\s+(.+)$/m.exec(output);

            if (match) {
                const exe = match[1].trim();
                return fs.existsSync(exe) ? path.dirname(exe) : exe;
            }
        } catch {
            // Key not present.
        }
        return undefined;
    }))).filter((candidate): candidate is string => !!candidate);
}

/** Expands steamapps\libraryfolders.vdf of every known Steam installation. */
async function readSteamLibraryPaths(): Promise<string[]> {
    if (process.platform !== "win32") {
        return [];
    }

    const steamRoots = new Set<string>();

    try {
        const output = await executeFile("reg", ["query", "HKCU\\SOFTWARE\\Valve\\Steam", "/v", "SteamPath"]);
        const match = /REG_SZ\s+(.+)$/m.exec(output);

        if (match) {
            steamRoots.add(match[1].trim().replace(/\//g, "\\"));
        }
    } catch {
        // Steam not installed for this user.
    }

    steamRoots.add("C:\\Program Files (x86)\\Steam");

    return (await Promise.all([...steamRoots].map(async root => {
        if (!fs.existsSync(root)) return [];
        const libraries = new Set<string>([root]);
        const libraryFile = path.join(root, "steamapps", "libraryfolders.vdf");
        try {
            const content = await fs.promises.readFile(libraryFile, "utf8");
            const regex = /"path"\s+"([^"]+)"/g;
            let match: RegExpExecArray | null;

            while ((match = regex.exec(content)) !== null) {
                libraries.add(match[1].replace(/\\\\/g, "\\"));
            }
        } catch {
            // No library files, only the default folder.
        }
        return [...libraries].map(library => path.join(library, "steamapps", "common", "Arma 3"));
    }))).flat();
}

function executeFile(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { encoding: "utf8", timeout: 1500 }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
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

        // A workspace can also be a container (e.g. "<dev>\@MyMod" + "missions\"): look one
        // level deeper, but never treat "<mod>\addons\<addon>" as a separate mod.
        for (const child of safeReadDirs(root)) {
            if (isAddonFolder(child)) {
                continue;
            }

            for (const grandChild of safeReadDirs(child)) {
                if (looksLikeMod(grandChild) && !isAddonFolder(grandChild)) {
                    result.push(describeMod(grandChild));
                }
            }
        }
    }

    // A workspace can also open a single addon folder directly; no $PBOPREFIX$ is required.
    if (result.length === 0) {
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
        || fs.existsSync(path.join(directory, "functions"));
}

/**
 * True when the folder is an addon rather than a mod: it has source files but no addons\ folder
 * and is not a mod root (mod.cpp).
 */
function isAddonFolder(directory: string): boolean {
    // A source folder with no addons\ is an addon, not a mod.
    return !fs.existsSync(path.join(directory, "addons"))
        && !fs.existsSync(path.join(directory, "mod.cpp"))
        && (fs.existsSync(path.join(directory, "config.cpp")) || fs.existsSync(path.join(directory, "functions")));
}

/**
 * Mission folder names Arma understands: "<name>.<World>". The world part must look like a
 * world (Altis, VR, Tanoa, chernarus_summer), so folders such as ".vscode" or "v1.2" are not
 * mistaken for missions.
 */
const MISSION_PATTERN = /^[^.\\/][^.\\/]*\.([A-Za-z][A-Za-z0-9_]{1,})$/;

/** A mission folder found in the workspace. */
export interface MissionFolder {
    directory: string;
    /** True for mpmissions: linked into <Arma 3>\MPMissions only. */
    multiplayer: boolean;
    /** maxPlayers value from description.ext, when present. */
    maxPlayers?: number;
}

/**
 * Finds mission folders ("<name>.<World>") that belong to this workspace: the workspace
 * roots themselves and a few folders deeper, so `<dev>\missions\x.Altis` and
 * `<mod>\missions\x.Altis` are both picked up.
 *
 * `multiplayer` is true for a mission below an `mpmissions` folder (or one whose
 * description.ext only allows several players); those are linked into `<Arma 3>\MPMissions`
 * only, single-player missions go to `<Arma 3>\Missions` (and to both, so they can be hosted).
 */
export function findMissions(roots: string[]): MissionFolder[] {
    const result = new Map<string, MissionFolder>();

    const isMission = (directory: string): boolean => {
        // A mission folder holds a mission.sqm (editor) or at least a description.ext.
        return MISSION_PATTERN.test(path.basename(directory))
            && (fs.existsSync(path.join(directory, "mission.sqm")) || fs.existsSync(path.join(directory, "description.ext")));
    };

    const scan = (directory: string, depth: number, multiplayer: boolean): void => {
        for (const child of safeReadDirs(directory)) {
            const name = path.basename(child).toLowerCase();
            const isMultiplayer = multiplayer || name === "mpmissions";

            if (isMission(child)) {
                const maxPlayers = readMissionMaxPlayers(child);
                result.set(path.resolve(child).toLowerCase(), {
                    directory: child,
                    multiplayer: isMultiplayer || (maxPlayers !== undefined && maxPlayers > 1),
                    ...(maxPlayers !== undefined ? { maxPlayers } : {})
                });
            } else if (depth > 0 && !isAddonFolder(child) && name !== "addons") {
                scan(child, depth - 1, isMultiplayer);
            }
        }
    };

    for (const root of roots) {
        if (!fs.existsSync(root)) {
            continue;
        }

        // The workspace root is a mission itself, or its missions/ folder is one level down.
        if (isMission(root)) {
            const maxPlayers = readMissionMaxPlayers(root);
            result.set(path.resolve(root).toLowerCase(), {
                directory: root,
                multiplayer: path.basename(path.dirname(root)).toLowerCase() === "mpmissions"
                    || (maxPlayers !== undefined && maxPlayers > 1),
                ...(maxPlayers !== undefined ? { maxPlayers } : {})
            });
            continue;
        }

        scan(root, 2, false);
    }

    return [...result.values()];
}

/** Reads maxPlayers from a mission's Header (or the top-level description for older layouts). */
export function readMissionMaxPlayers(directory: string): number | undefined {
    const description = path.join(directory, "description.ext");
    if (!fs.existsSync(description)) return undefined;

    try {
        const content = fs.readFileSync(description, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\r\n]/g, " "))
            .replace(/^\s*\/\/.*$/gm, match => match.replace(/[^\r\n]/g, " "));
        const header = /\bclass\s+Header\s*\{([\s\S]*?)\}/i.exec(content)?.[1];
        const value = header
            ? /\bmaxPlayers\s*=\s*(\d+)\s*;/i.exec(header)?.[1]
            : /\bmaxPlayers\s*=\s*(\d+)\s*;/i.exec(content)?.[1];
        return value === undefined ? undefined : Number(value);
    } catch {
        return undefined;
    }
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
        // The folder itself is the addon (its sources lie directly inside it).
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

/**
 * Reads the addon description from a folder.
 *
 * The mount prefix is always `z\<tag>\addons\<addon>`, where
 *  * <tag>    is the `tag = "..."` of the addon's CfgFunctions block (the name the SQF side
 *              reloads as `<tag>_fnc_<name>`), falling back to the folder name, and
 *  * <addon>  is the folder name below `addons\` (or "main" for a loose folder).
 *
 * `$PBOPREFIX$` is deliberately neither read nor written. Its contents belong to the developer's
 * packaging and manual-launch setup; SqfReloader mounts sources separately under Arma's z\ tree.
 */
export function readAddon(directory: string): Addon | undefined {
    const hasSources = fs.existsSync(path.join(directory, "config.cpp"))
        || fs.existsSync(path.join(directory, "functions"));

    if (!hasSources) {
        return undefined;
    }

    const folder = path.basename(directory).toLowerCase();
    const parent = path.basename(path.dirname(directory)).toLowerCase();
    const insideAddons = parent === "addons";
    const fileName = insideAddons ? folder : "main";
    const tag = (readFunctionTag(directory) ?? (insideAddons ? folder : parent.replace(/^@/, ""))).toLowerCase();

    return {
        localDirectory: directory,
        prefix: `z\\${tag}\\addons\\${fileName}`,
        tag,
        name: fileName,
        instance: fileName
    };
}

/**
 * Tag declared in the addon's config.cpp: `class CfgFunctions { class <tag> { tag = "<tag>"; } }`.
 * Only the first CfgFunctions block is read; comments are ignored so a commented example does
 * not win.
 */
export function readFunctionTag(directory: string): string | undefined {
    for (const name of ["config.cpp", "config.bin", "description.ext"]) {
        const file = path.join(directory, name);

        if (!fs.existsSync(file)) {
            continue;
        }

        const text = stripCppComments(fs.readFileSync(file, "utf8"));
        const block = /class\s+CfgFunctions\s*\{/i.exec(text);

        if (!block) {
            continue;
        }

        const body = text.slice(block.index);
        const declared = /\btag\s*=\s*"([^"]+)"/i.exec(body);

        if (declared) {
            return declared[1].trim();
        }

        // No explicit tag: Arma uses the CfgFunctions class name.
        const className = /class\s+CfgFunctions\s*\{\s*class\s+([\w]+)/i.exec(body);

        if (className) {
            return className[1];
        }
    }

    return undefined;
}

/** Removes // and /* *\/ comments without touching string literals. */
function stripCppComments(text: string): string {
    let result = "";
    let index = 0;

    while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '"') {
            const end = text.indexOf('"', index + 1);
            const stop = end === -1 ? text.length : end + 1;
            result += text.slice(index, stop);
            index = stop;
            continue;
        }

        if (char === "/" && next === "/") {
            const end = text.indexOf("\n", index);
            index = end === -1 ? text.length : end;
            continue;
        }

        if (char === "/" && next === "*") {
            const end = text.indexOf("*/", index + 2);
            index = end === -1 ? text.length : end + 2;
            continue;
        }

        result += char;
        index++;
    }

    return result;
}

/**
 * Prefix used when a folder has no CfgFunctions tag (a plain script folder): keeps the old
 * `<addon>\addons\<addon>` shape so unrelated layouts still mount predictably.
 */
export function inferPrefix(directory: string): string {
    const name = path.basename(directory);
    const parent = path.basename(path.dirname(directory));

    if (parent.toLowerCase() === "addons") {
        return `${name}\\addons\\${name}`;
    }

    return name;
}

export function normalizePrefix(value: string): string {
    return value
        .replace(/^\uFEFF/, "")
        .replace(/[\/\\]+/g, "\\")
        .replace(/^\\+/, "")
        .replace(/\\+$/, "")
        .trim();
}

/**
 * Arma path a script is mounted at, e.g. z\tag\addons\example\functions\fn_thing.sqf.
 *
 * The addon's runtime path is derived from its CfgFunctions tag and the extension-created
 * junction in Arma's z\ tree. The developer's PBO prefix remains untouched.
 *
 * No leading backslash, like `addon.prefix` and `addonLinkPath()`: the SQF side accepts
 * both, but one convention keeps the logs and verifiers readable.
 */
export function toArmaPath(addon: Addon, filePath: string): string {
    const relative = path.relative(addon.localDirectory, filePath).replace(/[\/\\]+/g, "\\");

    if (relative.startsWith("..")) {
        // The file lies outside the addon folder: fall back to the mod-relative layout.
        const mod = findModForFile(filePath);

        if (mod) {
            const fromMod = path.relative(mod.directory, filePath).replace(/[\/\\]+/g, "\\");
            return `z\\${mod.name}\\${fromMod}`;
        }
    }

    return `${addon.prefix}\\${relative}`;
}

/**
 * Arma path any script file is reachable at, derived from the file name for the reloader: the
 * mounted addon folder first, then every conventional layout the game searches (the same
 * candidates `SqfReloader_fnc_reloadFunction` uses on the SQF side).
 *
 * fn_hello.sqf in @ExampleMod\addons\example -> \example\addons\example\fn_hello.sqf and
 * \z\example\addons\example\fn_hello.sqf etc. Used to answer "can Arma see this file?" even
 * when the addon is mounted from a different root than its configured PBO prefix.
 */
export function armaPathCandidates(addon: Addon, filePath: string): string[] {
    const relative = path.relative(addon.localDirectory, filePath).replace(/[\/\\]+/g, "\\");
    const tag = addon.tag;
    const name = addon.instance;
    const folder = path.basename(addon.localDirectory).toLowerCase();
    const normalized = relative.replace(/^functions\\/i, "");

    // The mounted path is \z\<tag>\addons\<instance>. The other entries cover mods that were
    // mounted the old ways (prefix without z\, the folder name as tag, ...).
    return dedupe([
        `\\${addon.prefix}\\${relative}`,
        `\\x\\${tag}\\addons\\${name}\\${relative}`,
        `\\${tag}\\addons\\${name}\\${relative}`,
        `\\z\\${folder}\\addons\\${name}\\${relative}`,
        `\\${folder}\\addons\\${name}\\${relative}`,
        `\\@${tag}\\addons\\${name}\\${relative}`,
        `\\@${tag}\\addons\\${folder}\\${relative}`,
        `\\${addon.prefix}\\${normalized}`
    ]);
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

/** Finds the source addon that owns a file (the deepest folder with config.cpp/functions). */
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
