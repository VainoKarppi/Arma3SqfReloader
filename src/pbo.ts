import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import { Mod } from "./arma";
import { configuredLogLevel, getOutput, log } from "./settings";

interface ArmaTools {
    builder: string;
    root: string;
}

/**
 * Builds one PBO per addon from the active workspace mods. SQF remains in the source folders
 * for the reloader, but is deliberately omitted from the packaged config/assets PBO.
 */
export async function buildWorkspaceAddonPbos(mods: Mod[]): Promise<boolean> {
    const addonDirectories = mods.flatMap(mod => {
        const addonsRoot = path.join(mod.directory, "addons");
        if (!fs.existsSync(addonsRoot)) return [];
        return fs.readdirSync(addonsRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => ({ source: path.join(addonsRoot, entry.name), addonsRoot, name: entry.name }));
    });
    if (addonDirectories.length === 0) return true;

    const tools = await findArmaTools();
    if (!tools) {
        const choice = await vscode.window.showWarningMessage(
            "Arma 3 Tools was not found in the registry. Install it from Steam (Library > Tools) and launch it once so its registry entry is created. Continue without creating addon PBO files?",
            { modal: true },
            "Continue Anyway",
            "Cancel Launch"
        );
        if (choice === "Continue Anyway") {
            log("Arma 3 Tools AddonBuilder was not found; continuing without addon PBO creation.");
            return true;
        }
        return false;
    }

    for (const addon of addonDirectories) {
        await buildAddonPbo(addon.source, addon.addonsRoot, addon.name, tools);
    }
    return true;
}

async function findArmaTools(): Promise<ArmaTools | undefined> {
    if (process.platform !== "win32") return undefined;
    const configuredDirectory = vscode.workspace.getConfiguration("sqfReloader")
        .get<string>("arma3ToolsDirectory", "").trim();
    if (configuredDirectory) {
        const configuredPath = path.resolve(configuredDirectory);
        const builder = path.basename(configuredPath).toLowerCase() === "addonbuilder.exe"
            ? configuredPath
            : path.join(configuredPath, "AddonBuilder", "AddonBuilder.exe");
        if (!fs.existsSync(builder)) {
            throw new Error(`sqfReloader.arma3ToolsDirectory is set, but AddonBuilder.exe was not found at ${builder}.`);
        }
        return { builder, root: path.dirname(path.dirname(builder)) };
    }

    const key = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 233800";
    try {
        const result = await execute("reg", ["query", key], undefined, false);
        const installLocation = /^\s*InstallLocation\s+REG_SZ\s+(.+)$/im.exec(result)?.[1]?.trim();
        const displayIcon = /^\s*DisplayIcon\s+REG_SZ\s+(.+?)(?:,\d+)?\s*$/im.exec(result)?.[1]?.trim().replace(/^"|"$/g, "");
        const candidates = [
            ...(installLocation ? [installLocation] : []),
            ...(displayIcon ? [path.dirname(displayIcon)] : [])
        ];
        for (const root of candidates) {
            const builder = path.join(root, "AddonBuilder", "AddonBuilder.exe");
            if (fs.existsSync(builder)) return { builder, root };
        }
    } catch {
        // The Steam Tools uninstall entry is absent or unreadable.
    }
    for (const key of [
        "HKLM\\SOFTWARE\\WOW6432Node\\Bohemia Interactive\\Arma 3 Tools",
        "HKLM\\SOFTWARE\\Bohemia Interactive\\Arma 3 Tools"
    ]) {
        try {
            const result = await execute("reg", ["query", key, "/v", "Path"], undefined, false);
            const match = /REG_SZ\s+(.+)$/m.exec(result);
            if (!match) continue;
            const root = match[1].trim();
            const builder = path.join(root, "AddonBuilder", "AddonBuilder.exe");
            if (fs.existsSync(builder)) return { builder, root };
        } catch {
            // The registry key is absent; continue to the other supported hive.
        }
    }
    return undefined;
}

async function buildAddonPbo(source: string, addonsRoot: string, name: string, tools: ArmaTools): Promise<void> {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sqfreloader-addon-"));
    const staged = path.join(tempRoot, name);
    await fs.promises.mkdir(staged, { recursive: true });
    try {
        const fileCount = await copyAddonFiles(source, staged);
        if (fileCount === 0) return;
        const outputFile = path.join(addonsRoot, `${name}.pbo`);
        await fs.promises.mkdir(addonsRoot, { recursive: true });
        await execute(tools.builder, [
            staged,
            addonsRoot,
            `-temp=${path.join(tempRoot, "temp")}`,
            `-prefix=${name}`,
            "-packonly",
            `-toolsDirectory=${tools.root}`
        ], path.dirname(tools.builder));
        if (!fs.existsSync(outputFile)) throw new Error(`AddonBuilder did not create ${outputFile}.`);
        log(`Created addon PBO: ${outputFile}`);
    } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
}

async function copyAddonFiles(source: string, destination: string): Promise<number> {
    let copied = 0;
    for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            await fs.promises.mkdir(to, { recursive: true });
            copied += await copyAddonFiles(from, to);
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() !== ".sqf") {
            let content: Buffer | undefined;
            if ([".cpp", ".hpp"].includes(path.extname(entry.name).toLowerCase())) {
                content = Buffer.from(stripCfgFunctions((await fs.promises.readFile(from)).toString("utf8")), "utf8");
            }
            await fs.promises.copyFile(from, to);
            if (content) await fs.promises.writeFile(to, content);
            copied++;
        }
    }
    return copied;
}

/** Removes complete CfgFunctions class declarations, respecting quoted strings and comments. */
export function stripCfgFunctions(text: string): string {
    const ranges: Array<[number, number]> = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] === '"') {
            i = skipString(text, i);
            continue;
        }
        if (text[i] === "/" && text[i + 1] === "/") {
            i = skipLineComment(text, i);
            continue;
        }
        if (text[i] === "/" && text[i + 1] === "*") {
            i = skipBlockComment(text, i);
            continue;
        }
        const match = /^class\s+CfgFunctions\s*\{/i.exec(text.slice(i));
        if (!match || (i > 0 && /[\w]/.test(text[i - 1]))) {
            i++;
            continue;
        }
        const open = i + match[0].lastIndexOf("{");
        let depth = 1;
        let cursor = open + 1;
        while (cursor < text.length && depth > 0) {
            if (text[cursor] === '"') cursor = skipString(text, cursor);
            else if (text[cursor] === "/" && text[cursor + 1] === "/") cursor = skipLineComment(text, cursor);
            else if (text[cursor] === "/" && text[cursor + 1] === "*") cursor = skipBlockComment(text, cursor);
            else {
                if (text[cursor] === "{") depth++;
                if (text[cursor] === "}") depth--;
                cursor++;
            }
        }
        if (depth !== 0) throw new Error("Cannot package config: unterminated CfgFunctions block.");
        if (text[cursor] === ";") cursor++;
        ranges.push([i, cursor]);
        i = cursor;
    }
    for (const [start, end] of ranges.reverse()) text = text.slice(0, start) + text.slice(end);
    return text;
}

function skipString(text: string, start: number): number {
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '"') {
            if (text[i + 1] === '"') { i++; continue; }
            return i + 1;
        }
    }
    return text.length;
}

function skipLineComment(text: string, start: number): number {
    const end = text.indexOf("\n", start + 2);
    return end < 0 ? text.length : end + 1;
}

function skipBlockComment(text: string, start: number): number {
    const end = text.indexOf("*/", start + 2);
    if (end < 0) throw new Error("Cannot package config: unterminated block comment.");
    return end + 2;
}

function execute(file: string, args: string[], cwd?: string, reportError = true): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
            const output = `${stdout}${stderr}`;
            if (!error) {
                if (configuredLogLevel() === "verbose" && output.trim()) {
                    getOutput().appendLine(output.trimEnd());
                }
                resolve(output);
                return;
            }

            const errorLines = output.split(/\r?\n/).filter(line => /\b(error|failed|failure)\b/i.test(line));
            const detail = errorLines.length > 0 ? errorLines.join("\n") : error.message;
            if (reportError) getOutput().appendLine(`[${path.basename(file)}] ${detail}`);
            reject(new Error(`${path.basename(file)} failed: ${detail}`));
        });
    });
}
