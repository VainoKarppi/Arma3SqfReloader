import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { Settings, log } from "./settings";

/**
 * Locating the Arma 3 installation: the explicit `armaDirectory` setting, a result cached for the
 * VS Code session, the registry (Steam or retail), Steam library folders and a few common paths.
 * Kept apart from arma.ts, which parses mods, missions and CfgFunctions.
 */

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

/**
 * The folder detected earlier in this session, without starting a new registry/Steam lookup.
 * Used on shutdown, where spawning a detection process would delay VS Code closing.
 */
export function cachedArmaDirectory(): string | undefined {
    return detectedDirectory;
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

    for (const candidate of uniqueValues(candidates)) {
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

/** Keeps the first occurrence of every non-empty value. */
export function uniqueValues(values: string[]): string[] {
    return [...new Set(values.filter(value => !!value))];
}
