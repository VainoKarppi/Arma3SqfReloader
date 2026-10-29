import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { evalCode, getStatus, sqfString } from "./api";
import { findMissions } from "./arma";
import { ModType, setModTypeForDirectory } from "./modTypes";
import { logError, readApiPort, readSettings } from "./settings";
import { refreshDedicatedServerStatus, refreshRunningStatus } from "./launcher";
import { workspaceMods } from "./runtime";
import { DEFAULT_PORT, normalizeApiHost } from "./ports";

/** External mods are never "off": removing the entry is how you stop loading them. */
type ExternalModType = "client" | "server" | "both";

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
    runTimeout: number;
    apiPort: number;
    requestTimeout: number;
    enabled: boolean;
    autoJunction: boolean;
    clearArmaMissionArtifacts: boolean;
    notifyOnError: boolean;
    createExampleWithMission: boolean;
    logLevel: string;
}

const MOD_TYPES: ModType[] = ["client", "server", "both", "off"];
const SETTING_KEYS = new Set<keyof ViewSettings>([
    "armaDirectory", "armaProfile", "extraLaunchArguments", "serverLaunchArguments", "apiUrl",
    "watchInterval", "junctionMode", "reloadOnSave", "runTimeout",
    "apiPort", "requestTimeout", "enabled", "autoJunction", "clearArmaMissionArtifacts",
    "notifyOnError", "createExampleWithMission", "logLevel"
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
        const settingsFile = path.join(rootPath, ".vscode", "settings.json");
        if (this.promptedSettingsFor !== rootPath) {
            this.projectSettingsReady = fs.existsSync(settingsFile);
        }
        if (!forcePrompt && this.promptedSettingsFor === rootPath) return;
        this.promptedSettingsFor = rootPath;
        if (fs.existsSync(settingsFile)) {
            this.projectSettingsReady = true;
            return;
        }

        const create = await vscode.window.showInformationMessage(
            `This Arma project has no .vscode/settings.json. Create project settings for launch options, mod roles, and debug watches?`,
            "Create Settings",
            "Not Now"
        );
        if (create !== "Create Settings") {
            void this.refresh();
            return;
        }

        try {
            await fs.promises.mkdir(path.dirname(settingsFile), { recursive: true });
            if (!fs.existsSync(settingsFile)) {
                try {
                    await fs.promises.writeFile(settingsFile, "{}\n", { encoding: "utf8", flag: "wx" });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                }
            }
            this.projectSettingsReady = true;
            await this.initializeProjectSettings();
            void this.refresh();
            void vscode.window.showInformationMessage("Created .vscode/settings.json for this Arma project.");
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
                case "debugConsole":
                    this.openDebugConsole();
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
            void vscode.window.showErrorMessage(`Arma project: ${error instanceof Error ? error.message : String(error)}`);
            this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
    }

    private async openProjectSettings(): Promise<void> {
        if (this.settingsPanel) {
            this.settingsPanel.reveal(vscode.ViewColumn.One);
            return;
        }
        if (!this.root) throw new Error("Open an Arma project folder first.");
        const settingsFile = path.join(this.root.uri.fsPath, ".vscode", "settings.json");
        if (!fs.existsSync(settingsFile)) await this.ensureProjectSettings(true);
        if (!fs.existsSync(settingsFile)) return;

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
        const settingsFile = path.join(this.root.uri.fsPath, ".vscode", "settings.json");
        if (!fs.existsSync(settingsFile)) await this.ensureProjectSettings(true);
        if (!fs.existsSync(settingsFile)) return;
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
        const config = vscode.workspace.getConfiguration("sqfReloader", this.root.uri);
        // armaDirectory is deliberately not written: the folder is detected once from the
        // registry / Steam libraries and kept in memory for the session.
        const values: Record<string, unknown> = {
            armaProfile: config.get("armaProfile", ""),
            extraLaunchArguments: config.get("extraLaunchArguments", "-noSplash -skipIntro -noPause"),
            serverLaunchArguments: config.get("serverLaunchArguments", ""),
            apiUrl: normalizeApiHost(config.get("apiUrl", "http://127.0.0.1")),
            apiPort: readApiPort(config),
            requestTimeout: config.get("requestTimeout", 3000),
            runTimeout: config.get("runTimeout", 30),
            autoJunction: config.get("autoJunction", true),
            junctionMode: config.get("junctionMode", "addon"),
            reloadOnSave: config.get("reloadOnSave", "reload"),
            notifyOnError: config.get("notifyOnError", true),
            enabled: config.get("enabled", true),
            createExampleWithMission: config.get("createExampleWithMission", true),
            clearArmaMissionArtifacts: config.get("clearArmaMissionArtifacts", true),
            logLevel: config.get("logLevel", "info"),
            modTypes: config.get("modTypes", {}),
            watchInterval: config.get("watchInterval", 1000),
            watchExpressions: config.get("watchExpressions", []),
            externalMods: config.get("externalMods", [])
        };
        const settingsFile = path.join(this.root.uri.fsPath, ".vscode", "settings.json");
        const projectSettings = Object.fromEntries(
            Object.entries(values).map(([key, value]) => [`sqfReloader.${key}`, value])
        );
        await fs.promises.writeFile(settingsFile, `${JSON.stringify(projectSettings, null, 4)}\n`, "utf8");
    }

    private async updateSetting(key: unknown, value: unknown): Promise<void> {
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

    private async saveSetting(key: string, value: unknown): Promise<void> {
        if (!this.root) throw new Error("Open an Arma project folder first.");
        const settingsFile = path.join(this.root.uri.fsPath, ".vscode", "settings.json");
        if (!this.projectSettingsReady && !fs.existsSync(settingsFile)) {
            throw new Error("Create the project .vscode/settings.json before changing project settings.");
        }
        await vscode.workspace.getConfiguration("sqfReloader", this.root.uri)
            .update(key, value, vscode.ConfigurationTarget.Workspace);
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

    private async updateExternalModType(directory: unknown, type: unknown): Promise<void> {
        if (typeof directory !== "string" || !isExternalModType(type)) throw new Error("Invalid external mod selection.");
        const mods = this.externalMods();
        const mod = mods.find(item => samePath(item.path, directory));
        if (!mod) throw new Error("External mod was not found in project settings.");
        mod.type = type;
        await this.saveSetting("externalMods", mods);
        await this.refresh();
    }

    private async removeExternalMod(directory: unknown): Promise<void> {
        if (typeof directory !== "string") throw new Error("Invalid external mod path.");
        await this.saveSetting("externalMods", this.externalMods().filter(mod => !samePath(mod.path, directory)));
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
        this.post({ type: "execution", result: result.success ? output : result.error ?? "Execution failed." });
    }

    private async addWatch(expression: unknown): Promise<void> {
        if (typeof expression !== "string" || !expression.trim()) throw new Error("Enter an SQF expression to watch.");
        const watches = this.watchExpressions();
        if (!watches.includes(expression.trim())) watches.push(expression.trim());
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
                this.post({ type: "watchValues", values: watches.map(expression => ({ expression, value: "Arma is not connected." })) });
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
                    return { expression, value: value ?? "No value returned." };
                })
                : watches.map(expression => ({ expression, value: result.error ?? "Watch evaluation failed." }));
            this.post({ type: "watchValues", values });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.post({ type: "watchValues", values: this.watchExpressions().map(expression => ({ expression, value: message })) });
        } finally {
            this.watchBusy = false;
        }
    }

    /**
     * Every workspace mod the extension would pass to Arma, with its launch role. Unclassified
     * mods are listed too (as "unclassified") so a discovered folder such as an unpacked server
     * source tree is visible and can be set to "off" instead of being launched invisibly.
     */
    private workspaceModRoles(): Array<{ path: string; type: string }> {
        if (!this.root) return [];
        const roles = this.setting<Record<string, unknown>>("modTypes", {});
        return workspaceMods()
            .map(mod => {
                const key = path.relative(this.root!.uri.fsPath, mod.directory).replace(/\\/g, "/") || ".";
                const type = roles[key];
                return { path: key, type: typeof type === "string" ? type : "unclassified" };
            })
            .sort((left, right) => left.path.localeCompare(right.path));
    }

    private setting<T>(key: string, fallback: T): T {
        if (!this.root) return fallback;
        return vscode.workspace.getConfiguration("sqfReloader", this.root.uri).get<T>(key, fallback);
    }

    /**
     * Reads a setting from the project scopes only. The settings panel edits
     * .vscode/settings.json, so an inherited user-level value must not look like a project
     * setting - sqfReloader.armaDirectory in particular is auto-detected and never written by
     * this extension, so a leftover global entry would otherwise prefill the field.
     */
    private projectSetting<T>(key: string, fallback: T): T {
        if (!this.root) return fallback;
        const config = vscode.workspace.getConfiguration("sqfReloader", this.root.uri);
        const inspected = typeof config.inspect === "function" ? config.inspect<T>(key) : undefined;
        return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? fallback;
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
            projectSettingsReady: this.projectSettingsReady || !!(rootPath && fs.existsSync(path.join(rootPath, ".vscode", "settings.json"))),
            settings: this.viewSettings(),
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
            runTimeout: clampNumber(this.setting("runTimeout", 30), 1, 300),
            apiPort: readApiPort(vscode.workspace.getConfiguration("sqfReloader", this.root?.uri)),
            requestTimeout: clampNumber(this.setting("requestTimeout", 3000), 500, 60000),
            enabled: this.setting("enabled", true),
            autoJunction: this.setting("autoJunction", true),
            clearArmaMissionArtifacts: this.setting("clearArmaMissionArtifacts", true),
            notifyOnError: this.setting("notifyOnError", true),
            createExampleWithMission: this.setting("createExampleWithMission", true),
            logLevel: this.setting("logLevel", "info")
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
button{font:inherit;cursor:pointer;width:100%;text-align:left;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px;padding:8px;margin:3px 0}
.status{padding:8px;background:var(--vscode-editor-background);margin-top:12px;line-height:1.6}.muted{color:var(--vscode-descriptionForeground);font-size:.9em}
.status .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
.dot.ok{background:var(--vscode-testing-iconPassed,#3fb950)}.dot.bad{background:var(--vscode-testing-iconFailed,#f85149)}
.dot.starting{background:var(--vscode-charts-blue,#3794ff)}
.dot.idle{background:var(--vscode-descriptionForeground,#8b949e)}
</style></head><body>
<h2 id="project">Arma Project</h2>
<button data-command="openSettings">Create / Edit Project Settings</button>
<button id="dedicatedServer" data-command="launchServer">Start Dedicated Server</button>
<button data-command="launchHosted">Host Mission</button>
<button data-command="debugConsole">Debug Console</button>
<div class="status" id="status">Checking status...</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({command:button.dataset.command})));
function statusItem(label,tone,text){const dot=document.createElement('span');dot.className='dot '+tone;const value=document.createElement('span');value.textContent=label+': '+text;const line=document.createElement('div');line.append(dot,value);return line}
// The .exe exists (process running) but Arma has not reached the SqfReloader API yet: "Starting...".
function processStatus(running,connected){if(typeof running!=='boolean')return['idle','Unknown'];if(!running)return['bad','Stopped'];return connected?['ok','Running']:['starting','Starting...']}
function apiStatus(connected,running){if(connected)return['ok','Running'];if(running)return['starting','Starting...'];return['idle','Stopped']}
window.addEventListener('message',event=>{if(event.data.type==='state'){const state=event.data;document.getElementById('project').textContent=state.project;const status=document.getElementById('status');const anyProcessRunning=state.running===true||state.dedicatedServerRunning===true;const game=processStatus(state.running,state.clientConnected);const api=apiStatus(state.clientConnected,anyProcessRunning);const server=processStatus(state.dedicatedServerRunning,state.clientConnected);status.replaceChildren(statusItem('Game',game[0],game[1]),statusItem('Dedicated Server',server[0],server[1]),statusItem('API',api[0],api[1]));const serverButton=document.getElementById('dedicatedServer');serverButton.textContent=state.dedicatedServerRunning?'Stop Dedicated Server':'Start Dedicated Server';serverButton.dataset.command=state.dedicatedServerRunning?'stopServer':'launchServer'}});
</script></body></html>`;
    }

    private projectSettingsHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Arma Project Settings</title>
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0 18px 28px;max-width:1100px;margin:auto}
h1{font-size:1.4em;margin:20px 0 4px}h2{font-size:1.1em;margin:24px 0 8px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:5px}
button,select,input{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:2px;padding:6px}
button{cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;margin:3px}
input[type=text],input[type=number]{width:100%;box-sizing:border-box}
label{display:block;margin:10px 0}.field{max-width:720px}.hint,.muted{color:var(--vscode-descriptionForeground);font-size:.9em}
.item{border-top:1px solid var(--vscode-panel-border);padding:10px 0;overflow-wrap:anywhere}.row{display:flex;align-items:center;gap:8px}.row select{width:130px}.row button{white-space:nowrap}
.row .info{flex:1;min-width:0}.actions{margin:8px 0 16px}.saved{color:var(--vscode-testing-iconPassed);min-height:1.3em}
.path-picker{display:flex;gap:6px;max-width:720px}.path-picker input{flex:1;min-width:0}
</style></head><body>
<h1 id="title">Arma Project Settings</h1><div class="muted" id="project"></div>
<div class="actions"><button id="refresh">Refresh</button><button id="editManually">Edit Manually</button><span id="saved" class="saved"></span></div>
<h2>Launch and API</h2>
<label class="field">Arma installation folder<div class="path-picker"><input type="text" data-setting="armaDirectory" placeholder="Path containing arma3_x64.exe"><button id="browseArmaDirectory">Browse...</button></div></label>
<label class="field">Profile name<input type="text" data-setting="armaProfile"></label>
<label class="field">Extra launch arguments<input type="text" data-setting="extraLaunchArguments"></label>
<label class="field">Dedicated-server extra arguments<input type="text" data-setting="serverLaunchArguments" placeholder="-port 2302 -profiles=profiles"></label>
<label class="field">API URL<input type="text" data-setting="apiUrl" placeholder="http://127.0.0.1"></label>
<label class="field">API Port<input type="number" min="1" max="65535" data-setting="apiPort"></label>
<label class="field">Request timeout (milliseconds)<input type="number" min="500" max="60000" data-setting="requestTimeout"></label>
<label class="field">SQF timeout (seconds)<input type="number" min="1" max="300" data-setting="runTimeout"></label>
<h2>Mod Management</h2>
<p class="hint">Choose how each workspace mod is loaded. Server-only mods use <code>-serverMod</code> for dedicated server launches.</p>
<button id="addWorkspaceMod">Add Workspace Mod Role...</button><div id="workspaceMods"></div>
<h3>Additional local / Steam Workshop mods</h3>
<p class="hint">These directories are passed to Arma without modifying their contents.</p>
<button id="addExternalMod">Add External Mod Folder...</button><div id="externalMods"></div>
<h2>Reload and Project Behavior</h2>
<label class="field">Junction mode<select data-setting="junctionMode"><option value="addon">Addon</option><option value="module">Mod folder</option></select></label>
<label class="field">Reload on save<select data-setting="reloadOnSave"><option value="reload">Reload</option><option value="recompile">Recompile</option><option value="off">Off</option></select></label>
<label class="field">Log level<select data-setting="logLevel"><option value="error">Error</option><option value="warning">Warning</option><option value="info">Info</option><option value="verbose">Verbose</option></select></label>
<label><input type="checkbox" data-setting="enabled"> Reload SQF on save</label>
<label><input type="checkbox" data-setting="autoJunction"> Create mod junctions automatically</label>
<label><input type="checkbox" data-setting="clearArmaMissionArtifacts"> Clean generated mission artifacts</label>
<label><input type="checkbox" data-setting="notifyOnError"> Notify on errors</label>
<label><input type="checkbox" data-setting="createExampleWithMission"> Include test mission when scaffolding</label>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let latestState;
function send(command,extra={}){vscode.postMessage({command,...extra})}
document.getElementById('refresh').addEventListener('click',()=>send('refresh'));
document.getElementById('editManually').addEventListener('click',()=>send('editManually'));
document.getElementById('browseArmaDirectory').addEventListener('click',()=>send('browseArmaDirectory'));
document.getElementById('addWorkspaceMod').addEventListener('click',()=>send('addWorkspaceMod'));
document.getElementById('addExternalMod').addEventListener('click',()=>send('addMod'));
document.querySelectorAll('[data-setting]').forEach(input=>input.addEventListener('change',()=>{let value=input.type==='checkbox'?input.checked:input.value;if(input.type==='number')value=Number(value);send('setting',{key:input.dataset.setting,value})}));
function addRoleSelect(parent,path,type,command,includeUnclassified){const select=document.createElement('select');(includeUnclassified?['unclassified','client','server','both','off']:['client','server','both','off']).forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=value==='unclassified'?'Unclassified (launched as -mod)':value==='off'?'Not launched':value;select.append(option)});select.value=type;select.addEventListener('change',()=>send(command,{path,value:select.value}));parent.append(select)}
function renderMods(state){const workspace=document.getElementById('workspaceMods');workspace.replaceChildren();const roles=Array.isArray(state.workspaceMods)?state.workspaceMods:(state.modTypes&&typeof state.modTypes==='object'?Object.keys(state.modTypes).sort().map(key=>({path:key,type:state.modTypes[key]})):[]);if(!roles.length){workspace.className='muted';workspace.textContent='No workspace mod found.'}else{workspace.className='';roles.forEach(entry=>{const row=document.createElement('div');row.className='item row';const info=document.createElement('div');info.className='info';info.textContent=entry.path;row.append(info);addRoleSelect(row,entry.path,entry.type,'modType',true);workspace.append(row)})}
 const external=document.getElementById('externalMods');external.replaceChildren();const entries=Array.isArray(state.externalMods)?state.externalMods:[];if(!entries.length){external.className='muted';external.textContent='No external mods configured.'}else{external.className='';entries.forEach(mod=>{const row=document.createElement('div');row.className='item row';const info=document.createElement('div');info.className='info';info.textContent=mod.path;row.append(info);addRoleSelect(row,mod.path,mod.type,'externalModType',false);const remove=document.createElement('button');remove.textContent='Remove';remove.addEventListener('click',()=>send('removeExternalMod',{path:mod.path}));row.append(remove);external.append(row)})}}
function update(state){latestState=state;document.getElementById('project').textContent=state.projectRoot||'No project folder open';document.querySelectorAll('[data-setting]').forEach(input=>{if(document.activeElement!==input){const value=state.settings[input.dataset.setting];if(value!==undefined){if(input.type==='checkbox')input.checked=value;else input.value=value}}});renderMods(state)}
window.addEventListener('message',event=>{const message=event.data;if(message.type==='state')update(message);else if(message.type==='error')document.getElementById('saved').textContent='Error: '+message.message;else if(message.type==='settingSaved')document.getElementById('saved').textContent='Saved';else if(message.type==='armaDirectoryBrowsed'){const input=document.querySelector('[data-setting="armaDirectory"]');if(input)input.value=message.value;document.getElementById('saved').textContent='Arma folder used for this session'}});
send('refresh');
</script></body></html>`;
    }

    private debugConsoleHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const csp = webview.cspSource;
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Arma Debug Console</title>
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0 12px 18px}
h2{font-size:1.15em;margin:16px 0 8px}h3{font-size:1em;margin:14px 0 6px}
button,select,input,textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:2px;padding:5px}
button{cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;margin:2px}
button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
input,textarea{width:100%;box-sizing:border-box}textarea{min-height:70px;resize:vertical}
.row{display:flex;gap:5px;align-items:center;margin:5px 0}.row>*{min-width:0}.row select{width:105px}
.actions{display:flex;flex-wrap:wrap;margin:4px -2px}.muted{color:var(--vscode-descriptionForeground);font-size:.9em}
.item{border-top:1px solid var(--vscode-panel-border);padding:6px 0;overflow-wrap:anywhere}
.status{padding:6px;background:var(--vscode-editor-background);margin:6px 0}.ok{color:var(--vscode-testing-iconPassed)}.bad{color:var(--vscode-testing-iconFailed)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:6px}
details{border-top:1px solid var(--vscode-panel-border);margin-top:12px}summary{cursor:pointer;padding:8px 0;font-weight:bold}
label{display:block;margin:7px 0}.label{display:block;margin-bottom:3px}.small{font-size:.85em}
</style></head><body>
<h2>Arma Debug Console</h2>
<div id="targets" class="muted">SqfReloader API status</div>
<textarea id="code" spellcheck="false" placeholder='SQF code, e.g. player sideChat "Hello";'></textarea>
<div class="actions"><button id="execute">Execute SQF</button></div><pre id="result"></pre>
<h3>Watch Expressions</h3>
<div class="row"><input id="watchInput" placeholder="SQF expression, e.g. count allPlayers"><button id="addWatch">Add</button></div>
<label><span class="label">Update interval (milliseconds, minimum 100)</span><input data-setting="watchInterval" type="number" min="100" max="60000" step="100"></label>
<div id="watches"></div>
<p class="muted small">Expressions run in the Arma instance that owns the SqfReloader API at the configured interval. The SqfReloader DLL must be loaded and its API reachable.</p>
<h2>RPT Logs</h2>
<label><input id="rptMonitoring" type="checkbox" checked> Live monitoring</label>
<div class="actions"><button class="secondary" data-command="openRptFile">Open Latest RPT</button><button class="secondary" data-command="openRpt">Open RPT Folder</button><button class="secondary" id="refresh">Refresh</button></div>
<div id="rptFile" class="muted"></div><pre id="rpt"></pre>

<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
function send(command,extra={}){vscode.postMessage({command,...extra})}
document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>send(button.dataset.command)));
document.getElementById('refresh').addEventListener('click',()=>send('refresh'));
document.getElementById('rptMonitoring').addEventListener('change',event=>send('rptMonitoring',{enabled:event.target.checked}));
document.querySelectorAll('[data-setting]').forEach(input=>input.addEventListener('change',()=>{let value=input.value;if(input.type==='number')value=Number(value);send('setting',{key:input.dataset.setting,value})}));
document.getElementById('execute').addEventListener('click',()=>send('execute',{code:document.getElementById('code').value}));
document.getElementById('addWatch').addEventListener('click',()=>{const input=document.getElementById('watchInput');send('addWatch',{expression:input.value});input.value=''});
document.getElementById('watchInput').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();document.getElementById('addWatch').click()}});
function renderWatches(items){const container=document.getElementById('watches');const previous=new Map([...container.querySelectorAll('[data-watch]')].map(item=>[item.dataset.watch,item.textContent]));container.replaceChildren();if(!items.length){container.textContent='No watch expressions.';container.className='muted';return}container.className='';items.forEach(expression=>{const row=document.createElement('div');row.className='item';const label=document.createElement('div');label.textContent=expression;row.append(label);const value=document.createElement('div');value.className='muted';value.dataset.watch=expression;value.textContent=previous.get(expression)||'Waiting for first update...';row.append(value);const remove=document.createElement('button');remove.className='secondary';remove.textContent='Remove';remove.addEventListener('click',()=>send('removeWatch',{expression}));row.append(remove);container.append(row)})}
function update(state){if(!state)return;document.getElementById('targets').textContent='SqfReloader API: '+(state.clientConnected?'ready':'offline');document.getElementById('rptMonitoring').checked=state.rptMonitoring;document.querySelectorAll('[data-setting]').forEach(input=>{if(document.activeElement!==input){const value=state.settings[input.dataset.setting];if(value!==undefined)input.value=value}});renderWatches(state.watches);
 document.getElementById('rptFile').textContent=state.rptPath||'No RPT file found';document.getElementById('rpt').textContent=state.rptTail||'No RPT output yet';
}
window.addEventListener('message',event=>{const message=event.data;if(message.type==='state')update(message);else if(message.type==='watchValues'){message.values.forEach(item=>{const value=[...document.querySelectorAll('[data-watch]')].find(element=>element.dataset.watch===item.expression);if(value)value.textContent=item.value})}else if(message.type==='execution'){document.getElementById('result').textContent=message.result}else if(message.type==='error'){document.getElementById('result').textContent='Error: '+message.message}});
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
    return value === "client" || value === "server" || value === "both";
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

function armaLogDirectory(): string {
    return path.join(process.env.LOCALAPPDATA?.trim() || path.join(require("os").homedir(), "AppData", "Local"), "Arma 3");
}

async function findLatestRptPath(): Promise<string> {
    let names: string[];
    try {
        names = await fs.promises.readdir(armaLogDirectory());
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
    }
    const files = await Promise.all(names
        .filter(name => /^arma3(?:server)?_x64_.*\.rpt$/i.test(name))
        .map(async name => {
            const file = path.join(armaLogDirectory(), name);
            try {
                const stats = await fs.promises.stat(file);
                return stats.isFile() ? { file, modified: stats.mtimeMs } : undefined;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                throw error;
            }
        }));
    return files
        .filter((entry): entry is { file: string; modified: number } => !!entry)
        .sort((left, right) => right.modified - left.modified)[0]?.file ?? "";
}

async function readRptTail(file: string): Promise<string> {
    try {
        const handle = await fs.promises.open(file, "r");
        try {
            const { size } = await handle.stat();
            const bytesToRead = Math.min(size, 64 * 1024);
            const buffer = Buffer.alloc(bytesToRead);
            await handle.read(buffer, 0, bytesToRead, size - bytesToRead);
            return buffer.toString("utf8").split(/\r?\n/).slice(-80).join("\n");
        } finally {
            await handle.close();
        }
    } catch (error) {
        return `Could not read RPT: ${error instanceof Error ? error.message : String(error)}`;
    }
}
