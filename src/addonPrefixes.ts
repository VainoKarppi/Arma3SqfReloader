import * as fs from "fs";
import * as path from "path";
import { readAddon } from "./arma";

const PROJECT_CONFIG = path.join(".hemtt", "project.toml");
const PREFIX_FILE = "$PBOPREFIX$";

export interface MissingAddonPrefix {
    addonDirectory: string;
    /** Addon folder name, e.g. scripts. */
    addonName: string;
    /** Prefix HEMTT expects, e.g. z\example\addons\scripts. */
    prefix: string;
}

/**
 * Addons below a HEMTT project that have no `$PBOPREFIX$` file.
 *
 * HEMTT refuses to run ("Addon prefix not found: <addon>") without one, and it does not create
 * them itself. The value HEMTT expects is `<mainprefix>\<prefix>\addons\<addon>`; when the project
 * config has no prefix, SqfReloader's own mount path (`z\<tag>\addons\<addon>`) is used instead.
 */
export function findMissingAddonPrefixes(project: string): MissingAddonPrefix[] {
    const addonsRoot = path.join(project, "addons");
    if (!fs.existsSync(addonsRoot)) return [];

    const projectPrefix = readProjectPrefix(project);
    const missing: MissingAddonPrefix[] = [];

    for (const entry of readDirectory(addonsRoot)) {
        if (!entry.isDirectory()) continue;
        const addonDirectory = path.join(addonsRoot, entry.name);
        if (fs.existsSync(path.join(addonDirectory, PREFIX_FILE))) continue;

        const addon = readAddon(addonDirectory);
        if (!addon) continue;

        const prefix = projectPrefix
            ? [projectPrefix.mainprefix, projectPrefix.prefix, "addons", entry.name].filter(Boolean).join("\\")
            : addon.prefix;
        if (!prefix) continue;

        missing.push({ addonDirectory, addonName: entry.name, prefix });
    }

    return missing;
}

/** Writes the `$PBOPREFIX$` file for every entry of {@link findMissingAddonPrefixes}. */
export function writeAddonPrefixes(missing: MissingAddonPrefix[]): void {
    for (const addon of missing) {
        fs.writeFileSync(path.join(addon.addonDirectory, PREFIX_FILE), addon.prefix, "utf8");
    }
}

/** `prefix` / `mainprefix` from the project's `.hemtt/project.toml`, when they are set. */
export function readProjectPrefix(project: string): { mainprefix?: string; prefix: string } | undefined {
    let text: string;
    try {
        text = fs.readFileSync(path.join(project, PROJECT_CONFIG), "utf8");
    } catch {
        return undefined;
    }

    const value = (key: string): string | undefined => {
        const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(text);
        return match?.[1].trim() || undefined;
    };

    const prefix = value("prefix");
    if (!prefix) return undefined;
    return { mainprefix: value("mainprefix"), prefix };
}

function readDirectory(directory: string): fs.Dirent[] {
    try {
        return fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
}
