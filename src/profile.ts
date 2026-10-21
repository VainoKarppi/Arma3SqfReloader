import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ArmaProfileSelection {
    /** Folder containing the profile's missions and mpmissions directories. */
    directory: string;
    /** Profile name to pass to Arma when the choice was inferred rather than explicit. */
    launchName?: string;
    reason: string;
}

/**
 * Resolve the profile directory used by the extension-launched game. Arma documents -name as
 * the profile selector and -profiles as the profile storage root. Without either, use the most
 * recently updated local profile and pass its name to Arma so the selected mission folder and
 * the profile actually loaded by the game stay in sync.
 */
export function selectArmaProfile(armaDirectory: string, launchArguments: string): ArmaProfileSelection {
    const explicitName = getArgument(launchArguments, "name");
    const customRoot = getArgument(launchArguments, "profiles");

    if (customRoot) {
        const root = path.isAbsolute(customRoot) ? customRoot : path.resolve(armaDirectory, customRoot);
        if (explicitName) {
            const named = path.join(root, explicitName);
            const directory = fs.existsSync(named) || !hasProfileFile(root, explicitName) ? named : root;
            return { directory, reason: `-profiles and -name=${explicitName}` };
        }

        return { directory: root, reason: `-profiles=${customRoot}` };
    }

    const documents = documentsDirectory();
    const defaultDirectory = path.join(documents, "Arma 3");

    if (explicitName) {
        return {
            directory: path.join(documents, "Arma 3 - Other Profiles", sanitizeProfileName(explicitName)),
            reason: `-name=${explicitName}`
        };
    }

    const candidates = [profileCandidate(defaultDirectory, undefined)];
    const otherProfiles = path.join(documents, "Arma 3 - Other Profiles");

    try {
        for (const entry of fs.readdirSync(otherProfiles, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const profileName = entry.name;
            const candidate = profileCandidate(path.join(otherProfiles, profileName), profileName);
            if (candidate) candidates.push(candidate);
        }
    } catch {
        // The default profile is still a valid fallback when Other Profiles is absent.
    }

    const selected = candidates
        .filter((candidate): candidate is ProfileCandidate => candidate !== undefined)
        .sort((a, b) => b.lastUsed - a.lastUsed)[0];

    if (selected) {
        return {
            directory: selected.directory,
            ...(selected.name ? { launchName: selected.name } : {}),
            reason: selected.name ? `most recently updated profile (${selected.name})` : "default profile"
        };
    }

    return { directory: defaultDirectory, reason: "default profile (no existing profile file found)" };
}

interface ProfileCandidate {
    directory: string;
    name?: string;
    lastUsed: number;
}

function profileCandidate(directory: string, name: string | undefined): ProfileCandidate | undefined {
    let files: string[];
    try {
        files = fs.readdirSync(directory).filter(file => /\.arma3profile$/i.test(file));
    } catch {
        return undefined;
    }

    if (files.length === 0) return undefined;

    let lastUsed = 0;
    for (const file of files) {
        try {
            lastUsed = Math.max(lastUsed, fs.statSync(path.join(directory, file)).mtimeMs);
        } catch {
            // Ignore profile files removed while enumerating.
        }
    }

    return { directory, ...(name ? { name } : {}), lastUsed };
}

function hasProfileFile(directory: string, name: string): boolean {
    return fs.existsSync(path.join(directory, `${sanitizeProfileName(name)}.Arma3Profile`));
}

function getArgument(argumentsText: string, name: string): string | undefined {
    const expression = new RegExp(`(?:^|\\s)-${name}=(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, "i");
    const match = expression.exec(argumentsText);
    return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
}

function sanitizeProfileName(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "_").trim();
}

function documentsDirectory(): string {
    if (process.platform === "win32") {
        try {
            const output = require("child_process").execSync(
                'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v Personal',
                { encoding: "utf8" }
            ) as string;
            const match = /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(output);
            if (match) {
                return match[1].trim().replace(/%([^%]+)%/g, (_token, key: string) => process.env[key] ?? `%${key}%`);
            }
        } catch {
            // Fall back to the usual Documents directory.
        }
    }

    return path.join(os.homedir(), "Documents");
}
