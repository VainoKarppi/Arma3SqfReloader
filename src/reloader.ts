import * as fs from "fs";
import * as path from "path";
import { log } from "./settings";

/**
 * ArmaApi ships as a PBO (`@ArmaApi\addons\armaapi.pbo`). Arma reads the scripts from the PBO,
 * which the reloader cannot edit, so hot reload uses file patching instead:
 *
 *   arma3_x64.exe -filePatching -mod="@ArmaApi"
 *   @ArmaApi\replacement\armaapi\config.cpp   mounted on top of the PBO
 *
 * The replacement config only adds a `reloader` to every CfgFunctions class of the PBO:
 *
 *   class Core {
 *       reloader = "\z\armaapi\addons\armaapi\functions\extension\reloader.sqf";
 *   };
 *
 * Arma then compiles that one script instead of the individual fn_*.sqf files, so recompiling
 * a class reloads all of its functions. The extension generates the config, the reloader
 * scripts and a plain copy of the fn_*.sqf sources from the mod sources, so the patched files
 * always match the PBO that was built. Because the replacement files are a real folder,
 * editing them from VS Code (SQF editor + save-to-reload) works like it does for user mods.
 */

/** Folder in the mod root that Arma mounts on top of the PBO when file patching is on. */
export const REPLACEMENT_DIRECTORY = "replacement";

/** CfgFunctions entries that the generated reloader scripts must skip. */
const RESERVED_NAMES = new Set(["init", "preInit", "postInit"]);

export interface FunctionEntry {
    /** Function name without the tag, e.g. "apiStart" (class apiStart). */
    name: string;
    /** fn_*.sqf path relative to the addon root, forward slashes (used for filesystem joins). */
    file: string;
    /** The same file as an Arma path, e.g. functions\extension\fn_apiStart.sqf. */
    armaFile: string;
    /** True when the class carries `recompile = 1;` in config.cpp. */
    recompile: boolean;
}

export interface FunctionGroup {
    /** CfgFunctions class (Core, Reload, Util, UI...). */
    name: string;
    /** `file` of the class, e.g. functions\extension. */
    file: string;
    /** Tag of the parent class (ArmaApi). */
    tag: string;
    functions: FunctionEntry[];
}

export interface ReplacementPlan {
    /** Absolute path of the generated @ArmaApi\replacement folder. */
    directory: string;
    /** True when nothing had to be written (the files were already up to date). */
    unchanged: boolean;
    groups: FunctionGroup[];
}

export interface ReplacementOptions {
    /** Folder of the @Mod that receives replacement\ (usually `<arma>\@ArmaApi`). */
    modDirectory: string;
    /** Prefix from $PBOPREFIX$, e.g. z\armaapi\addons\armaapi (the PBO path). */
    prefix: string;
    /** Folder with config.cpp + functions\ of the addon (dist\@ArmaApi\source). */
    sourcesDirectory: string;
}

/**
 * Reads the CfgFunctions blocks of an addon config. The generated layout is
 * `class X { tag = "T"; class G { file = "functions\g"; class f { recompile = 1; }; }; };`.
 */
export function parseFunctionGroups(config: string): FunctionGroup[] {
    const root = parseConfig(config);
    const groups: FunctionGroup[] = [];

    for (const cfgFunctions of findChildren(root, "CfgFunctions")) {
        for (const tagClass of classes(cfgFunctions)) {
            for (const groupClass of classes(tagClass)) {
                const file = groupClass.properties.get("file");

                if (!file) {
                    continue;
                }

                const functions: FunctionEntry[] = [];

                for (const functionClass of classes(groupClass)) {
                    if (RESERVED_NAMES.has(functionClass.name)) {
                        continue;
                    }

                    functions.push({
                        name: functionClass.name,
                        file: `${file.replace(/\\/g, "/")}/fn_${functionClass.name}.sqf`,
                        armaFile: `${file}\\fn_${functionClass.name}.sqf`,
                        recompile: /^1$/.test((functionClass.properties.get("recompile") ?? "").trim())
                    });
                }

                if (functions.length > 0) {
                    groups.push({ name: groupClass.name, file, tag: tagClass.properties.get("tag") ?? "", functions });
                }
            }
        }
    }

    return groups;
}

interface ConfigClass {
    name: string;
    properties: Map<string, string>;
    children: ConfigClass[];
}

/** Minimal C++-config parser: `class Name [: Base] { prop = value; class Child { ... }; };`. */
function parseConfig(source: string): ConfigClass {
    const text = stripComments(source);
    const root: ConfigClass = { name: "", properties: new Map(), children: [] };
    let index = 0;

    const skipSpace = (): void => {
        while (index < text.length && /\s/.test(text[index])) {
            index++;
        }
    };

    const readString = (): string => {
        if (text[index] !== '"') {
            return "";
        }

        let value = "";
        index++;

        while (index < text.length && text[index] !== '"') {
            if (text[index] === "\\" && index + 1 < text.length) {
                value += text[index] + text[index + 1];
                index += 2;
                continue;
            }

            value += text[index++];
        }

        index++;
        return value;
    };

    const readBlock = (parent: ConfigClass): void => {
        while (index < text.length) {
            skipSpace();
            const character = text[index];

            if (character === "}") {
                index++;
                return;
            }

            if (character === undefined) {
                return;
            }

            if (character === ";") {
                index++;
                continue;
            }

            const rest = text.slice(index);

            // Preprocessor lines (#include, #define, ...) are not part of the config.
            if (character === "#") {
                const newline = text.indexOf("\n", index);
                index = newline < 0 ? text.length : newline + 1;
                continue;
            }

            const classMatch = /^class\s+([\w]+)/i.exec(rest);

            if (classMatch) {
                index += classMatch[0].length;
                skipSpace();

                if (text[index] === ":") {
                    index++;
                    skipSpace();

                    const base = /^[\w]+/.exec(text.slice(index));
                    if (base) {
                        index += base[0].length;
                    }

                    skipSpace();
                }

                const child: ConfigClass = { name: classMatch[1], properties: new Map(), children: [] };

                if (text[index] === "{") {
                    index++;
                    readBlock(child);
                } else {
                    // Forward declaration (`class ctrlMenuStrip;`).
                    const end = text.indexOf(";", index);
                    index = end < 0 ? text.length : end + 1;
                }

                parent.children.push(child);
                continue;
            }

            // Anything else is a `name = value;` (or `name[] += {...};`) property.
            const nameMatch = /^([\w]+)(\[\])?/.exec(rest);

            if (!nameMatch) {
                index++;
                continue;
            }

            const name = nameMatch[1];
            index += nameMatch[0].length;
            skipSpace();

            // Operators that can appear between the name and the value: = += -= /= *= ++ --.
            const operator = /^(\+\+|--|\+=|-=|\*=|\/=|=)/.exec(text.slice(index));

            if (operator) {
                index += operator[0].length;
            }

            skipSpace();
            let value = "";

            if (text[index] === '"') {
                value = readString();
            } else if (text[index] === "{") {
                // Array value: skip the braces, keep the text for completeness.
                let depth = 0;
                const start = index;

                while (index < text.length) {
                    if (text[index] === "{") depth++;
                    else if (text[index] === "}") {
                        depth--;
                        if (depth === 0) {
                            index++;
                            break;
                        }
                    }

                    index++;
                }

                value = text.slice(start + 1, index - 1);
            } else {
                const end = text.indexOf(";", index);

                if (end < 0) {
                    index = text.length;
                    continue;
                }

                value = text.slice(index, end);
                index = end;
            }

            skipSpace();

            if (text[index] === ";") {
                index++;
            }

            parent.properties.set(name, value);
        }
    };

    readBlock(root);
    return root;
}

/** Child classes named `name` (case-insensitive), checked at every level. */
function findChildren(node: ConfigClass, name: string): ConfigClass[] {
    const wanted = name.toLowerCase();
    const direct = node.children.filter(child => child.name.toLowerCase() === wanted);

    if (direct.length > 0) {
        return direct;
    }

    return node.children.flatMap(child => findChildren(child, name));
}

/** Classes whose `class` declarations are real (non-reserved) settings classes. */
function classes(node: ConfigClass): ConfigClass[] {
    return node.children.filter(child => !RESERVED_NAMES.has(child.name.toLowerCase()));
}

/** Removes `//` and block comments, keeping strings intact. */
function stripComments(source: string): string {
    let result = "";
    let index = 0;
    let inString = false;

    while (index < source.length) {
        const character = source[index];
        const next = source[index + 1];

        if (inString) {
            result += character;

            if (character === "\\") {
                result += next ?? "";
                index += 2;
                continue;
            }

            if (character === '"') {
                inString = false;
            }

            index++;
            continue;
        }

        if (character === '"') {
            inString = true;
            result += character;
            index++;
            continue;
        }

        if (character === "/" && next === "/") {
            const newline = source.indexOf("\n", index);
            index = newline < 0 ? source.length : newline;
            continue;
        }

        if (character === "/" && next === "*") {
            const end = source.indexOf("*/", index + 2);
            index = end < 0 ? source.length : end + 2;
            result += " ";
            continue;
        }

        result += character;
        index++;
    }

    return result;
}

/** Index of the `}` that closes the block opened at `openBrace` (string aware). */
function findBlockEnd(text: string, openBrace: number): number {
    let depth = 0;
    let inString = false;

    for (let i = openBrace; i < text.length; i++) {
        const character = text[i];

        if (inString) {
            if (character === '"') {
                inString = false;
            }

            continue;
        }

        if (character === '"') {
            inString = true;
        } else if (character === "{") {
            depth++;
        } else if (character === "}") {
            depth--;

            if (depth === 0) {
                return i;
            }
        }
    }

    return -1;
}

/**
 * Writes `<mod>\replacement\armaapi\` for a PBO install of ArmaApi and returns what can be
 * reloaded. When the sources are missing nothing is written and undefined is returned.
 */
export function writeReplacement(options: ReplacementOptions): ReplacementPlan | undefined {
    const configFile = path.join(options.sourcesDirectory, "config.cpp");

    if (!fs.existsSync(configFile)) {
        log(`Reloader: ${configFile} not found; ArmaApi's own functions cannot be hot reloaded.`);
        return undefined;
    }

    const groups = parseFunctionGroups(fs.readFileSync(configFile, "utf8"));

    if (groups.length === 0) {
        log(`Reloader: ${configFile} has no CfgFunctions classes to reload.`);
        return undefined;
    }

    const directory = path.join(options.modDirectory, REPLACEMENT_DIRECTORY, addonName(options));
    const mount = toMountPath(options.prefix);
    let changed = writeIfChanged(path.join(directory, "config.cpp"), buildPatchedConfig(groups, mount));

    for (const group of groups) {
        const folder = group.file.replace(/\\/g, "/");
        const lines = [
            "// <auto-generated> Arma 3 SQF Reloader: reloader for one CfgFunctions class.",
            `// Arma compiles this instead of ${folder}/fn_*.sqf; saving an SQF file re-runs it.`,
            `// Only functions with recompile = 1 in config.cpp are recompiled here.`,
            ""
        ];

        for (const entry of group.functions) {
            if (!entry.recompile) {
                continue;
            }

            const source = path.join(options.sourcesDirectory, ...entry.file.split("/"));

            if (!fs.existsSync(source)) {
                log(`Reloader: ${source} is listed in config.cpp but missing on disk.`);
                continue;
            }

            const target = path.join(directory, ...entry.file.split("/"));
            if (writeIfChanged(target, fs.readFileSync(source, "utf8"))) {
                changed = true;
            }

            lines.push(`${group.tag}_fnc_${entry.name} = compile preprocessFileLineNumbers "${mount}${entry.armaFile}";`);
        }

        // Functions without recompile = 1 (init, runStartup) still need a file inside the
        // replacement folder: Arma compiles every class through its reloader when the patched
        // config is active, and a missing file would leave the function undefined.
        for (const entry of group.functions) {
            if (entry.recompile) {
                continue;
            }

            const source = path.join(options.sourcesDirectory, ...entry.file.split("/"));

            if (fs.existsSync(source) && writeIfChanged(path.join(directory, ...entry.file.split("/")), fs.readFileSync(source, "utf8"))) {
                changed = true;
            }
        }

        lines.push("");
        const reloader = path.join(directory, ...folder.split("/"), "reloader.sqf");

        if (writeIfChanged(reloader, lines.join("\n"))) {
            changed = true;
        }
    }

    const count = groups.reduce((sum, group) => sum + group.functions.filter(entry => entry.recompile).length, 0);
    log(`Reloader: ${count} function(s) in ${groups.length} class(es) -> ${directory}${changed ? "" : " (unchanged)"}`);

    return { directory, unchanged: !changed, groups };
}

/** Addon folder name from the $PBOPREFIX$ (z\armaapi\addons\armaapi -> armaapi). */
function addonName(options: ReplacementOptions): string {
    const segments = options.prefix.split(/[\/\\]+/).filter(Boolean);
    return (segments[segments.length - 1] ?? "armaapi").toLowerCase();
}

/** $PBOPREFIX$ as an Arma path: z\armaapi\addons\armaapi -> \z\armaapi\addons\armaapi\. */
function toMountPath(prefix: string): string {
    return `\\${prefix.replace(/[\/\\]+/g, "\\").replace(/^\\+|\\+$/g, "")}\\`;
}

function buildPatchedConfig(groups: FunctionGroup[], mount: string): string {
    const lines = [
        "// <auto-generated> Arma 3 SQF Reloader: file-patching config for the ArmaApi PBO.",
        "// Only adds `reloader` to the CfgFunctions classes that already exist in the PBO.",
        "// Recreated by \"Arma API: Play\"; manual edits are overwritten.",
        "",
        "allowFunctionsRecompile = 1;",
        "",
        "class CfgFunctions {"
    ];

    // One wrapper class per tag (ArmaApi), all function classes inside it.
    const byTag = new Map<string, FunctionGroup[]>();

    for (const group of groups) {
        const tag = group.tag || "ArmaApi";
        byTag.set(tag, [...(byTag.get(tag) ?? []), group]);
    }

    for (const [tag, tagGroups] of byTag) {
        lines.push(`    class ${tag} {`);

        for (const group of tagGroups) {
            lines.push(
                `        class ${group.name} {`,
                `            reloader = "${mount}${group.file.replace(/\//g, "\\").replace(/\\+$/, "")}\\reloader.sqf";`,
                "        };"
            );
        }

        lines.push("    };");
    }

    lines.push("};", "");
    return lines.join("\n");
}

/** Writes a file only when its content differs; returns true when it was (re)written. */
function writeIfChanged(target: string, content: string): boolean {
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === content) {
        return false;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return true;
}
