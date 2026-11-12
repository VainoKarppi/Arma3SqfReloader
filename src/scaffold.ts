import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findMods, Mod } from "./arma";
import { log, readSettings } from "./settings";
import { PROJECT_SETTINGS_FILE } from "./projectSettings";

/** Tag of the generated example mod; drives the SqfReloader runtime path and function names. */
export const TEMPLATE_TAG = "example";
export const TEMPLATE_MOD_NAME = "@ExampleMod";
const TEMPLATE_SOURCE_DIRECTORY = path.resolve(__dirname, "..", "examples", "armaExamples");

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
    /** Single-player mission (missions\example.Altis). */
    missionDirectory?: string;
    /** Multiplayer mission (mpmissions\example.Altis). */
    mpMissionDirectory?: string;
    /** Server mod/config/mission example directory. */
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
 */
export function writeTemplate(root: string, withMission: boolean, force: boolean): ScaffoldResult {
    const modDirectory = path.join(root, TEMPLATE_MOD_NAME);
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
        path.join(TEMPLATE_SOURCE_DIRECTORY, "client-example"),
        root,
        write,
        relativePath => {
            const topLevelDirectory = relativePath.split(path.sep)[0];
            return topLevelDirectory !== ".vscode"
                && (withMission || !["missions", "mpmissions"].includes(topLevelDirectory));
        }
    );

    // The project settings file belongs to the user once it exists: recreating the template must
    // never reset launch options or mod roles that were configured in the project settings panel.
    const settingsFile = path.join(root, ".vscode", PROJECT_SETTINGS_FILE);
    if (fs.existsSync(settingsFile)) {
        skipped.push(settingsFile);
    } else {
        const settingsTemplate = path.join(
            TEMPLATE_SOURCE_DIRECTORY,
            "client-example",
            ".vscode",
            PROJECT_SETTINGS_FILE
        );
        if (!fs.existsSync(settingsTemplate)) {
            throw new Error(`Example project settings template not found: ${settingsTemplate}`);
        }
        write(settingsFile, fs.readFileSync(settingsTemplate, "utf8"));
    }

    const missionDirectory = withMission ? path.join(root, "missions", `${TEMPLATE_TAG}.Altis`) : undefined;
    const mpMissionDirectory = withMission ? path.join(root, "mpmissions", `${TEMPLATE_TAG}.Altis`) : undefined;
    const serverExampleDirectory = copyTemplateDirectory(
        path.join(TEMPLATE_SOURCE_DIRECTORY, "server-example"),
        path.join(root, "server-example"),
        write
    );

    return { modDirectory, files, skipped, missionDirectory, mpMissionDirectory, serverExampleDirectory };
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

/** The generated example mod, when it exists in the workspace. */
export function exampleMod(root: string): Mod | undefined {
    return findMods(root).find(mod => mod.name.toLowerCase() === TEMPLATE_MOD_NAME.toLowerCase());
}

async function askForMission(): Promise<boolean> {
    const choice = await vscode.window.showQuickPick(
        [
            { label: "Mod + test mission", description: "Also writes missions\\example.Altis and mpmissions\\example.Altis, which call the functions on spawn.", value: true },
            { label: "Mod only", description: "Use the example functions in your own mission.", value: false }
        ],
        { title: "Arma 3 SQF Reloader: example mod", ignoreFocusOut: true }
    );

    return choice?.value ?? true;
}

/** Opens the two files a developer edits first. */
async function revealExample(result: ScaffoldResult): Promise<void> {
    const hello = result.files.find(file => file.endsWith("fn_hello.sqf"));
    const config = result.files.find(file => file.endsWith("config.cpp") && file.includes(`${TEMPLATE_MOD_NAME}${path.sep}addons${path.sep}`));

    for (const file of [config, hello]) {
        if (!file) {
            continue;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            await vscode.window.showTextDocument(document, { preview: false });
        } catch (error) {
            log(`Could not open ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (result.serverExampleDirectory) {
            try {
                const document = await vscode.workspace.openTextDocument(
                    vscode.Uri.file(path.join(result.serverExampleDirectory, "README.md"))
                );
                await vscode.window.showTextDocument(document, { preview: false });
            } catch (error) {
                log(`Could not open server example README: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
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
