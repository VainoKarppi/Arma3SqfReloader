import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { Addon, MissionFolder, Mod } from "./arma";
import { JunctionMode, log } from "./settings";

/** A link created (or found) by this extension. */
export interface Link {
    /** Path Arma resolves (inside the Arma folder). */
    linkPath: string;
    /** Folder on disk that the link points to. */
    target: string;
    kind: "junction" | "directory-symlink" | "existing";
}

export interface LinkResult {
    links: Link[];
    warnings: string[];
}

interface Registration {
    linkPath: string;
    target: string;
}

const REGISTRY_FILE = ".sqfreloader-links.json";

/**
 * Links the mod into the Arma folder so both Arma and the reloader read the files from the
 * working copy. Default layout is `addon`: every addon folder becomes
 * `<arma>\z\<tag>\addons\<addon>` (tag read from CfgFunctions). `module` mode links the whole
 * @Mod folder into the Arma root instead.
 */
export function createLinks(armaDirectory: string, mods: Mod[], mode: JunctionMode): LinkResult {
    const links: Link[] = [];
    const warnings: string[] = [];

    for (const mod of mods) {
        if (mode === "module") {
            const linkPath = path.join(armaDirectory, mod.name.startsWith("@") ? mod.name : `@${mod.name}`);
            const link = ensureDirectoryLink(linkPath, mod.directory, warnings);

            if (link) {
                links.push(link);
            }

            continue;
        }

        for (const addon of mod.addons) {
            const linkPath = addonLinkPath(armaDirectory, addon);
            const link = ensureDirectoryLink(linkPath, addon.localDirectory, warnings);

            if (link) {
                links.push(link);
            }
        }
    }

    registerLinks(armaDirectory, links);
    return { links, warnings };
}

const MOUNT_ROOTS = ["z", "x"];

/**
 * Path in the Arma folder where an addon is linked so both Arma and the reloader see the
 * working copy: `<Arma 3>\z\<tag>\addons\<addon>`.
 *
 * `addon.prefix` is already that layout (`readAddon` builds it from the CfgFunctions tag), so
 * a prefix that starts with z\ or x\ is used verbatim. A bare prefix is placed below z\ -
 * joining it onto the Arma root produced the bogus `<Arma 3>\example\addons\example`.
 */
export function addonLinkPath(armaDirectory: string, addon: Addon): string {
    const segments = addon.prefix.split("\\").filter(Boolean);

    if (segments.length > 0 && MOUNT_ROOTS.includes(segments[0].toLowerCase())) {
        return path.join(armaDirectory, ...segments);
    }

    return path.join(armaDirectory, "z", ...segments);
}

/**
 * Removes the `<Arma 3>\z\@<Mod>` junction that older versions created.
 *
 * The whole mod folder must NOT be mounted below z\: the addon is already linked at
 * `z\<tag>\addons\<addon>`, so a second copy at `z\@ExampleMod\addons\example` made Arma list
 * every file twice and left two paths for the reloader to choose from. The workspace @Mod
 * folder is passed to Arma through -mod= instead.
 */
export function removeModInZLink(armaDirectory: string, mod: Mod): boolean {
    const name = mod.name.startsWith("@") ? mod.name : `@${mod.name}`;
    const linkPath = path.join(armaDirectory, "z", name);

    // Only a junction created by us is removed, never a real folder.
    if (!readLinkTarget(linkPath)) {
        return false;
    }

    const removed = removeLink(linkPath);

    if (removed) {
        // Drop a stale z\ entry so the z\ mount root does not stay behind empty.
        try {
            if (fs.existsSync(path.join(armaDirectory, "z")) && fs.readdirSync(path.join(armaDirectory, "z")).length === 0) {
                fs.rmdirSync(path.join(armaDirectory, "z"));
            }
        } catch {
            // Not empty (other links live there) - nothing to do.
        }
    }

    return removed;
}

/** Creates the link unless the path is already correct. */
function ensureDirectoryLink(linkPath: string, target: string, warnings: string[], replace = false): Link | undefined {
    const resolvedTarget = path.resolve(target);

    if (fs.existsSync(linkPath)) {
        const currentTarget = readLinkTarget(linkPath);

        // Windows paths are case-insensitive and mklink stores the target as typed.
        if (currentTarget && path.resolve(currentTarget).toLowerCase() === resolvedTarget.toLowerCase()) {
            log(`Link already in place: ${linkPath} -> ${currentTarget}`);
            return { linkPath, target: resolvedTarget, kind: "existing" };
        }

        // A mission link that points at an older copy is refreshed; a real folder is never
        // touched, because it is user data.
        if (replace && currentTarget) {
            try {
                fs.rmdirSync(linkPath);
                log(`Refreshed link: ${linkPath} (${currentTarget} -> ${resolvedTarget})`);
            } catch (error) {
                warnings.push(`Could not refresh ${linkPath}: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
        } else {
            warnings.push(`${linkPath} already exists and points to ${currentTarget ?? "a real folder"}; it was left untouched. Remove it if it should be linked to ${resolvedTarget}.`);
            return undefined;
        }
    }

    try {
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });

        if (process.platform === "win32") {
            // Directory junctions do not need elevated privileges or developer mode.
            execFileSync("cmd", ["/c", "mklink", "/J", linkPath, resolvedTarget], { stdio: "pipe" });
            log(`Junction created: ${linkPath} -> ${resolvedTarget}`);
            return { linkPath, target: resolvedTarget, kind: "junction" };
        }

        fs.symlinkSync(resolvedTarget, linkPath, "dir");
        log(`Directory symlink created: ${linkPath} -> ${resolvedTarget}`);
        return { linkPath, target: resolvedTarget, kind: "directory-symlink" };
    } catch (error) {
        warnings.push(`Could not create the link ${linkPath}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

/** Reads the target of a junction or symlink, or undefined for a real directory. */
export function readLinkTarget(linkPath: string): string | undefined {
    try {
        const stats = fs.lstatSync(linkPath);

        if (!stats.isSymbolicLink() && !stats.isDirectory()) {
            return undefined;
        }

        if (stats.isSymbolicLink()) {
            return fs.readlinkSync(linkPath);
        }

        // Junctions are reported as directories; fs.realpath resolves them.
        const real = fs.realpathSync(linkPath);
        return real !== path.resolve(linkPath) ? real : undefined;
    } catch {
        return undefined;
    }
}

/** Removes a link created by this extension (never a real folder). */
export function removeLink(linkPath: string): boolean {
    if (!readLinkTarget(linkPath)) {
        return false;
    }

    try {
        // rmdir removes the reparse point without touching the target.
        fs.rmdirSync(linkPath);
        log(`Removed link: ${linkPath}`);
        return true;
    } catch (error) {
        log(`Could not remove ${linkPath}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

export function registryPath(armaDirectory: string): string {
    return path.join(armaDirectory, REGISTRY_FILE);
}

function registerLinks(armaDirectory: string, links: Link[]): void {
    if (links.length === 0) {
        return;
    }

    const file = registryPath(armaDirectory);
    const existing = readRegistry(armaDirectory);
    const merged = new Map<string, Registration>();

    for (const entry of [...existing, ...links.map(link => ({ linkPath: link.linkPath, target: link.target }))]) {
        merged.set(entry.linkPath.toLowerCase(), entry);
    }

    try {
        fs.writeFileSync(file, JSON.stringify([...merged.values()], null, 2), "utf8");
    } catch (error) {
        log(`Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Links the workspace missions into `<Arma 3>\Missions` and `<Arma 3>\MPMissions` so they show
 * up in the editor's mission lists without copying.
 *
 * Missions are linked into both the selected profile and the Arma install root. A mission from
 * an `mpmissions` folder is linked into `MPMissions` only; a single-player mission goes to both.
 *
 * These are plain directory junctions created here (not registered in the link registry):
 * unlike the addon links they are re-done on every launch, and the registry is what
 * "uninstall" removes.
 */
export function linkMissions(armaDirectory: string, profileDirectory: string, missions: MissionFolder[]): LinkResult {
    const links: Link[] = [];
    const warnings: string[] = [];
    const destinationRoots = [...new Map([profileDirectory, armaDirectory]
        .map(directory => [path.resolve(directory).toLowerCase(), directory])).values()];

    // A mission is mounted under its folder name (example.Altis), so two workspaces missions
    // with the same name would fight over the same link. Multiplayer missions win, because
    // they can only live in MPMissions; the single-player one then keeps Missions only.
    const multiplayerNames = new Set(
        missions.filter(mission => mission.multiplayer).map(mission => path.basename(mission.directory).toLowerCase())
    );

    for (const mission of missions) {
        const name = path.basename(mission.directory);

        if (!mission.multiplayer && multiplayerNames.has(name.toLowerCase())) {
            warnings.push(`${name} also exists as a multiplayer mission (mpmissions\\${name}); the multiplayer one is linked into MPMissions and the single-player one into Missions only.`);
        }

        const folders = mission.multiplayer ? ["MPMissions"] : MISSION_FOLDERS;

        for (const root of destinationRoots) {
            for (const folder of folders) {
                const linkPath = path.join(root, folder, name);

                if (!mission.multiplayer && folder === "MPMissions" && multiplayerNames.has(name.toLowerCase())) {
                    continue;
                }
                if (path.resolve(linkPath).toLowerCase() === path.resolve(mission.directory).toLowerCase()) {
                    continue;
                }

                const link = ensureDirectoryLink(linkPath, mission.directory, warnings, true);

                if (link) {
                    links.push(link);
                }
            }
        }
    }

    return { links, warnings };
}

const MISSION_FOLDERS = ["Missions", "MPMissions"];

export function readRegistry(armaDirectory: string): Registration[] {
    try {
        const content = fs.readFileSync(registryPath(armaDirectory), "utf8");
        const parsed = JSON.parse(content);

        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.filter((entry: Registration) => typeof entry?.linkPath === "string");
    } catch {
        return [];
    }
}

/** Removes every link previously created by the extension. */
export function removeAllLinks(armaDirectory: string): { removed: string[]; failed: string[] } {
    const removed: string[] = [];
    const failed: string[] = [];

    for (const entry of readRegistry(armaDirectory)) {
        // Only remove paths that still resolve to the recorded target, so a folder the user
        // replaced by hand is kept.
        const current = readLinkTarget(entry.linkPath);

        if (!current) {
            continue;
        }

        const resolvedCurrent = path.resolve(path.dirname(entry.linkPath), current).toLowerCase();
        const resolvedRecorded = path.resolve(entry.target).toLowerCase();
        if (resolvedCurrent !== resolvedRecorded) {
            continue;
        }

        if (removeLink(entry.linkPath)) {
            removed.push(entry.linkPath);
            const zRoot = path.resolve(armaDirectory, "z");
            const relativeToZ = path.relative(zRoot, path.resolve(entry.linkPath));
            if (relativeToZ !== ".." && !relativeToZ.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToZ)) {
                // Keep the shared z mount root for other mods. Remove only empty folders
                // below z\<TAG>, including the tag directory itself.
                const segments = relativeToZ.split(path.sep);
                if (segments.length > 0) {
                    removeEmptyDirectories(path.dirname(entry.linkPath), path.join(zRoot, segments[0]));
                }
            }
        } else {
            failed.push(entry.linkPath);
        }
    }

    try {
        fs.rmSync(registryPath(armaDirectory), { force: true });
    } catch {
        // Nothing to clean.
    }

    return { removed, failed };
}

function removeEmptyDirectories(directory: string, stopAt: string): void {
    const stop = path.resolve(stopAt);
    let current = path.resolve(directory);

    while (current === stop || current.startsWith(`${stop}${path.sep}`)) {
        try {
            if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) return;
            fs.rmdirSync(current);
        } catch {
            return;
        }

        if (current === stop) return;
        current = path.dirname(current);
    }
}

/** What Arma would read for an addon right now. */
export function verifyAddonLink(armaDirectory: string, addon: Addon): { ok: boolean; resolved?: string } {
    const linkPath = addonLinkPath(armaDirectory, addon);
    const resolved = readLinkTarget(linkPath);

    if (!resolved) {
        return { ok: fs.existsSync(linkPath) };
    }

    return { ok: path.resolve(resolved).toLowerCase() === path.resolve(addon.localDirectory).toLowerCase(), resolved };
}
