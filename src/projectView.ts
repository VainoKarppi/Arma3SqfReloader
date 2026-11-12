import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { evalCode, getStatus, sqfString } from "./api";
import { findMissions } from "./arma";
import { ModType, setModTypeForDirectory } from "./modTypes";
import { HookPresentation, hooksValue, hookValue, logError, presentationValue, readApiPort, readSettings } from "./settings";
import { HOOK_EVENTS } from "./hookEvents";
import { fireHook } from "./hooks";
import {
    ensureProjectSettings,
    projectSetting as getProjectSetting,
    projectSettingsExists,
    projectSettingsPath,
    readProjectSettings,
    setProjectSetting,
    PROJECT_SETTING_DEFAULTS
} from "./projectSettings";
import { refreshDedicatedServerStatus, refreshRunningStatus } from "./launcher";
import { workspaceMods } from "./runtime";
import { normalizeApiHost } from "./ports";
import { armaLogDirectory, findLatestRptPath, readRptTail } from "./rpt";
import { debugConsoleHtml, loadingHtml, projectSettingsHtml, projectViewHtml } from "./projectViewHtml";
import { dismissTutorial, completeTutorialStep, noteTutorialEvent, openTutorialDoc, readTutorial, resetTutorial, setTutorialStep, startTutorial, tutorialSteps } from "./tutorial";
import { workspaceHasNoFiles } from "./workspaceHelpers";
import { clearExampleReady, exampleReady } from "./exampleBanner";

type ExternalModType = "client" | "server" | "off";

interface ExternalMod {
    path: string;
    type: ExternalModType;
}

interface ViewSettings {
    armaDirectory: string;
    armaProfile: string;
    extraLaunchArguments: string;
    serverLaunchArguments: string;
    apiUrl: string;
    watchInterval: number;
    junctionMode: string;
    reloadOnSave: string;
    deletedFunctionBehavior: string;
    runTimeout: number;
    apiPort: number;
    requestTimeout: number;
    enabled: boolean;
    autoJunction: boolean;
    clearArmaMissionArtifacts: boolean;
    notifyOnError: boolean;
    createExampleWithMission: boolean;
    logLevel: string;
    hookPresentation: HookPresentation;
}

const MOD_TYPES: ModType[] = ["client", "server", "off"];
/** Watch expressions are refreshed in one SQF batch; keep the batch small. */
const MAX_WATCHES = 10;
const SETTING_KEYS = new Set<keyof ViewSettings>([
    "armaDirectory", "armaProfile", "extraLaunchArguments", "serverLaunchArguments", "apiUrl",
    "watchInterval", "junctionMode", "reloadOnSave", "deletedFunctionBehavior", "runTimeout",
    "apiPort", "requestTimeout", "enabled", "autoJunction", "clearArmaMissionArtifacts",
    "notifyOnError", "createExampleWithMission", "logLevel", "hookPresentation"
]);

export class ProjectViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private view: vscode.WebviewView | undefined;
    private settingsPanel: vscode.WebviewPanel | undefined;
    private debugPanel: vscode.WebviewPanel | undefined;
    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private watchTimer: ReturnType<typeof setInterval> | undefined;
    private watchBusy = false;
    private projectSettingsReady = false;
    private promptedSettingsFor = "";
    private rptMonitoring = true;
    private rptPath = "";
    private rptTail = "";
    private emptyWorkspaceCache: { value: boolean; at: number } | undefined;

    constructor(private readonly extensionUri: vscode.Uri) {}

    private get root(): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.workspaceFolders?.[0];
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        view.webview.html = projectViewHtml(view.webview);
        view.webview.onDidReceiveMessage(message => {
            void this.handleMessage(message);
        });
        void this.ensureProjectSettings();
        this.restartWatchTimer();
        this.refreshTimer = setInterval(() => void this.refresh(), 2000);
        void this.refresh();
        view.onDidDispose(() => {
            this.view = undefined;
            if (!this.debugPanel && !this.settingsPanel) this.stopTimers();
        });
    }

    dispose(): void {
        this.stopTimers();
    }

    private stopTimers(): void {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        if (this.watchTimer) clearInterval(this.watchTimer);
        this.refreshTimer = undefined;
        this.watchTimer = undefined;
    }

    private async ensureProjectSettings(forcePrompt = false): Promise<void> {
        const root = this.root;
        if (!root) {
            this.projectSettingsReady = false;
            this.promptedSettingsFor = "";
            return;
        }
        // An empty folder has no project yet; the view offers "Create example mod" instead of
        // asking for settings for a project that does not exist.
        if (await this.workspaceIsEmpty()) {
            this.projectSettingsReady = false;
            return;
        }
        const rootPath = root.uri.fsPath;
        const exists = projectSettingsExists(root);
        if (this.promptedSettingsFor !== rootPath) {
            this.projectSettingsReady = exists;
        }
        if (!forcePrompt && this.promptedSettingsFor === rootPath) return;
        this.promptedSettingsFor = rootPath;
        if (exists) {
            this.projectSettingsReady = true;
            // The file may already exist without every setting (for example an empty {}), so the
            // missing defaults are added while existing values are kept.
            await this.initializeProjectSettings();
            void noteTutorialEvent("settings");
            return;
        }

        const create = await vscode.window.showInformationMessage(
            `This Arma project has no .vscode/sqfReloader-settings.json. Create project settings for launch options, mod roles, and debug watches?`,
            "Create Settings",
            "Not Now"
        );
        if (create !== "Create Settings") {
            void this.refresh();
            return;
        }

        try {
            this.projectSettingsReady = true;
            await this.initializeProjectSettings();
            void noteTutorialEvent("settings");
            void this.refresh();
            void vscode.window.showInformationMessage("Created .vscode/sqfReloader-settings.json for this Arma project.");
        } catch (error) {
            logError("could not create project settings", error);
            void vscode.window.showErrorMessage(`Could not create project settings: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleMessage(message: { command?: string; [key: string]: unknown }): Promise<void> {
        try {
            switch (message.command) {
                case "refresh":
                    await this.refresh();
                    break;
                case "createSettings":
                    await this.ensureProjectSettings(true);
                    break;
                case "openSettings":
                    await this.openProjectSettings();
                    break;
                case "addWorkspaceMod":
                    await this.addWorkspaceMod();
                    break;
                case "removeWorkspaceMod":
                    await this.removeWorkspaceMod(message.path);
                    break;
                case "debugConsole":
                    this.openDebugConsole();
                    break;
                case "moveDebugConsoleToNewWindow":
                    await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
                    break;
                case "rptMonitoring":
                    this.rptMonitoring = message.enabled === true;
                    await this.refresh();
                    break;
                case "setting":
                    await this.updateSetting(message.key, message.value);
                    break;
                case "browseArmaDirectory":
                    await this.browseArmaDirectory();
                    break;
                case "editManually":
                    await this.editSettingsManually();
                    break;
                case "launch":
                    await vscode.commands.executeCommand("sqfReloader.play");
                    break;
                case "stop":
                    await vscode.commands.executeCommand("sqfReloader.stop");
                    break;
                case "launchServer":
                    await vscode.commands.executeCommand("sqfReloader.startDedicatedServer");
                    break;
                case "stopServer":
                    await vscode.commands.executeCommand("sqfReloader.stopDedicatedServer");
                    break;
                case "launchHosted":
                    await this.launchHostedServer();
                    break;
                case "openRpt":
                    this.openRptFolder();
                    break;
                case "openRptFile": {
                    const file = await findLatestRptPath();
                    if (!file) throw new Error("No Arma RPT file was found.");
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                    await vscode.window.showTextDocument(document, { preview: true });
                    break;
                }
                case "addMod":
                    await this.addExternalMod();
                    break;
                case "modType":
                    await this.updateModType(message.path, message.value);
                    break;
                case "externalModType":
                    await this.updateExternalModType(message.path, message.value);
                    break;
                case "removeExternalMod":
                    await this.removeExternalMod(message.path);
                    break;
                case "execute":
                    await this.executeCode(message.code);
                    break;
                case "addWatch":
                    await this.addWatch(message.expression);
                    break;
                case "removeWatch":
                    await this.removeWatch(message.expression);
                    break;
                case "tutorialStart": {
                    const progress = readTutorial();
                    if (projectSettingsExists(this.root)) await completeTutorialStep("settings");
                    await startTutorial();
                    if (progress.sampleWorkspace) void vscode.commands.executeCommand("sqfReloader.projectView.focus");
                    await this.refresh();
                    break;
                }
                case "tutorialDismiss":
                    await dismissTutorial();
                    await this.refresh();
                    break;
                case "tutorialReset":
                    await resetTutorial();
                    await this.refresh();
                    break;
                case "tutorialStep":
                    await setTutorialStep(String(message.id ?? ""), message.done !== false);
                    await this.refresh();
                    break;
                case "tutorialDoc":
                    await openTutorialDoc(String(message.id ?? ""));
                    break;
                case "createExample":
                    await vscode.commands.executeCommand("sqfReloader.createExample");
                    this.emptyWorkspaceCache = undefined;
                    await this.refresh();
                    break;
                case "exampleReadyPlay":
                    clearExampleReady();
                    await vscode.commands.executeCommand("sqfReloader.play");
                    await this.refresh();
                    break;
                case "exampleReadyServer":
                    clearExampleReady();
                    await vscode.commands.executeCommand("sqfReloader.startDedicatedServer");
                    await this.refresh();
                    break;
                case "exampleReadyDismiss":
                    clearExampleReady();
                    await this.refresh();
                    break;
            }
        } catch (error) {
            logError(`project view command failed (${message.command ?? "unknown"})`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (message.command !== "execute") {
                void vscode.window.showErrorMessage(`Arma project: ${errorMessage}`);
            }
            this.post({ type: "error", message: errorMessage });
        }
    }

    private async openProjectSettings(): Promise<void> {
        if (this.settingsPanel) {
            this.settingsPanel.reveal(vscode.ViewColumn.One);
            return;
        }
        if (!this.root) throw new Error("Open an Arma project folder first.");
        // Also fills in settings that are missing from an existing file before the panel opens.
        await this.ensureProjectSettings(true);
        if (!projectSettingsExists(this.root)) return;

        const panel = vscode.window.createWebviewPanel(
            "sqfReloader.projectSettings",
            "Arma Project Settings",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.settingsPanel = panel;
        panel.webview.html = loadingHtml(panel.webview, "Loading Arma Project Settings...");
        panel.webview.onDidReceiveMessage(message => {
            void this.handleMessage(message);
        });
        panel.onDidDispose(() => {
            this.settingsPanel = undefined;
            if (!this.view && !this.debugPanel && !this.settingsPanel) this.stopTimers();
        });
        if (!this.refreshTimer) this.refreshTimer = setInterval(() => void this.refresh(), 2000);
        setTimeout(() => {
            if (this.settingsPanel !== panel) return;
            panel.webview.html = projectSettingsHtml(panel.webview);
            void this.refresh();
        }, 0);
    }

    private async editSettingsManually(): Promise<void> {
        if (!this.root) throw new Error("Open an Arma project folder first.");
        await this.ensureProjectSettings(true);
        const settingsFile = projectSettingsPath(this.root);
        if (!settingsFile || !fs.existsSync(settingsFile)) return;
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(settingsFile));
        await vscode.window.showTextDocument(document, {
            preview: false,
            viewColumn: vscode.ViewColumn.One
        });
    }

    private async browseArmaDirectory(): Promise<void> {
        const configuredPath = this.setting("armaDirectory", "").trim();
        const defaultUri = configuredPath && fs.existsSync(configuredPath)
            ? vscode.Uri.file(configuredPath)
            : this.root?.uri;
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri,
            openLabel: "Select Arma 3 installation folder"
        });
        if (!selected?.length) return;
        const directory = selected[0].fsPath;
        // The folder is handed back to the view so the field shows it, but it is not written to
        // settings.json: the setting stays empty and the detection result lives in memory.
        this.post({ type: "armaDirectoryBrowsed", value: directory });
    }

    private openDebugConsole(): void {
        void noteTutorialEvent("console");
        if (this.debugPanel) {
            this.debugPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "sqfReloader.debugConsole",
            "Arma Debug Console",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.debugPanel = panel;
        panel.webview.html = loadingHtml(panel.webview, "Loading Arma Debug Console...");
        this.rptMonitoring = true;
        panel.webview.onDidReceiveMessage(message => {
            void this.handleMessage(message);
        });
        panel.onDidDispose(() => {
            this.debugPanel = undefined;
            if (!this.view && !this.settingsPanel) this.stopTimers();
        });
        if (!this.refreshTimer) this.refreshTimer = setInterval(() => void this.refresh(), 2000);
        this.restartWatchTimer();
        setTimeout(() => {
            if (this.debugPanel !== panel) return;
            panel.webview.html = debugConsoleHtml(panel.webview);
            void this.refresh();
        }, 0);
    }

    private openRptFolder(): void {
        const directory = armaLogDirectory();
        if (!fs.existsSync(directory)) throw new Error(`Arma log folder not found: ${directory}`);
        const executable = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
        const explorer = spawn(executable, [directory], { detached: true, stdio: "ignore" });
        explorer.once("error", error => {
            logError("could not open Arma RPT folder", error);
            void vscode.window.showErrorMessage(`Could not open Arma RPT folder: ${error.message}`);
        });
        explorer.unref();
    }

    private async refreshRpt(): Promise<void> {
        try {
            this.rptPath = await findLatestRptPath();
            this.rptTail = this.rptPath ? await readRptTail(this.rptPath) : "";
        } catch (error) {
            const message = `Could not update RPT logs: ${error instanceof Error ? error.message : String(error)}`;
            logError("could not update RPT logs", error);
            this.rptPath = "";
            this.rptTail = message;
        }
    }

    private async initializeProjectSettings(): Promise<void> {
        if (!this.root) return;
        const existing = readProjectSettings(this.root);
        // Mods discovered in the workspace are written as "off" so a project never launches a
        // folder the user has not opted into; an existing role in the file is kept as is.
        const configuredModTypes = existing.modTypes;
        const modTypes: Record<string, unknown> = configuredModTypes && typeof configuredModTypes === "object" && !Array.isArray(configuredModTypes)
            ? { ...(configuredModTypes as Record<string, unknown>) }
            : {};
        let modTypesChanged = false;
        for (const modPath of this.discoveredWorkspaceModPaths()) {
            if (!(modPath in modTypes)) {
                modTypes[modPath] = "off";
                modTypesChanged = true;
            }
        }

        // armaDirectory is deliberately not part of the defaults: the folder is detected once
        // from the registry / Steam libraries and kept in memory for the session.
        await ensureProjectSettings(PROJECT_SETTING_DEFAULTS, this.root);
        if (modTypesChanged) await setProjectSetting("modTypes", modTypes, this.root);
    }

    private async updateSetting(key: unknown, value: unknown): Promise<void> {
        if (key === "hook") {
            await this.saveHook(value);
            await this.refresh();
            this.post({ type: "settingSaved" });
            return;
        }
        if (typeof key !== "string" || !SETTING_KEYS.has(key as keyof ViewSettings)) {
            throw new Error("Unsupported project setting.");
        }
        if (key === "watchInterval") {
            value = clampNumber(value, 100, 60000);
        } else if (key === "runTimeout") {
            value = clampNumber(value, 1, 300);
        } else if (key === "apiPort") {
            value = clampNumber(value, 1, 65535);
        } else if (key === "requestTimeout") {
            value = clampNumber(value, 500, 60000);
        } else if (key === "hookPresentation") {
            value = presentationValue({ hookPresentation: value }, "hookPresentation");
        } else if (key === "deletedFunctionBehavior") {
            if (value !== "clear" && value !== "ask" && value !== "keep") {
                throw new Error("Invalid deleted function behavior.");
            }
        } else if (["enabled", "autoJunction", "clearArmaMissionArtifacts", "notifyOnError", "createExampleWithMission"].includes(key)) {
            if (typeof value !== "boolean") throw new Error("Setting value must be a boolean.");
        } else if (typeof value !== "string") {
            throw new Error("Setting value must be text.");
        }
        if (key === "apiUrl" && typeof value === "string" && value.trim()) {
            value = normalizeApiHost(value.trim());
        }
        await this.saveSetting(key, value);
        if (key === "watchInterval") this.restartWatchTimer();
        await this.refresh();
        this.post({ type: "settingSaved" });
    }

    private async saveHook(value: unknown): Promise<void> {
        if (!this.root) throw new Error("Open an Arma project folder first.");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hook.");
        const source = value as Record<string, unknown>;
        const definition = HOOK_EVENTS.find(item => item.event === source.event);
        if (typeof source.event !== "string" || !definition) throw new Error("Unknown hook event.");

        const raw = readProjectSettings(this.root);
        const hooks = raw.hooks && typeof raw.hooks === "object" && !Array.isArray(raw.hooks)
            ? { ...(raw.hooks as Record<string, unknown>) }
            : {};
        // The panel edits commands and flags only, so a hand-written presentation override must
        // survive when the hook is saved from the panel.
        const existing = hooks[source.event];
        const payload = { ...source };
        if (!("presentation" in payload) && existing && typeof existing === "object" && !Array.isArray(existing)) {
            const existingPresentation = (existing as Record<string, unknown>).presentation;
            if (existingPresentation) payload.presentation = existingPresentation;
        }

        const cleaned = hookValue(payload, definition.blocking);
        hooks[source.event] = {
            commands: cleaned.commands,
            blocking: cleaned.blocking,
            continueOnError: cleaned.continueOnError,
            ...(cleaned.presentation ? { presentation: cleaned.presentation } : {})
        };
        await setProjectSetting("hooks", hooks, this.root);
    }

    private async saveSetting(key: string, value: unknown): Promise<void> {
        if (!this.root) throw new Error("Open an Arma project folder first.");
        if (!projectSettingsExists(this.root)) {
            throw new Error("Create the project .vscode/sqfReloader-settings.json before changing project settings.");
        }
        await setProjectSetting(key, value, this.root);
    }

    private async addExternalMod(): Promise<void> {
        if (!this.root) throw new Error("Open an Arma project folder first.");
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: true,
            defaultUri: this.armaDirectoryUri(),
            openLabel: "Add Arma mod folder"
        });
        if (!selected?.length) return;

        const mods = this.externalMods();
        for (const uri of selected) {
            if (!fs.existsSync(path.join(uri.fsPath, "addons"))) {
                const proceed = await vscode.window.showWarningMessage(
                    `${path.basename(uri.fsPath)} has no root addons folder. Add it anyway?`,
                    { modal: true },
                    "Add Anyway"
                );
                if (proceed !== "Add Anyway") continue;
            }
            if (!mods.some(mod => samePath(mod.path, uri.fsPath))) {
                mods.push({ path: uri.fsPath, type: "client" });
            }
        }
        await this.saveSetting("externalMods", mods);
        fireHook("onModConfigChanged", readSettings(), { file: selected[0].fsPath });
        await this.refresh();
    }

    private armaDirectoryUri(): vscode.Uri | undefined {
        const configuredPath = this.setting("armaDirectory", "").trim();
        if (configuredPath && fs.existsSync(configuredPath)) return vscode.Uri.file(configuredPath);
        return this.root?.uri;
    }

    private async addWorkspaceMod(): Promise<void> {
        if (!this.root) throw new Error("Open an Arma project folder first.");
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: this.root.uri,
            openLabel: "Select workspace mod folder"
        });
        if (!selected?.length) return;
        await this.updateModType(selected[0].fsPath, "client");
    }

    private async launchHostedServer(): Promise<void> {
        if (!this.root) throw new Error("Open an Arma project folder first.");
        const missions = findMissions([this.root.uri.fsPath])
            .filter(mission => mission.multiplayer && mission.maxPlayers !== undefined && mission.maxPlayers > 1);
        if (missions.length === 0) {
            throw new Error("No multiplayer mission with maxPlayers greater than 1 was found in this project.");
        }
        const selected = await vscode.window.showQuickPick(missions.map(mission => ({
            label: path.basename(mission.directory),
            description: mission.directory,
            mission
        })), { placeHolder: "Select a mission to host from Arma 3" });
        if (!selected) return;
        await vscode.commands.executeCommand(
            "sqfReloader.hostMission",
            vscode.Uri.file(path.join(selected.mission.directory, "mission.sqm"))
        );
    }

    private async updateModType(directory: unknown, type: unknown): Promise<void> {
        if (typeof directory !== "string" || (type !== "unclassified" && !isModType(type))) {
            throw new Error("Invalid mod selection.");
        }
        if (!this.root) throw new Error("Open an Arma project folder first.");
        const modDirectory = path.isAbsolute(directory) ? directory : path.resolve(this.root.uri.fsPath, directory);
        await setModTypeForDirectory(modDirectory, type === "unclassified" ? undefined : type);
        await this.refresh();
    }

    private async removeWorkspaceMod(directory: unknown): Promise<void> {
        if (typeof directory !== "string" || !directory) throw new Error("Invalid workspace mod path.");
        // A workspace mod is discovered from the folder tree, so "removing" it means keeping it
        // out of the launch instead of deleting anything from disk.
        await this.updateModType(directory, "off");
    }

    private async updateExternalModType(directory: unknown, type: unknown): Promise<void> {
        if (typeof directory !== "string" || !isExternalModType(type)) throw new Error("Invalid external mod selection.");
        const mods = this.externalMods();
        const mod = mods.find(item => samePath(item.path, directory));
        if (!mod) throw new Error("External mod was not found in project settings.");
        mod.type = type;
        await this.saveSetting("externalMods", mods);
        fireHook("onModConfigChanged", readSettings(), { file: directory });
        await this.refresh();
    }

    private async removeExternalMod(directory: unknown): Promise<void> {
        if (typeof directory !== "string") throw new Error("Invalid external mod path.");
        await this.saveSetting("externalMods", this.externalMods().filter(mod => !samePath(mod.path, directory)));
        fireHook("onModConfigChanged", readSettings(), { file: directory });
        await this.refresh();
    }

    private async executeCode(code: unknown): Promise<void> {
        if (typeof code !== "string" || !code.trim()) throw new Error("Enter SQF code to execute.");
        const settings = readSettings();
        const status = await getStatus(settings);
        if (status.gameConnected !== true) {
            throw new Error(`SqfReloader API is reachable on ${settings.apiUrl}, but no Arma game callback is connected.`);
        }
        const result = await evalCode(settings, code, settings.runTimeout * 1000);
        const output = result.text !== undefined
            ? formatSqfText(result.text)
            : result.result === undefined ? "nil" : formatSqfText(formatResult(result.result));
        this.post({
            type: "execution",
            result: result.success ? output : result.error ?? "Execution failed.",
            isError: !result.success
        });
    }

    private async addWatch(expression: unknown): Promise<void> {
        if (typeof expression !== "string" || !expression.trim()) throw new Error("Enter an SQF expression to watch.");
        const watches = this.watchExpressions();
        const trimmed = expression.trim();
        if (!watches.includes(trimmed) && watches.length >= MAX_WATCHES) {
            throw new Error(`Watch expressions are limited to ${MAX_WATCHES}. Remove one before adding another.`);
        }
        if (!watches.includes(trimmed)) watches.push(trimmed);
        await this.saveSetting("watchExpressions", watches);
        this.restartWatchTimer();
        await this.refresh();
    }

    private async removeWatch(expression: unknown): Promise<void> {
        if (typeof expression !== "string") throw new Error("Invalid watch expression.");
        await this.saveSetting("watchExpressions", this.watchExpressions().filter(item => item !== expression));
        await this.refresh();
    }

    private restartWatchTimer(): void {
        if (this.watchTimer) clearInterval(this.watchTimer);
        if (!this.view && !this.debugPanel && !this.settingsPanel) return;
        const interval = clampNumber(this.setting("watchInterval", 1000), 1000, 60000);
        this.watchTimer = setInterval(() => void this.refreshWatches(), interval);
    }

    private async refreshWatches(): Promise<void> {
        const watches = this.watchExpressions();
        if (this.watchBusy || watches.length === 0 || (!this.view && !this.debugPanel && !this.settingsPanel)) return;
        this.watchBusy = true;
        try {
            const settings = readSettings();
            const status = await getStatus(settings);
            if (status.gameConnected !== true) {
                this.post({
                    type: "watchValues",
                    values: watches.map(expression => ({ expression, value: "Arma is not connected.", isError: true }))
                });
                return;
            }
            const code = `[${watches.map(sqfString).join(",")}] call SqfReloader_fnc_evalWatch`;
            const result = await evalCode(settings, code, settings.runTimeout * 1000);
            // evalWatch returns [[expression, str (value)], ...], which the API parses back into
            // this array; each value is already Arma formatted text.
            const entries = result.success && Array.isArray(result.result) ? result.result : [];
            const values = result.success
                ? watches.map((expression, index) => {
                    const entry = entries[index];
                    const value = Array.isArray(entry) && typeof entry[1] === "string" ? formatSqfText(entry[1]) : undefined;
                    return { expression, value: value ?? "No value returned.", isError: false };
                })
                : watches.map(expression => ({ expression, value: result.error ?? "Watch evaluation failed.", isError: true }));
            this.post({ type: "watchValues", values });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.post({
                type: "watchValues",
                values: this.watchExpressions().map(expression => ({ expression, value: message, isError: true }))
            });
        } finally {
            this.watchBusy = false;
        }
    }

    /**
     * Every workspace mod the extension would pass to Arma, with its launch role. A mod without a
     * saved role is reported as "unclassified" (the panel shows it as Client) so a discovered
     * folder such as an unpacked server source tree is visible and can be set to Not Used instead
     * of being launched invisibly.
     */
    private workspaceModRoles(): Array<{ path: string; type: string }> {
        const roles = this.setting<Record<string, unknown>>("modTypes", {});
        return this.discoveredWorkspaceModPaths().map(modPath => {
            const type = roles[modPath];
            return { path: modPath, type: typeof type === "string" ? type : "unclassified" };
        });
    }

    /** Workspace mod folders the extension discovers, as paths relative to the project root. */
    private discoveredWorkspaceModPaths(): string[] {
        if (!this.root) return [];
        const rootPath = this.root.uri.fsPath;
        return workspaceMods()
            .map(mod => path.relative(rootPath, mod.directory).replace(/\\/g, "/") || ".")
            .sort((left, right) => left.localeCompare(right));
    }

    private setting<T>(key: string, fallback: T): T {
        if (!this.root) return fallback;
        return getProjectSetting(key, fallback, this.root);
    }

    /**
     * Reads a setting from the project settings file only. The settings panel edits
     * .vscode/sqfReloader-settings.json, so no inherited user-level value can look like a project
     * setting - armaDirectory in particular is auto-detected and never written by this extension.
     */
    private projectSetting<T>(key: string, fallback: T): T {
        return this.setting(key, fallback);
    }

    private externalMods(): ExternalMod[] {
        const value = this.setting<unknown>("externalMods", []);
        if (!Array.isArray(value)) return [];
        const mods: ExternalMod[] = [];
        for (const item of value) {
            if (!item || typeof item !== "object") continue;
            const entry = item as { path?: unknown; type?: unknown };
            if (typeof entry.path !== "string") continue;
            // A removed "both" (Shared Mod) role is kept and shown as a client mod.
            const type = entry.type === "both" ? "client" : entry.type;
            if (!isExternalModType(type)) continue;
            mods.push({ path: entry.path, type });
        }
        return mods;
    }

    private watchExpressions(): string[] {
        const value = this.setting<unknown>("watchExpressions", []);
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    }

    private async refresh(): Promise<void> {
        if (!this.view && !this.debugPanel && !this.settingsPanel) return;
        if (this.root && this.promptedSettingsFor !== this.root.uri.fsPath) {
            void this.ensureProjectSettings();
        }
        const rootPath = this.root?.uri.fsPath;
        const settings = readSettings();
        // One API for every instance: client, editor, hosted mission and dedicated server.
        const [apiStatus, running, dedicatedServerRunning] = await Promise.all([
            getStatus(settings).catch(() => undefined),
            refreshRunningStatus(),
            refreshDedicatedServerStatus()
        ] as const);
        // There is one API for every Arma instance, so a single connection flag describes it.
        const clientConnected = apiStatus?.gameConnected === true;
        // Only a real arma3server_x64.exe process flips the button to "Stop": a leftover API
        // answer must not claim the server is running when the process is gone.
        const serverRunning = dedicatedServerRunning === true;
        if (this.debugPanel?.visible && this.rptMonitoring) await this.refreshRpt();

        const tutorial = readTutorial();
        const tutorialStepList = tutorialSteps();
        const emptyWorkspace = await this.workspaceIsEmpty();
        this.post({
            type: "state",
            project: this.root?.name ?? "No folder open",
            projectRoot: rootPath ?? "",
            projectSettingsReady: this.projectSettingsReady || projectSettingsExists(this.root),
            exampleReady: exampleReady(),
            emptyWorkspace,
            tutorial: {
                sampleWorkspace: tutorial.sampleWorkspace,
                started: tutorial.started,
                dismissed: tutorial.dismissed,
                steps: tutorialStepList,
                completed: tutorialStepList.filter(step => step.done).length,
                total: tutorialStepList.length
            },
            settings: this.viewSettings(),
            hooks: hooksValue(readProjectSettings(this.root)),
            hookEvents: HOOK_EVENTS,
            watches: this.watchExpressions(),
            modTypes: this.setting<Record<string, unknown>>("modTypes", {}),
            workspaceMods: this.workspaceModRoles(),
            externalMods: this.externalMods(),
            clientConnected,
            dedicatedServerRunning: serverRunning,
            rptMonitoring: this.rptMonitoring,
            rptPath: this.rptPath,
            rptTail: this.rptTail,
            running
        });
    }

    /** True when the workspace has no files at all; cached so the 2 s refresh does not scan. */
    private async workspaceIsEmpty(): Promise<boolean> {
        if (!this.root) return false;
        if (this.emptyWorkspaceCache && Date.now() - this.emptyWorkspaceCache.at < 5000) {
            return this.emptyWorkspaceCache.value;
        }

        const value = await workspaceHasNoFiles();
        this.emptyWorkspaceCache = { value, at: Date.now() };
        return value;
    }

    private viewSettings(): ViewSettings {        return {
            armaDirectory: this.projectSetting("armaDirectory", ""),
            armaProfile: this.setting("armaProfile", ""),
            extraLaunchArguments: this.setting("extraLaunchArguments", "-noSplash -skipIntro -noPause"),
            serverLaunchArguments: this.setting("serverLaunchArguments", ""),
            apiUrl: normalizeApiHost(this.setting("apiUrl", "http://127.0.0.1")),
            watchInterval: clampNumber(this.setting("watchInterval", 1000), 1000, 60000),
            junctionMode: this.setting("junctionMode", "addon"),
            reloadOnSave: this.setting("reloadOnSave", "reload"),
            deletedFunctionBehavior: this.setting("deletedFunctionBehavior", "keep"),
            runTimeout: clampNumber(this.setting("runTimeout", 30), 1, 300),
            apiPort: readApiPort(readProjectSettings(this.root)),
            requestTimeout: clampNumber(this.setting("requestTimeout", 3000), 500, 60000),
            enabled: this.setting("enabled", true),
            autoJunction: this.setting("autoJunction", true),
            clearArmaMissionArtifacts: this.setting("clearArmaMissionArtifacts", true),
            notifyOnError: this.setting("notifyOnError", true),
            createExampleWithMission: this.setting("createExampleWithMission", true),
            logLevel: this.setting("logLevel", "info"),
            hookPresentation: presentationValue(readProjectSettings(this.root), "hookPresentation")
        };
    }

    private post(message: unknown): void {
        void this.view?.webview.postMessage(message);
        void this.settingsPanel?.webview.postMessage(message);
        void this.debugPanel?.webview.postMessage(message);
    }

}

function clampNumber(value: unknown, minimum: number, maximum: number): number {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, Math.round(numeric))) : minimum;
}

function isModType(value: unknown): value is ModType {
    return MOD_TYPES.includes(value as ModType);
}

function isExternalModType(value: unknown): value is ExternalModType {
    return value === "client" || value === "server" || value === "off";
}

function samePath(left: string, right: string): boolean {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function formatResult(result: unknown): string {
    return typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? String(result);
}

/**
 * Removes one quoting level from SQF text so values print like Arma's debug console output:
 * `"[[...]]"` -> `[[...]]` and `[""respawn_west""]` -> `["respawn_west"]`. Text that is not a
 * quoted literal is returned unchanged.
 */
function formatSqfText(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length > 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
        return trimmed.slice(1, -1).replace(/""/g, "\"").trim();
    }
    return trimmed;
}
