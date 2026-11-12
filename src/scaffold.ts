import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findMods, Mod } from "./arma";
import { log, readSettings } from "./settings";
import { PROJECT_SETTINGS_FILE } from "./projectSettings";

/** Tag of the generated example mod; drives the SqfReloader runtime path and function names. */
export const TEMPLATE_TAG = "example";
export const TEMPLATE_MOD_NAME = "@ExampleMod";
/** Folder the client example mod, its missions and its HEMTT project are written to. */
export const TEMPLATE_CLIENT_DIRECTORY = "ClientMod";
/** Folder the server example mod, its mission and server.cfg are written to. */
export const TEMPLATE_SERVER_DIRECTORY = "ServerMod";
const TEMPLATE_SOURCE_DIRECTORY = path.resolve(__dirname, "..", "examples", "armaExamples");
const CLIENT_TEMPLATE = path.join(TEMPLATE_SOURCE_DIRECTORY, "client-example");
const SERVER_TEMPLATE = path.join(TEMPLATE_SOURCE_DIRECTORY, "server-example");
const WORKSPACE_SETTINGS_TEMPLATE = path.join(TEMPLATE_SOURCE_DIRECTORY, "workspace-settings.json");
/** Tracks HEMTT's per-project output folder; `**` covers every nested HEMTT project. */
export const HEMTT_IGNORE_ENTRY = "**/.hemttout/";

export interface ScaffoldOptions {
    /** Folder that receives the mod (defaults to the first workspace folder). */
    target?: string;
    /** Also create a minimal test mission that shows the example dialog. */
    mission?: boolean;
    /** Overwrite existing template files. */
    force?: boolean;
}

export interface ScaffoldResult {
    modDirectory: string;
    /** Files created in this run. */
    files: string[];
    /** Template files that already existed and were left untouched. */
    skipped: string[];
    /** Client example folder (ClientMod): mod, missions and HEMTT project. */
    clientExampleDirectory: string;
    /** Single-player mission (ClientMod\missions\example.Altis). */
    missionDirectory?: string;
    /** Multiplayer mission (ClientMod\mpmissions\example.Altis). */
    mpMissionDirectory?: string;
    /** Server mod/config/mission example directory (ServerMod). */
    serverExampleDirectory?: string;
}

/**
 * Creates the example mod, missions, and dedicated-server files in the open workspace.
 */
export async function scaffoldExample(options: ScaffoldOptions = {}): Promise<ScaffoldResult | undefined> {
    const settings = readSettings();
    const target = options.target ?? firstWorkspaceFolder();

    if (!target) {
        vscode.window.showWarningMessage("Open a folder in VS Code first: the example mod is created inside the workspace.");
        return undefined;
    }

    const existing = exampleMod(target);
    const withMission = options.mission ?? settings.createExampleWithMission;
    appendScaffoldLog(`TEMPLATE start target=${target} mission=${withMission} existing=${existing ? existing.name : "none"}`);

    // Confirmation prompts block a headless run (ARMA_API_TEST_OUTPUT), so they are skipped there.
    if (existing && options.target === undefined && !process.env.ARMA_API_TEST_OUTPUT) {
        const answer = await vscode.window.showInformationMessage(
            `${TEMPLATE_MOD_NAME} already exists in this workspace. Create the template files again?`,
            "Recreate files",
            "Cancel"
        );

        if (answer !== "Recreate files") {
            return undefined;
        }
    }

    const result = writeTemplate(target, withMission, options.force ?? existing !== undefined);
    appendScaffoldLog(`TEMPLATE written ${result.files.length} files`);
    log(`Example mod: ${result.modDirectory}`);

    for (const file of result.files) {
        log(`  created ${file}`);
    }

    for (const file of result.skipped) {
        log(`  kept existing ${file}`);
    }

    await revealExample(result);

    if (settings.autoJunction && !settings.armaDirectory) {
        log("No Arma 3 folder configured yet; it is detected or asked for on the first Play.");
    }

    return result;
}

/**
 * Writes the template without touching the VS Code UI (also used by scripts/verify-template.js).
 * Existing files are only overwritten with force=true.
 *
 * Layout created in the workspace:
 *
 *   ClientMod\@ExampleMod\        the client mod (mod.cpp, addons\scripts, .hemtt project)
 *   ClientMod\missions\           single-player test mission
 *   ClientMod\mpmissions\         multiplayer test mission
 *   ServerMod\@ExampleServerMod\  the server mod (with its own .hemtt project)
 *   ServerMod\ExampleMission.Altis, ServerMod\server.cfg, ServerMod\README.md
 *   .vscode\sqfReloader-settings.json   both mods with their launch roles
 */
export function writeTemplate(root: string, withMission: boolean, force: boolean): ScaffoldResult {
    const clientExampleDirectory = path.join(root, TEMPLATE_CLIENT_DIRECTORY);
    const modDirectory = path.join(clientExampleDirectory, TEMPLATE_MOD_NAME);
    const files: string[] = [];
    const skipped: string[] = [];

    const write = (file: string, content: string): void => {
        if (fs.existsSync(file) && !force) {
            skipped.push(file);
            return;
        }

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content.replace(/\r?\n/g, "\r\n"), "utf8");
        files.push(file);
    };

    copyTemplateDirectory(
        CLIENT_TEMPLATE,
        clientExampleDirectory,
        write,
        relativePath => withMission || !["missions", "mpmissions"].includes(relativePath.split(path.sep)[0])
    );

    // The project settings file belongs to the user once it exists: recreating the template must
    // never reset launch options or mod roles that were configured in the project settings panel.
    const settingsFile = path.join(root, ".vscode", PROJECT_SETTINGS_FILE);
    if (fs.existsSync(settingsFile)) {
        skipped.push(settingsFile);
    } else {
        if (!fs.existsSync(WORKSPACE_SETTINGS_TEMPLATE)) {
            throw new Error(`Example project settings template not found: ${WORKSPACE_SETTINGS_TEMPLATE}`);
        }
        write(settingsFile, fs.readFileSync(WORKSPACE_SETTINGS_TEMPLATE, "utf8"));
    }

    const missionDirectory = withMission
        ? path.join(clientExampleDirectory, "missions", `${TEMPLATE_TAG}.Altis`)
        : undefined;
    const mpMissionDirectory = withMission
        ? path.join(clientExampleDirectory, "mpmissions", `${TEMPLATE_TAG}.Altis`)
        : undefined;
    const serverExampleDirectory = copyTemplateDirectory(
        SERVER_TEMPLATE,
        path.join(root, TEMPLATE_SERVER_DIRECTORY),
        write
    );

    // HEMTT writes .hemttout for every project it checks, including the generated ClientMod and
    // ServerMod projects. Keep it out of git without touching unrelated ignore rules.
    const gitignore = ensureGitIgnore(root);
    if (gitignore.created || gitignore.updated) {
        files.push(gitignore.file);
    } else {
        skipped.push(gitignore.file);
    }

    return {
        modDirectory,
        files,
        skipped,
        clientExampleDirectory,
        missionDirectory,
        mpMissionDirectory,
        serverExampleDirectory
    };
}

/**
 * Makes sure the workspace `.gitignore` ignores HEMTT's output folders.
 *
 * An existing file is only appended to, and only when no equivalent rule (a recursive wildcard plus
 * `.hemttout`, or a plain `.hemttout` line) is present yet; everything already in the file is
 * preserved. A missing file gets a minimal one with a short comment.
 */
export function ensureGitIgnore(root: string): { file: string; created: boolean; updated: boolean } {
    const file = path.join(root, ".gitignore");
    const exists = fs.existsSync(file);

    if (exists) {
        const content = fs.readFileSync(file, "utf8");
        if (content.split(/\r?\n/).some(line => ignoresHemttOutput(line))) {
            return { file, created: false, updated: false };
        }

        const eol = content.includes("\r\n") ? "\r\n" : "\n";
        const separator = content.length === 0 || /(\r?\n)$/.test(content) ? "" : eol;
        fs.writeFileSync(file, `${content}${separator}${HEMTT_IGNORE_ENTRY}${eol}`, "utf8");
        return { file, created: false, updated: true };
    }

    const content = `# HEMTT build output (created by SqfReloader's example)\n${HEMTT_IGNORE_ENTRY}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content.replace(/\r?\n/g, "\r\n"), "utf8");
    return { file, created: true, updated: false };
}

/** True when a .gitignore line already ignores `.hemttout` in this and every subfolder. */
export function ignoresHemttOutput(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;

    const pattern = trimmed
        .replace(/^\/+/, "")
        .replace(/^(\*\*\/)+/, "")
        .replace(/\/\*\*$/, "")
        .replace(/\/+$/, "")
        .toLowerCase();

    // A bare ".hemttout" matches in every folder, so it covers nested HEMTT projects too.
    return pattern === ".hemttout";
}

function copyTemplateDirectory(
    sourceDirectory: string,
    destinationDirectory: string,
    write: (file: string, content: string) => void,
    includeFile: (relativePath: string) => boolean = () => true
): string {
    if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
        throw new Error(`Example template directory not found: ${sourceDirectory}`);
    }

    const copyDirectory = (source: string, destination: string, relativePath = ""): void => {
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            const sourcePath = path.join(source, entry.name);
            const destinationPath = path.join(destination, entry.name);
            const childRelativePath = path.join(relativePath, entry.name);

            if (entry.isDirectory()) {
                copyDirectory(sourcePath, destinationPath, childRelativePath);
            } else if (entry.isFile()) {
                if (includeFile(childRelativePath)) {
                    write(destinationPath, fs.readFileSync(sourcePath, "utf8"));
                }
            } else {
                throw new Error(`Unsupported entry in example template: ${sourcePath}`);
            }
        }
    };

    copyDirectory(sourceDirectory, destinationDirectory);
    return destinationDirectory;
}

/** What the example-mod offer knows about the workspace. */
export interface ExamplePromptState {
    /** At least one workspace folder is open. */
    hasWorkspace: boolean;
    /** The workspace contains no files (ignoring .git/.vscode/node_modules). */
    emptyWorkspace: boolean;
    /** The scaffold's @ExampleMod is already present. */
    exampleExists: boolean;
    /** The user chose "Don't ask again" (global). */
    declined: boolean;
    /** The offer was already shown for this workspace and this extension version. */
    asked: boolean;
}

/**
 * Whether the "create the example mod?" offer should be shown.
 *
 * The offer is per workspace, not per installation: it used to be recorded in `globalState`
 * keyed by the extension version, so the first workspace that answered it (or merely closed the
 * toast) suppressed the offer in every other folder, including a brand new empty one.
 */
export function shouldOfferExample(state: ExamplePromptState): boolean {
    if (!state.hasWorkspace || state.declined || state.asked) return false;
    return state.emptyWorkspace && !state.exampleExists;
}

/** The generated example mod, when it exists in the workspace. */
export function exampleMod(root: string): Mod | undefined {
    return findMods(root).find(mod => mod.name.toLowerCase() === TEMPLATE_MOD_NAME.toLowerCase());
}

/**
 * Opens the client example walkthrough as a rendered Markdown preview so a new workspace starts on
 * one thing: the guide for the mod that was just created.
 */
async function revealExample(result: ScaffoldResult): Promise<void> {
    const readme = path.join(result.clientExampleDirectory, "README.md");
    const uri = vscode.Uri.file(readme);

    try {
        await vscode.commands.executeCommand("markdown.showPreview", uri);
        return;
    } catch (error) {
        log(`Could not open the Markdown preview for ${readme}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Markdown preview is a built-in extension, but keep the README reachable if it is disabled.
    try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
        log(`Could not open ${readme}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function firstWorkspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Dev aid: with ARMA_API_TEST_OUTPUT set, each scaffold step is appended to that file. */
function appendScaffoldLog(line: string): void {
    const target = process.env.ARMA_API_TEST_OUTPUT;

    if (!target) {
        return;
    }

    try {
        require("fs").appendFileSync(target, `${line}\n`, "utf8");
    } catch {
        // Best effort only.
    }
}
