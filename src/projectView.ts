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
import { DEFAULT_PORT, normalizeApiHost } from "./ports";
import { armaLogDirectory, findLatestRptPath, readRptTail } from "./rpt";

type ExternalModType = "client" | "server" | "both" | "off";

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

const MOD_TYPES: ModType[] = ["client", "server", "both", "off"];
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

    constructor(private readonly extensionUri: vscode.Uri) {}

    private get root(): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.workspaceFolders?.[0];
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        view.webview.html = this.html(view.webview);
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
        panel.webview.html = this.loadingHtml(panel.webview, "Loading Arma Project Settings...");
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
            panel.webview.html = this.projectSettingsHtml(panel.webview);
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
        panel.webview.html = this.loadingHtml(panel.webview, "Loading Arma Debug Console...");
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
            panel.webview.html = this.debugConsoleHtml(panel.webview);
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

    private loadingHtml(webview: vscode.Webview, message: string): string {
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);display:flex;align-items:center;justify-content:center;height:90vh}
.loader{display:flex;align-items:center;gap:12px}.spinner{width:18px;height:18px;border:2px solid var(--vscode-progressBar-background);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="loader"><span class="spinner"></span><span>${message}</span></div></body></html>`;
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
        return value.filter((item): item is ExternalMod =>
            !!item && typeof item === "object"
            && typeof (item as ExternalMod).path === "string"
            && isModType((item as ExternalMod).type));
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

        this.post({
            type: "state",
            project: this.root?.name ?? "No folder open",
            projectRoot: rootPath ?? "",
            projectSettingsReady: this.projectSettingsReady || projectSettingsExists(this.root),
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

    private viewSettings(): ViewSettings {
        return {
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

    private html(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:8px}
h2{font-size:1.15em;margin:8px 0 14px}
button{display:flex;align-items:center;gap:8px;font:inherit;cursor:pointer;width:100%;text-align:left;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px;padding:8px;margin:3px 0}
button svg{width:16px;height:16px;flex:none}
/* Same button flips to "Stop Dedicated Server" while the server runs; deep yellow keeps the
   white label readable (the theme's bright charts yellow washes it out). */
#dedicatedServer[data-command=stopServer]{background:#8f6b00;color:#fff;font-weight:600}
#dedicatedServer[data-command=stopServer]:hover{background:#a17a00;filter:none}
.status{padding:8px;background:var(--vscode-editor-background);margin-top:12px;line-height:1.6}.muted{color:var(--vscode-descriptionForeground);font-size:.9em}
.status .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
.dot.ok{background:var(--vscode-testing-iconPassed,#3fb950)}.dot.bad{background:var(--vscode-testing-iconFailed,#f85149)}
.dot.starting{background:var(--vscode-charts-blue,#3794ff)}
.dot.idle{background:var(--vscode-descriptionForeground,#8b949e)}
</style></head><body>
<h2 id="project">Arma Project</h2>
<button data-command="openSettings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h6m4 0h6M4 17h2m4 0h10"/><circle cx="12" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg><span>Create / Edit Project Settings</span></button>
<button data-command="debugConsole"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></svg><span>Debug Console</span></button>
<button id="dedicatedServer" data-command="launchServer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="8" rx="1"/><rect x="4" y="13" width="16" height="8" rx="1"/><path d="M8 7h.01M11 7h5m-8 10h.01m3 0h5"/></svg><span class="button-label">Start Dedicated Server</span></button>
<button data-command="launchHosted"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 3.5 4.8"/></svg><span>Host Mission</span></button>
<div class="status" id="status">Checking status...</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({command:button.dataset.command})));
function statusItem(label,tone,text){const dot=document.createElement('span');dot.className='dot '+tone;const value=document.createElement('span');value.textContent=label+': '+text;const line=document.createElement('div');line.append(dot,value);return line}
// The .exe exists (process running) but Arma has not reached the SqfReloader API yet: "Starting...".
function processStatus(running,connected){if(typeof running!=='boolean')return['idle','Unknown'];if(!running)return['bad','Stopped'];return connected?['ok','Running']:['starting','Starting...']}
function apiStatus(connected,running){if(connected)return['ok','Running'];if(running)return['starting','Starting...'];return['idle','Stopped']}
window.addEventListener('message',event=>{if(event.data.type==='state'){const state=event.data;document.getElementById('project').textContent=state.project;const status=document.getElementById('status');const anyProcessRunning=state.running===true||state.dedicatedServerRunning===true;const game=processStatus(state.running,state.clientConnected);const api=apiStatus(state.clientConnected,anyProcessRunning);const server=processStatus(state.dedicatedServerRunning,state.clientConnected);status.replaceChildren(statusItem('Game',game[0],game[1]),statusItem('Dedicated Server',server[0],server[1]),statusItem('API',api[0],api[1]));const serverButton=document.getElementById('dedicatedServer');serverButton.querySelector('.button-label').textContent=state.dedicatedServerRunning?'Stop Dedicated Server':'Start Dedicated Server';serverButton.dataset.command=state.dedicatedServerRunning?'stopServer':'launchServer'}});
</script></body></html>`;
    }

    private projectSettingsHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Arma Project Settings</title>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--radius:9px;--line:var(--vscode-widget-border,var(--vscode-panel-border));--card:var(--vscode-editorWidget-background,var(--vscode-editor-background));--muted:var(--vscode-descriptionForeground);--mono:var(--vscode-editor-font-family,monospace)}
html,body{margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.45;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
code{font-family:var(--mono);font-size:.95em;background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:4px}
.wrap{max-width:1180px;margin:0 auto;padding:0 22px 40px}
.top{position:sticky;top:0;z-index:9;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;padding:16px 0 13px;background:var(--vscode-editor-background);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.logo{display:grid;place-items:center;width:40px;height:40px;flex:0 0 auto;border-radius:11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.logo svg{width:21px;height:21px}
.titles{min-width:0}
h1{margin:0;font-size:1.22em;font-weight:600;letter-spacing:.01em}
.subline{display:flex;align-items:center;gap:7px;margin-top:2px;min-width:0;font-size:.84em;color:var(--muted)}
.dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:var(--vscode-testing-iconPassed)}
#project{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.saved{font-size:.84em;color:var(--muted);padding:4px 11px;border-radius:999px;transition:background .15s ease,color .15s ease}
.saved:not(:empty){background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.saved[data-state=ok]{color:var(--vscode-testing-iconPassed)}
.saved[data-state=error]{color:var(--vscode-errorForeground,var(--vscode-testing-iconFailed))}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:.92em;padding:6px 13px;border:1px solid transparent;border-radius:6px;cursor:pointer;white-space:nowrap;background:var(--vscode-button-background);color:var(--vscode-button-foreground);transition:background .12s ease,border-color .12s ease,opacity .12s ease}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn.ghost{background:transparent;color:var(--vscode-foreground);border-color:var(--line)}
.btn.ghost:hover{background:var(--vscode-button-secondaryBackground);border-color:var(--vscode-focusBorder)}
.btn.small{padding:4px 10px;font-size:.84em}
.btn:disabled{opacity:.4;cursor:default;background:transparent;border-color:var(--line);color:var(--muted)}
.btn:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;margin-top:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px 18px}
.card.wide{grid-column:1/-1}
.card h2{margin:0 0 3px;font-size:1em;font-weight:600}
.card h3{margin:20px 0 3px;font-size:.94em;font-weight:600}
.hint{margin:0 0 12px;font-size:.85em;color:var(--muted)}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:13px 16px;margin-top:13px}
.field{display:flex;flex-direction:column;gap:5px;min-width:0;margin:0}
.field.wide{grid-column:1/-1}
.label{font-size:.83em;color:var(--muted);letter-spacing:.02em}
input[type=text],input[type=number],select,textarea{width:100%;font:inherit;padding:7px 9px;border:1px solid var(--vscode-input-border,var(--line));border-radius:6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background)}
textarea{min-height:84px;resize:vertical;font-family:var(--mono);font-size:.92em}
input[type=text]:focus,input[type=number]:focus,select:focus,textarea:focus{outline:none;border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder)}
input::placeholder{color:var(--muted)}
.path-picker{display:flex;gap:8px}
.path-picker input{flex:1;min-width:0;font-family:var(--mono);font-size:.94em}
.field-hint{margin:-2px 0 0;font-size:.81em}
.toggles{display:flex;flex-direction:column;gap:1px;margin-top:14px;padding-top:13px;border-top:1px solid var(--line)}
.toggle{display:flex;align-items:center;gap:11px;padding:7px 9px;border-radius:6px;font-size:.92em;cursor:pointer}
.toggle:hover{background:var(--vscode-list-hoverBackground)}
.toggle input{appearance:none;-webkit-appearance:none;position:relative;flex:0 0 auto;width:34px;height:18px;margin:0;border:1px solid var(--vscode-input-border,var(--line));border-radius:999px;background:var(--vscode-input-background);cursor:pointer;transition:background .15s ease,border-color .15s ease}
.toggle input::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--muted);transition:transform .15s ease,background .15s ease}
.toggle input:checked{background:var(--vscode-button-background);border-color:var(--vscode-button-background)}
.toggle input:checked::after{transform:translateX(16px);background:var(--vscode-button-foreground)}
.toggle input:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0 8px}
.list{display:flex;flex-direction:column;gap:2px}
.item{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid transparent;border-radius:7px}
.item:hover{background:var(--vscode-list-hoverBackground);border-color:var(--line)}
.info{flex:1;min-width:0}
.info .name{font-size:.92em;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.info .path{font-family:var(--mono);font-size:.79em;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
select.role{width:200px;min-width:200px;flex:0 0 200px;font-size:.85em;padding:5px 8px;box-shadow:inset 3px 0 0 0 var(--vscode-descriptionForeground)}
.role-client{box-shadow:inset 3px 0 0 0 var(--vscode-charts-blue,var(--vscode-focusBorder))}
.role-server{box-shadow:inset 3px 0 0 0 var(--vscode-charts-orange,var(--vscode-focusBorder))}
.role-off{box-shadow:inset 3px 0 0 0 var(--vscode-descriptionForeground)}
.empty{padding:14px;border:1px dashed var(--line);border-radius:7px;font-size:.85em;text-align:center;color:var(--muted)}
.foot{margin-top:24px;font-size:.79em;text-align:center;color:var(--muted)}
@media (max-width:720px){.wrap{padding:0 14px 32px}#project{max-width:60vw}select.role{width:170px;min-width:170px;flex-basis:170px}}
</style></head><body>
<div class="wrap">
<header class="top">
<div class="brand">
<span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 4v10l-7 4-7-4V7z"/><path d="M5 7l7 4 7-4"/><path d="M12 11v10"/></svg></span>
<div class="titles"><h1 id="title">Arma Project Settings</h1><div class="subline"><span class="dot" aria-hidden="true"></span><span id="project"></span></div></div>
</div>
<div class="toolbar"><span id="saved" class="saved" role="status" aria-live="polite"></span><button id="editManually" class="btn ghost">Edit JSON</button><button id="refresh" class="btn ghost">Refresh</button></div>
</header>

<main class="cards">
<section class="card">
<h2>Launch and API</h2>
<p class="hint">How Arma is started and where the SqfReloader API listens.</p>
<div class="fields">
<label class="field wide"><span class="label">Arma installation folder</span><div class="path-picker"><input type="text" data-setting="armaDirectory" placeholder="Path containing arma3_x64.exe"><button id="browseArmaDirectory" class="btn ghost">Browse</button></div><span class="hint field-hint">Leave this empty to look for <code>arma3_x64.exe</code> automatically from the registry and Steam libraries.</span></label>
<label class="field"><span class="label">Profile name</span><input type="text" data-setting="armaProfile" placeholder="Most recently used profile"></label>
<label class="field"><span class="label">API URL</span><input type="text" data-setting="apiUrl" placeholder="http://127.0.0.1"></label>
<label class="field wide"><span class="label">Extra launch arguments</span><input type="text" data-setting="extraLaunchArguments" placeholder="-noSplash -skipIntro -noPause"></label>
<label class="field wide"><span class="label">Dedicated-server extra arguments</span><input type="text" data-setting="serverLaunchArguments" placeholder="-port 2302 -profiles=profiles"></label>
<label class="field"><span class="label">API port</span><input type="number" min="1" max="65535" data-setting="apiPort"></label>
<label class="field"><span class="label">Request timeout (milliseconds)</span><input type="number" min="500" max="60000" data-setting="requestTimeout"></label>
<label class="field"><span class="label">SQF timeout (seconds)</span><input type="number" min="1" max="300" data-setting="runTimeout"></label>
</div>
</section>

<section class="card">
<h2>Reload and project behavior</h2>
<p class="hint">What happens on save and how the mod links are created.</p>
<div class="fields">
<label class="field"><span class="label">Junction mode</span><select data-setting="junctionMode"><option value="addon">Addon</option><option value="module">Mod folder</option></select></label>
<label class="field"><span class="label">Reload on save</span><select data-setting="reloadOnSave"><option value="reload">Reload</option><option value="recompile">Recompile</option><option value="off">Off</option></select></label>
<label class="field"><span class="label">Deleted function behavior</span><select data-setting="deletedFunctionBehavior"><option value="clear">Clear variable from Arma</option><option value="ask">Ask before clearing</option><option value="keep">Keep variable in Arma</option></select></label>
<label class="field"><span class="label">Log level</span><select data-setting="logLevel"><option value="error">Error</option><option value="warning">Warning</option><option value="info">Info</option><option value="verbose">Verbose</option></select></label>
</div>
<div class="toggles">
<label class="toggle"><input type="checkbox" data-setting="enabled"><span>Reload SQF on save</span></label>
<label class="toggle"><input type="checkbox" data-setting="autoJunction"><span>Create mod junctions automatically</span></label>
<label class="toggle"><input type="checkbox" data-setting="clearArmaMissionArtifacts"><span>Clean generated mission artifacts</span></label>
<label class="toggle"><input type="checkbox" data-setting="notifyOnError"><span>Notify on errors</span></label>
<label class="toggle"><input type="checkbox" data-setting="createExampleWithMission"><span>Include test mission when scaffolding</span></label>
</div>
</section>

<section class="card wide">
<h2>Mod management</h2>
<p class="hint">Choose how each workspace mod is loaded. Server-only mods use <code>-serverMod</code> for dedicated server launches. Mods discovered in the workspace start as <strong>Not Used</strong>; <strong>Remove</strong> stops launching a mod by setting it back to Not Used.</p>
<div class="actions"><button id="addWorkspaceMod" class="btn">Add workspace mod role</button></div>
<div class="list" id="workspaceMods"></div>
<h3>Additional local / Steam Workshop mods</h3>
<p class="hint">These directories are passed to Arma without modifying their contents.</p>
<div class="actions"><button id="addExternalMod" class="btn">Add external mod folder</button></div>
<div class="list" id="externalMods"></div>
</section>

<section class="card wide">
<h2>Hooks</h2>
<p class="hint">Run commands at lifecycle events, one command per line. Variables: <code>\${workspaceFolder}</code>, <code>\${armaDirectory}</code>, <code>\${missionFolder}</code>, <code>\${file}</code>, <code>\${apiUrl}</code>, <code>\${exitCode}</code>; the same values are exposed as <code>SQFRELOADER_*</code> environment variables.</p>
<div class="fields">
<label class="field"><span class="label">Event</span><select id="hookEvent"></select></label>
<label class="field"><span class="label">Blocking</span><select id="hookBlocking"><option value="true">true</option><option value="false">false</option></select></label>
<label class="field"><span class="label">Continue on error</span><select id="hookContinueOnError"><option value="false">false</option><option value="true">true</option></select></label>
</div>
<label class="field wide"><span class="label">Commands</span><textarea id="hookCommands" rows="4" spellcheck="false" placeholder="\${workspaceFolder}\\Tools\\BuildExtension.ps1"></textarea></label>
<div class="actions"><button id="saveHook" class="btn">Save hook</button><button id="clearHook" class="btn ghost">Clear hook</button></div>
<div class="fields">
<label class="field"><span class="label">Echo command</span><select data-hookpresentation="echo"><option value="true">true</option><option value="false">false</option></select></label>
<label class="field"><span class="label">Reveal terminal</span><select data-hookpresentation="reveal"><option value="always">always</option><option value="silent">silent</option><option value="never">never</option></select></label>
<label class="field"><span class="label">Focus terminal</span><select data-hookpresentation="focus"><option value="true">true</option><option value="false">false</option></select></label>
<label class="field"><span class="label">Terminal panel</span><select data-hookpresentation="panel"><option value="shared">shared</option><option value="dedicated">dedicated</option><option value="new">new</option></select></label>
</div>
</section>
</main>

<footer class="foot">Changes are written to <code>.vscode/sqfReloader-settings.json</code> as soon as a field changes.</footer>
</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let latestState;
function send(command,extra={}){vscode.postMessage({command,...extra})}
function setSaved(text,state){const saved=document.getElementById('saved');saved.textContent=text;saved.dataset.state=state||''}
document.getElementById('refresh').addEventListener('click',()=>send('refresh'));
document.getElementById('editManually').addEventListener('click',()=>send('editManually'));
document.getElementById('browseArmaDirectory').addEventListener('click',()=>send('browseArmaDirectory'));
document.getElementById('addWorkspaceMod').addEventListener('click',()=>send('addWorkspaceMod'));
document.getElementById('addExternalMod').addEventListener('click',()=>send('addMod'));
let hookDirty=false;
function hookEventSelect(){return document.getElementById('hookEvent')}
function hookValueFromEditor(){return{event:hookEventSelect().value,commands:document.getElementById('hookCommands').value.split(/\\r?\\n/).map(line=>line.trim()).filter(Boolean),blocking:document.getElementById('hookBlocking').value==='true',continueOnError:document.getElementById('hookContinueOnError').value==='true'}}
function loadHook(){const state=latestState;const select=hookEventSelect();if(!state||!select)return;const hook=(state.hooks||{})[select.value]||{};document.getElementById('hookCommands').value=Array.isArray(hook.commands)?hook.commands.join('\\n'):'';document.getElementById('hookBlocking').value=hook.blocking===false?'false':'true';document.getElementById('hookContinueOnError').value=hook.continueOnError?'true':'false'}
function populateHookEvents(events){const select=hookEventSelect();if(!select||!Array.isArray(events)||select.options.length)return;events.forEach(definition=>{const option=document.createElement('option');option.value=definition.event;option.textContent=definition.event+' - '+definition.label;select.append(option)});select.value=events[0].event;loadHook()}
['hookCommands','hookBlocking','hookContinueOnError'].forEach(id=>{const element=document.getElementById(id);['input','change'].forEach(type=>element.addEventListener(type,()=>{hookDirty=true}))});
hookEventSelect().addEventListener('change',()=>{hookDirty=false;loadHook()});
document.getElementById('saveHook').addEventListener('click',()=>{send('setting',{key:'hook',value:hookValueFromEditor()});hookDirty=false});
document.getElementById('clearHook').addEventListener('click',()=>{const value=hookValueFromEditor();value.commands=[];document.getElementById('hookCommands').value='';send('setting',{key:'hook',value});hookDirty=false});
document.querySelectorAll('[data-hookpresentation]').forEach(select=>select.addEventListener('change',()=>{const value={};document.querySelectorAll('[data-hookpresentation]').forEach(item=>{value[item.dataset.hookpresentation]=item.value==='true'?true:item.value==='false'?false:item.value});send('setting',{key:'hookPresentation',value})}));
document.querySelectorAll('[data-setting]').forEach(input=>input.addEventListener('change',()=>{let value=input.type==='checkbox'?input.checked:input.value;if(input.type==='number')value=Number(value);send('setting',{key:input.dataset.setting,value})}));
function addRoleSelect(parent,path,type,command,values){const select=document.createElement('select');const current=roleValue(type,values);select.className='role role-'+current;values.forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=value==='off'?'Not Used':value==='client'?'Client Mod':value==='server'?'Server Mod':value;select.append(option)});select.value=current;select.addEventListener('change',()=>{select.className='role role-'+select.value;send(command,{path,value:select.value})});parent.append(select)}
// The panel offers Client / Server / Not Used only. A stored "both" or "unclassified" role is a
// -mod mod like Client, so it is shown and kept as Client instead of disappearing from the list.
function roleValue(type,values){const current=type==='server'||type==='off'?type:'client';return values.includes(current)?current:values[0]}
function modInfo(text){const info=document.createElement('div');info.className='info';const leaf=text.split('/').pop()||text;const name=document.createElement('div');name.className='name';name.textContent=leaf;info.append(name);if(leaf!==text){const file=document.createElement('div');file.className='path';file.textContent=text;info.append(file)}return info}
function emptyNote(container,text){container.className='empty';container.textContent=text}
function renderMods(state){const workspace=document.getElementById('workspaceMods');workspace.replaceChildren();const roles=Array.isArray(state.workspaceMods)?state.workspaceMods:(state.modTypes&&typeof state.modTypes==='object'?Object.keys(state.modTypes).sort().map(key=>({path:key,type:state.modTypes[key]})):[]);if(!roles.length){emptyNote(workspace,'No workspace mod found.')}else{workspace.className='';roles.forEach(entry=>{const row=document.createElement('div');row.className='item';row.append(modInfo(entry.path));addRoleSelect(row,entry.path,entry.type,'modType',['client','server','off']);const remove=document.createElement('button');remove.className='btn ghost small';remove.textContent='Remove';remove.title='Stop launching this mod (sets it to Not Used)';remove.disabled=entry.type==='off';remove.addEventListener('click',()=>send('removeWorkspaceMod',{path:entry.path}));row.append(remove);workspace.append(row)})}
 const external=document.getElementById('externalMods');external.replaceChildren();const entries=Array.isArray(state.externalMods)?state.externalMods:[];if(!entries.length){emptyNote(external,'No external mods configured.')}else{external.className='';entries.forEach(mod=>{const row=document.createElement('div');row.className='item';row.append(modInfo(mod.path)); addRoleSelect(row,mod.path,mod.type,'externalModType',['client','server','off']);const remove=document.createElement('button');remove.className='btn ghost small';remove.textContent='Remove';remove.addEventListener('click',()=>send('removeExternalMod',{path:mod.path}));row.append(remove);external.append(row)})}}
function update(state){latestState=state;document.getElementById('project').textContent=state.projectRoot||'No project folder open';document.querySelectorAll('[data-setting]').forEach(input=>{if(document.activeElement!==input){const value=state.settings[input.dataset.setting];if(value!==undefined){if(input.type==='checkbox')input.checked=value;else input.value=value}}});populateHookEvents(state.hookEvents);if(!hookDirty)loadHook();const presentation=state.settings.hookPresentation||{};document.querySelectorAll('[data-hookpresentation]').forEach(select=>{const value=presentation[select.dataset.hookpresentation];if(value!==undefined&&document.activeElement!==select)select.value=String(value)});renderMods(state)}
window.addEventListener('message',event=>{const message=event.data;if(message.type==='state')update(message);else if(message.type==='error')setSaved('Error: '+message.message,'error');else if(message.type==='settingSaved')setSaved('Saved','ok');else if(message.type==='armaDirectoryBrowsed'){const input=document.querySelector('[data-setting="armaDirectory"]');if(input)input.value=message.value;setSaved('Arma folder used for this session','ok')}});
send('refresh');
</script></body></html>`;
    }

    private debugConsoleHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Arma Debug Console</title>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--radius:9px;--line:var(--vscode-widget-border,var(--vscode-panel-border));--card:var(--vscode-editorWidget-background,var(--vscode-editor-background));--muted:var(--vscode-descriptionForeground);--mono:var(--vscode-editor-font-family,monospace)}
html,body{margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.45;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
code{font-family:var(--mono);font-size:.95em;background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:4px}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px 36px}
.top{position:sticky;top:0;z-index:9;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;padding:16px 0 13px;background:var(--vscode-editor-background);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.logo{display:grid;place-items:center;width:40px;height:40px;flex:0 0 auto;border-radius:11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.logo svg{width:21px;height:21px}
.titles{min-width:0}
h1{margin:0;font-size:1.22em;font-weight:600;letter-spacing:.01em}
.subline{display:flex;align-items:center;gap:7px;margin-top:3px;min-width:0}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.pill{display:inline-flex;align-items:center;gap:7px;max-width:100%;font-size:.84em;color:var(--muted)}
.pill::before{content:'';width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:var(--muted);transition:background .15s ease}
.pill[data-state=ready]{color:var(--vscode-testing-iconPassed)}
.pill[data-state=ready]::before{background:var(--vscode-testing-iconPassed);box-shadow:0 0 0 3px var(--vscode-button-secondaryBackground)}
.pill[data-state=offline]::before{background:var(--vscode-testing-iconFailed)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:.92em;padding:6px 13px;border:1px solid transparent;border-radius:6px;cursor:pointer;white-space:nowrap;background:var(--vscode-button-background);color:var(--vscode-button-foreground);transition:background .12s ease,border-color .12s ease}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn.ghost{background:transparent;color:var(--vscode-foreground);border-color:var(--line)}
.btn.ghost:hover{background:var(--vscode-button-secondaryBackground);border-color:var(--vscode-focusBorder)}
.btn.small{padding:4px 10px;font-size:.84em}
.btn:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:18px}
.card{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px 18px;min-width:0}
.card.wide{grid-column:1/-1}
.card.watch{grid-column:span 2}
.card h2{margin:0;font-size:1em;font-weight:600}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px}
.hint{margin:0 0 12px;font-size:.85em;color:var(--muted)}
.hint.small{font-size:.8em}
.hint code{font-size:.95em}
.label{display:block;margin:12px 0 5px;font-size:.83em;letter-spacing:.02em;color:var(--muted)}
textarea{width:100%;min-height:130px;flex:1 1 auto;resize:vertical;font-family:var(--mono);font-size:.9em;line-height:1.55;tab-size:4;padding:10px 11px;border:1px solid var(--vscode-input-border,var(--line));border-radius:7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background)}
textarea:focus{outline:none;border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder)}
textarea::placeholder{color:var(--muted)}
input[type=text],input[type=number]{width:100%;font:inherit;padding:7px 9px;border:1px solid var(--vscode-input-border,var(--line));border-radius:6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background)}
input[type=text]:focus,input[type=number]:focus{outline:none;border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder)}
input::placeholder{color:var(--muted)}
.field{display:flex;flex-direction:column;gap:5px;margin:12px 0 0}
.inline{display:flex;gap:8px;margin-top:2px}
.inline input{flex:1;min-width:0}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 0}
.card-head .actions{margin:0}
pre{margin:8px 0 0;padding:10px 11px;border:1px solid var(--line);border-radius:7px;font-family:var(--mono);font-size:.87em;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;background:var(--vscode-textCodeBlock-background);color:var(--vscode-foreground)}
#result{max-height:260px;min-height:40px}
#result:empty{display:none}
#result.error,.watch-value.error{color:var(--vscode-errorForeground,var(--vscode-testing-iconFailed))}
.result-wrap:has(#result:empty){display:none}
#rpt{max-height:360px;min-height:140px;margin-top:6px;white-space:pre;overflow-wrap:normal;overflow-x:auto}
.pathline{font-family:var(--mono);font-size:.79em;color:var(--muted);overflow-wrap:anywhere}
.list{display:flex;flex-direction:column;gap:2px;margin-top:10px}
.item{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid transparent;border-radius:7px}
.item:hover{background:var(--vscode-list-hoverBackground);border-color:var(--line)}
.item.watch{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr) auto}
.watch-expr{font-size:.85em;overflow-wrap:anywhere}
.watch-value{font-size:.8em;font-family:var(--mono);color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;padding:2px 6px;border-radius:4px;background:var(--vscode-textCodeBlock-background)}
.empty{padding:14px;border:1px dashed var(--line);border-radius:7px;font-size:.85em;text-align:center;color:var(--muted)}
.toggle{display:inline-flex;align-items:center;gap:9px;padding:4px 8px;border-radius:6px;font-size:.88em;cursor:pointer}
.toggle:hover{background:var(--vscode-list-hoverBackground)}
.toggle input{appearance:none;-webkit-appearance:none;position:relative;flex:0 0 auto;width:30px;height:16px;margin:0;border:1px solid var(--vscode-input-border,var(--line));border-radius:999px;background:var(--vscode-input-background);cursor:pointer;transition:background .15s ease,border-color .15s ease}
.toggle input::after{content:'';position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--muted);transition:transform .15s ease,background .15s ease}
.toggle input:checked{background:var(--vscode-button-background);border-color:var(--vscode-button-background)}
.toggle input:checked::after{transform:translateX(14px);background:var(--vscode-button-foreground)}
.toggle input:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
@media (max-width:900px){.cards{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.card.watch{grid-column:1/-1}}
@media (max-width:720px){.wrap{padding:0 14px 30px}.item.watch{grid-template-columns:minmax(0,1fr) auto}.watch-value{grid-column:1/-1}}
</style></head><body>
<div class="wrap">
<header class="top">
<div class="brand">
<span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg></span>
<div class="titles"><h1>Arma Debug Console</h1><div class="subline"><span id="targets" class="pill" data-state="unknown">SqfReloader API status</span></div></div>
</div>
<div class="toolbar"><button id="refresh" class="btn ghost">Refresh</button><button id="newWindow" class="btn ghost">Popup in New Window</button></div>
</header>

<main class="cards">
<section class="card">
<h2>Execute SQF</h2>
<p class="hint">Runs in the Arma instance that owns the SqfReloader API and prints the returned value.</p>
<textarea id="code" spellcheck="false" placeholder='SQF code, e.g. player sideChat "Hello";'></textarea>
<div class="actions"><button id="execute" class="btn">Execute SQF</button></div>
<div class="result-wrap"><span class="label">Result</span>
<pre id="result"></pre>
</div>
</section>

<section class="card watch">
<h2>Watch expressions</h2>
<p class="hint">Reevaluated at the interval below while Arma is connected; values are Arma formatted text. Up to 10 expressions.</p>
<div class="inline"><input id="watchInput" placeholder="SQF expression, e.g. count allPlayers"><button id="addWatch" class="btn">Add</button></div>
<label class="field"><span class="label">Update interval (milliseconds, minimum 100)</span><input data-setting="watchInterval" type="number" min="100" max="60000" step="100"></label>
<div class="list" id="watches"></div>
<p class="hint small">The SqfReloader DLL must be loaded and its API reachable.</p>
</section>

<section class="card wide">
<div class="card-head">
<h2>RPT logs</h2>
<div class="actions"><label class="toggle"><input id="rptMonitoring" type="checkbox" checked><span>Live monitoring</span></label><button class="btn ghost small" data-command="openRptFile">Open latest RPT</button><button class="btn ghost small" data-command="openRpt">Open RPT folder</button></div>
</div>
<div id="rptFile" class="pathline"></div>
<pre id="rpt"></pre>
</section>
</main>
</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
function send(command,extra={}){vscode.postMessage({command,...extra})}
document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>send(button.dataset.command)));
document.getElementById('refresh').addEventListener('click',()=>send('refresh'));
document.getElementById('newWindow').addEventListener('click',()=>send('moveDebugConsoleToNewWindow'));
document.getElementById('rptMonitoring').addEventListener('change',event=>send('rptMonitoring',{enabled:event.target.checked}));
document.querySelectorAll('[data-setting]').forEach(input=>input.addEventListener('change',()=>{let value=input.value;if(input.type==='number')value=Number(value);send('setting',{key:input.dataset.setting,value})}));
document.getElementById('execute').addEventListener('click',()=>send('execute',{code:document.getElementById('code').value}));
document.getElementById('addWatch').addEventListener('click',()=>{const input=document.getElementById('watchInput');send('addWatch',{expression:input.value});input.value=''});
document.getElementById('watchInput').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();document.getElementById('addWatch').click()}});
function renderWatches(items){const container=document.getElementById('watches');const existing=[...container.querySelectorAll('[data-watch]')];if(items.length>0&&existing.length===items.length&&items.every((expression,index)=>existing[index].dataset.watch===expression))return;const previous=new Map(existing.map(item=>[item.dataset.watch,{text:item.textContent,isError:item.classList.contains('error')} ]));container.replaceChildren();if(!items.length){container.textContent='No watch expressions.';container.className='empty';return}container.className='';items.forEach(expression=>{const row=document.createElement('div');row.className='item watch';const label=document.createElement('div');label.className='watch-expr';label.textContent=expression;row.append(label);const value=document.createElement('div');value.className='watch-value';value.dataset.watch=expression;const prior=previous.get(expression);value.textContent=prior?.text||'Waiting for first update...';value.classList.toggle('error',prior?.isError===true);row.append(value);const remove=document.createElement('button');remove.className='btn ghost small';remove.textContent='Remove';remove.addEventListener('click',()=>send('removeWatch',{expression}));row.append(remove);container.append(row)})}
function update(state){if(!state)return;const targets=document.getElementById('targets');targets.textContent='SqfReloader API: '+(state.clientConnected?'ready':'offline');targets.dataset.state=state.clientConnected?'ready':'offline';document.getElementById('rptMonitoring').checked=state.rptMonitoring;document.querySelectorAll('[data-setting]').forEach(input=>{if(document.activeElement!==input){const value=state.settings[input.dataset.setting];if(value!==undefined)input.value=value}});renderWatches(state.watches);
 document.getElementById('rptFile').textContent=state.rptPath||'No RPT file found';document.getElementById('rpt').textContent=state.rptTail||'No RPT output yet';
}
window.addEventListener('message',event=>{const message=event.data;if(message.type==='state')update(message);else if(message.type==='watchValues'){message.values.forEach(item=>{const value=[...document.querySelectorAll('[data-watch]')].find(element=>element.dataset.watch===item.expression);if(value){if(value.textContent!==item.value)value.textContent=item.value;value.classList.toggle('error',item.isError===true)}})}else if(message.type==='execution'){const result=document.getElementById('result');result.textContent=message.result;result.classList.toggle('error',message.isError===true)}else if(message.type==='error'){const result=document.getElementById('result');result.textContent='Error: '+message.message;result.classList.add('error')}});
send('refresh');
</script></body></html>`;
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
    return value === "client" || value === "server" || value === "both" || value === "off";
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

function getNonce(): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
