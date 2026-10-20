import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { Addon, Mod } from "./arma";
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

const REGISTRY_FILE = ".armaapi-links.json";

/**
 * Links the mod into the Arma folder so both Arma and the reloader read the files from the
 * working copy. Default layout is `addon`: every $PBOPREFIX$ folder becomes
 * `<arma>\z\<tag>\addons\<name>` (or `x\...` when the prefix uses x). `module` mode links
 * the whole @Mod folder into the Arma root instead.
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
            const linkPath = path.join(armaDirectory, ...addon.prefix.split("\\"));
            const link = ensureDirectoryLink(linkPath, addon.localDirectory, warnings);

            if (link) {
                links.push(link);
            }
        }
    }

    registerLinks(armaDirectory, links);
    return { links, warnings };
}

/** Creates the link unless the path is already correct. */
function ensureDirectoryLink(linkPath: string, target: string, warnings: string[]): Link | undefined {
    const resolvedTarget = path.resolve(target);

    if (fs.existsSync(linkPath)) {
        const currentTarget = readLinkTarget(linkPath);

        // Windows paths are case-insensitive and mklink stores the target as typed.
        if (currentTarget && path.resolve(currentTarget).toLowerCase() === resolvedTarget.toLowerCase()) {
            log(`Link already in place: ${linkPath} -> ${currentTarget}`);
            return { linkPath, target: resolvedTarget, kind: "existing" };
        }

        warnings.push(`${linkPath} already exists and points to ${currentTarget ?? "a real folder"}; it was left untouched. Remove it if it should be linked to ${resolvedTarget}.`);
        return undefined;
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

        if (removeLink(entry.linkPath)) {
            removed.push(entry.linkPath);
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

/** What Arma would read for an addon right now. */
export function verifyAddonLink(armaDirectory: string, addon: Addon): { ok: boolean; resolved?: string } {
    const linkPath = path.join(armaDirectory, ...addon.prefix.split("\\"));
    const resolved = readLinkTarget(linkPath);

    if (!resolved) {
        return { ok: fs.existsSync(linkPath) };
    }

    return { ok: path.resolve(resolved).toLowerCase() === path.resolve(addon.localDirectory).toLowerCase(), resolved };
}
