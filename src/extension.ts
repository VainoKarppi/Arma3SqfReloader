import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { evalCode, getStatus, request, sqfString } from "./api";
import { configuredLogLevel, disposeOutput, getOutput, log, logError, readSettings, Settings, updateSetting } from "./settings";
import { ensureJunctions, openArmaFolder, removeJunctions, setupFromContext, setupWorkspace } from "./setup";
import { findArmaDirectory, findMissions, findModForFile, isArmaDirectory, MissionFolder, readMissionMaxPlayers } from "./arma";
import { linkMissions, removeAllLinks, removeModInZLink } from "./junctions";
import { cleanupSnapshots, isReloadable, registerWorkspaceFunctions, reloadAll, reloadAndRestartMission, reloadDocument, reloadFileNow, runSqfFile } from "./reload";
import { isRunning, launchArma, setRptDiagnosticCollection, startRptMonitor, stopRptMonitor } from "./launcher";
import { loadRuntime, Runtime, workspaceMods, workspaceAddons, writeApiConfig } from "./runtime";
import { verifyWorkspaceAddons } from "./runtime";
import { scaffoldExample } from "./scaffold";
import { selectArmaProfile } from "./profile";
import { configureMissionArtifactCleanup, stopMissionArtifactCleanup } from "./missionArtifacts";

let statusBar: vscode.StatusBarItem | undefined;
let runtime: Runtime | undefined;
let workspaceInjectionLoop: Promise<void> | undefined;
let workspaceInjectionGeneration = 0;

export function activate(context: vscode.ExtensionContext): void {
    const version = context.extension.packageJSON.version;
    log(`Arma 3 SQF Reloader ${version} activated.`);

    runtime = loadRuntime(context);
    context.subscriptions.push({ dispose: stopMissionArtifactCleanup });
    const rptDiagnostics = vscode.languages.createDiagnosticCollection("sqfReloader");
    context.subscriptions.push(rptDiagnostics, { dispose: stopRptMonitor });
    setRptDiagnosticCollection(rptDiagnostics);
    startRptMonitor();

    if (!runtime) {
        log("Bundled runtime is missing: reinstall the extension (or run build-all.ps1 when developing it).");
    }

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    statusBar.command = "sqfReloader.play";
    refreshStatus();
    statusBar.show();
    let wasArmaRunning = isRunning();
    const statusTimer = setInterval(() => {
        const running = isRunning();
        if (wasArmaRunning && !running) {
            void findArmaDirectory(readSettings()).then(armaDirectory => {
                if (armaDirectory) cleanupSnapshots(armaDirectory);
            });
        }
        wasArmaRunning = running;
        void refreshStatus();
    }, 2000);
    context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });

    // --- Save -> reload ---------------------------------------------------
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async document => {
        const settings = readSettings();

        if (!settings.enabled || !isReloadable(document)) {
            return;
        }

        // Offline saves are normal while editing; avoid sending a request or showing an API
        // warning until an Arma process is actually running.
        if (!isRunning()) {
            return;
        }

        // A save supersedes the previous Arma compile diagnostic; a new RPT block will add it back.
        rptDiagnostics.delete(document.uri);

        try {
            const outcome = await reloadDocument(document, settings);

            if (outcome.ok) {
                if (/^(Reloaded|Reload queued|Recompile|Compiled)/.test(outcome.message)) {
                    setStatus(`$(check) ${shorten(outcome.message)}`, false);
                }
            } else {
                setStatus("$(warning) SqfReloader: reload failed", true);
                log(`Reload failed: ${outcome.message}${outcome.detail ? ` (${outcome.detail})` : ""}`);
            }
        } catch (error) {
            logError("save handler failed", error);
            setStatus("$(warning) SqfReloader: reload failed", true);
        }
    }));

    // --- Workspace / settings changes -------------------------------------
    const onWorkspaceChange = async () => {
        try {
            await configureMissionArtifactCleanup(readSettings());
            await ensureJunctions(readSettings());
            await refreshStatus();
            void promptForExampleIfNeeded(context, version);
        } catch (error) {
            logError("workspace change handling failed", error);
        }
    };

    void onWorkspaceChange();

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(onWorkspaceChange));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("sqfReloader")) {
            if (configuredLogLevel() === "verbose") log("Settings changed.");
            void onWorkspaceChange();
            if (event.affectsConfiguration("sqfReloader.logLevel")) {
                workspaceInjectionGeneration++;
                workspaceInjectionLoop = undefined;
            }
            if (event.affectsConfiguration("sqfReloader.logLevel") && isRunning()) {
                void applyRuntimeLogLevel(readSettings()).catch(error => {
                    logError("could not apply SqfReloader log level", error);
                });
            }
        }
    }));

    // --- Commands ---------------------------------------------------------
    const playCommand = async (): Promise<boolean> => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
            const action = await vscode.window.showInformationMessage(
                "No workspace found for Arma 3. Open a folder containing an Arma mod or mission first.",
                "Open Folder"
            );
            if (action === "Open Folder") await vscode.commands.executeCommand("workbench.action.files.openFolder");
            return false;
        }

        if (!hasArmaWorkspace()) {
            if (workspaceHasNoFiles()) {
                const action = await vscode.window.showWarningMessage(
                    "No workspace found for Arma 3. Create an example mod in this empty workspace?",
                    { modal: true },
                    "Setup Example",
                    "Cancel"
                );
                if (action === "Setup Example") {
                    await vscode.commands.executeCommand("sqfReloader.createExample");
                    await refreshStatus();
                }
            } else {
                const action = await vscode.window.showInformationMessage(
                    "No workspace found for Arma 3. Open a folder containing a server/client mod or a mission.",
                    "Open Folder"
                );
                if (action === "Open Folder") await vscode.commands.executeCommand("workbench.action.files.openFolder");
            }
            return false;
        }

        if (!runtime) {
            vscode.window.showErrorMessage("The SqfReloader files bundled with this extension are missing. Reinstall the extension.");
            return false;
        }

        const settings = readSettings();
        const armaDirectory = await findArmaDirectory(settings);
        if (!armaDirectory || (settings.armaDirectory.trim() && !isArmaDirectory(settings.armaDirectory))) {
            await vscode.commands.executeCommand("workbench.action.openSettings", "sqfReloader.armaDirectory");
            vscode.window.showInformationMessage("Choose the Arma 3 installation folder in sqfReloader.armaDirectory, then click Play Arma 3 again.");
            return false;
        }

        const mission = findMissionForCurrentEditor();
        if (mission && !(await confirmMissionFunctionRecompile(mission.directory))) {
            return false;
        }
        setStatus("$(sync~spin) Starting Arma 3...", false);

        const started = await launchArma(runtime, settings, mission ? { missionFolder: mission } : {});

        if (started) {
            // Arma may take longer to initialize the SqfReloader API on later launches.
            // Keep waiting for the game callback so functions are injected even when Eden
            // is opened well after the launcher timeout.
            void injectWorkspaceFunctionsWhenReady(settings);
            await refreshStatus();
        } else {
            await refreshStatus();
        }

        return started;
    };

    register(context, "sqfReloader.play", playCommand);

    register(context, "sqfReloader.stop", async () => {
        if (!isRunning()) {
            vscode.window.showInformationMessage("Arma 3 is not running.");
            return;
        }

        const choice = await vscode.window.showWarningMessage("Close the running Arma 3 instance?", { modal: true }, "Close Arma 3");

        if (choice !== "Close Arma 3") {
            return;
        }

        try {
            require("child_process").execSync('taskkill /IM arma3_x64.exe /F');
            const armaDirectory = await findArmaDirectory(readSettings());
            if (armaDirectory) {
                // Remove only this extension's registered mod/addon links and any old
                // z\@Mod alias it created. Empty z mount folders are pruned by cleanup.
                const removedLinks = removeAllLinks(armaDirectory);
                const removedLegacy = workspaceMods().filter(mod => removeModInZLink(armaDirectory, mod)).length;
                const failures = removedLinks.failed.length;
                log(`Removed ${removedLinks.removed.length + removedLegacy} Arma mod link(s) after Stop Arma 3${failures ? `; ${failures} could not be removed` : ""}.`);
                if (failures > 0) {
                    vscode.window.showWarningMessage(`Arma 3 stopped, but ${failures} mod link(s) could not be removed. See the SqfReloader output.`);
                }
            }
            setStatus("$(play) Play Arma 3", false);
            log("Arma 3 closed.");
        } catch (error) {
            logError("could not close Arma 3", error);
        }
    });

    register(context, "sqfReloader.setup", async () => {
        await setupFromContext(readSettings());
        await refreshStatus();
    });

    register(context, "sqfReloader.setupWorkspace", async () => {
        await setupWorkspace(readSettings());
        await refreshStatus();
    });

    register(context, "sqfReloader.createExample", async () => {
        const result = await scaffoldExample();

        if (result) {
            // Discover the new addon sources right away and create the runtime links eagerly.
            await ensureJunctions(readSettings());
            await refreshStatus();
            const action = await vscode.window.showInformationMessage(
                "Example mod, missions, and dedicated server files are ready.",
                "Play Arma 3",
                "Start dedicated server"
            );
            if (action === "Start dedicated server") {
                await vscode.commands.executeCommand("sqfReloader.startDedicatedServer");
            } else if (action === "Play Arma 3") {
                await vscode.commands.executeCommand("sqfReloader.play");
            }
        }
    });

    register(context, "sqfReloader.connect", async () => {
        const settings = readSettings();
        const level = settings.logLevel === "verbose" ? "verbose" : "info";

        try {
            const status = await getStatus(settings);
            const connected = status.gameConnected === true;
            const message = `SqfReloader ${status.version ?? "?"} on ${settings.apiUrl} - game callback ${connected ? "registered" : "NOT registered"}.`;

            if (connected && isRunning() && settings.logLevel === "verbose") {
                try {
                    await applyRuntimeLogLevel({ ...settings, logLevel: level });
                } catch (error) {
                    logError("could not apply SqfReloader log level", error);
                }
            }

            vscode.window.showInformationMessage(`Arma 3 SQF Reloader: ${message}`);
            log(message);

            if (status.logDirectory) {
                log(`Extension log: ${status.logDirectory}`);
            }

            await refreshStatus();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logError("connection check failed", error);
            vscode.window.showErrorMessage(`Arma 3 SQF Reloader: ${message}`);
            await refreshStatus();
        }
    });

    register(context, "sqfReloader.reloadAll", async () => {
        const settings = readSettings();
        const outcome = await reloadAll(settings);
        setStatus(outcome.ok ? `$(check) ${shorten(outcome.message)}` : "$(warning) SqfReloader: reload failed", !outcome.ok);

        if (outcome.ok) {
            vscode.window.showInformationMessage(`Arma 3 SQF Reloader: ${outcome.message}`);
        } else {
            vscode.window.showErrorMessage(`Arma 3 SQF Reloader: ${outcome.message}`);
        }
    });

    register(context, "sqfReloader.reloadRestartMission", async () => {
        const mission = findCurrentMission();
        if (!mission) {
            vscode.window.showWarningMessage("Open a mission folder containing mission.sqm before restarting mission functions.");
            return;
        }
        const settings = readSettings();
        const outcome = await reloadAndRestartMission(settings, mission);
        setStatus(outcome.ok ? `$(check) ${shorten(outcome.message)}` : "$(warning) SqfReloader: mission restart failed", !outcome.ok);
        if (outcome.ok) {
            vscode.window.showInformationMessage(`Arma 3 SQF Reloader: ${outcome.message}`);
        } else {
            vscode.window.showErrorMessage(`Arma 3 SQF Reloader: ${outcome.message}`);
        }
    });

    register(context, "sqfReloader.reloadFile", async () => {
        const document = vscode.window.activeTextEditor?.document;

        if (!document) {
            vscode.window.showWarningMessage("Open an SQF file first.");
            return;
        }

        try {
            const outcome = await reloadFileNow(document, readSettings());
            setStatus(outcome.ok ? `$(check) ${shorten(outcome.message)}` : "$(warning) SqfReloader: reload failed", !outcome.ok);

            if (!outcome.ok) {
                vscode.window.showErrorMessage(`Arma 3 SQF Reloader: ${outcome.message}`);
            }
        } catch (error) {
            logError("reload file failed", error);
            vscode.window.showErrorMessage(`Arma 3 SQF Reloader: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    const runFileCommand = async (resource: unknown, withParameters: boolean): Promise<void> => {
        let document: vscode.TextDocument | undefined;
        const uri = resource instanceof vscode.Uri ? resource : undefined;

        if (uri) {
            document = vscode.workspace.textDocuments.find(open => open.uri.toString() === uri.toString());
            document ??= await vscode.workspace.openTextDocument(uri);
        } else {
            document = vscode.window.activeTextEditor?.document;
        }

        if (!document || !/\.sqf$/i.test(document.fileName)) {
            vscode.window.showWarningMessage("Select or open an SQF file first.");
            return;
        }

        if (!isRunning()) {
            vscode.window.showWarningMessage("Arma 3 is not running. Start it with SqfReloader: Play, then run the SQF file again.");
            return;
        }

        const output = getOutput();
        output.appendLine(`--- Run in Arma: ${document.fileName}${withParameters ? " (with parameters)" : ""} ---`);

        const outcome = await runSqfFile(document, readSettings(), withParameters);
        output.appendLine(outcome.message);
        output.show(true);

        if (outcome.ok) {
            void vscode.window.showInformationMessage(outcome.message);
        } else if (outcome.message !== "Run canceled.") {
            vscode.window.showErrorMessage(`Arma 3 SQF Reloader: ${outcome.message}`);
        }
    };

    register(context, "sqfReloader.runFile", async (resource?: unknown) => runFileCommand(resource, false));
    register(context, "sqfReloader.runFileWithParameters", async (resource?: unknown) => runFileCommand(resource, true));

    register(context, "sqfReloader.openInEden", async (resource?: unknown) => {
        const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
        if (!uri || !/\.sqm$/i.test(uri.fsPath) || path.basename(uri.fsPath).toLowerCase() !== "mission.sqm" || !fs.existsSync(uri.fsPath)) {
            vscode.window.showWarningMessage("Select a mission.sqm file to open in Eden.");
            return;
        }

        const settings = readSettings();
        const missionDirectory = path.dirname(uri.fsPath);
        const foundMission = findMissions([
            ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
            missionDirectory
        ]).find(candidate => path.resolve(candidate.directory).toLowerCase() === path.resolve(missionDirectory).toLowerCase());
        if (!foundMission) {
            vscode.window.showWarningMessage("The selected mission must be in a folder named <Mission>.<World> and contain mission.sqm.");
            return;
        }
        const mission: MissionFolder = { ...foundMission };
        if (!(await confirmMissionFunctionRecompile(mission.directory))) {
            return;
        }

        if (!isRunning()) {
            if (!runtime) {
                vscode.window.showErrorMessage("The SqfReloader files bundled with this extension are missing. Reinstall the extension.");
                return;
            }

            setStatus("$(sync~spin) Starting Arma 3...", false);
            // Ensure the profile mission link exists while still opening the workspace mission directly.
            const started = await launchArma(runtime, settings, { scenarioFile: uri.fsPath, missionFolder: mission });
            if (started) {
                vscode.window.showInformationMessage(`Starting Arma 3 and opening ${path.basename(path.dirname(uri.fsPath))} in Eden.`);
                void injectWorkspaceFunctionsWhenReady(settings);
            }
            await refreshStatus();
            return;
        }

        const armaDirectory = await findArmaDirectory(settings);
        if (!armaDirectory) {
            vscode.window.showErrorMessage("Arma 3 is running, but its installation folder could not be found. Set sqfReloader.armaDirectory.");
            return;
        }

        const profile = selectArmaProfile(armaDirectory, settings.extraLaunchArguments, settings.armaProfile);
        const missionContainer = mission.multiplayer ? "MPMissions" : "Missions";
        let scenarioPath: string;
        const relativeToProfile = path.relative(profile.directory, mission.directory);
        const alreadyInProfile = relativeToProfile !== "" && !relativeToProfile.startsWith("..") && !path.isAbsolute(relativeToProfile);

        if (alreadyInProfile) {
            scenarioPath = relativeToProfile;
        } else {
            const links = linkMissions(armaDirectory, profile.directory, [mission]);
            const linkPath = path.join(profile.directory, missionContainer, path.basename(mission.directory));
            const linkCreated = links.links.some(link => path.resolve(link.linkPath).toLowerCase() === path.resolve(linkPath).toLowerCase());
            if (!linkCreated) {
                const reason = links.warnings[0] ?? `Could not link the mission into ${profile.directory}.`;
                vscode.window.showErrorMessage(`Could not prepare this mission for Eden: ${reason}`);
                return;
            }
            scenarioPath = path.join(missionContainer, path.basename(mission.directory));
        }

        const settingsNow = readSettings();
        try {
            await getStatus(settingsNow);
        } catch {
            vscode.window.showWarningMessage("Arma 3 is running, but SqfReloader is not connected. Open Eden with the @SqfReloader mod, then try again.");
            return;
        }

        const requestId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const code = `if (is3DEN) then { private _opened = load3DENScenario ${sqfString(scenarioPath)}; diag_log format ["[SqfReloader OpenMission:${requestId}] %1", _opened]; } else { diag_log format ["[SqfReloader OpenMission:${requestId}] %1", false]; };`;
        const result = await evalCode(settingsNow, code);
        if (!result.success) {
            vscode.window.showErrorMessage(`Arma 3 SQF Reloader: ${result.error ?? "Could not send the Eden mission request."}`);
            return;
        }

        const output = getOutput();
        output.appendLine(`Queued Eden request to open ${path.basename(mission.directory)}. If Arma is at the main menu, it will run when the game callback becomes available.`);
        output.show(true);
    });

    register(context, "sqfReloader.hostMission", async (resource?: unknown) => {
        const uri = resource instanceof vscode.Uri ? resource : undefined;
        if (!uri || path.basename(uri.fsPath).toLowerCase() !== "mission.sqm" || !fs.existsSync(uri.fsPath)) {
            vscode.window.showWarningMessage("Select a mission.sqm file to host.");
            return;
        }

        const missionDirectory = path.dirname(uri.fsPath);
        const roots = [
            ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
            missionDirectory
        ];
        const mission = findMissions(roots).find(candidate =>
            path.resolve(candidate.directory).toLowerCase() === path.resolve(missionDirectory).toLowerCase()
        ) ?? (fs.existsSync(path.join(missionDirectory, "description.ext"))
            ? { directory: missionDirectory, multiplayer: false, maxPlayers: readMissionMaxPlayers(missionDirectory) }
            : undefined);
        if (path.basename(path.dirname(missionDirectory)).toLowerCase() !== "mpmissions"
            || !mission || mission.maxPlayers === undefined || mission.maxPlayers <= 1) {
            vscode.window.showWarningMessage("Select a mission.sqm under an mpmissions folder whose description.ext has maxPlayers greater than 1.");
            return;
        }
        if (!runtime) {
            vscode.window.showErrorMessage("The SqfReloader files bundled with this extension are missing. Reinstall the extension.");
            return;
        }
        if (isRunning()) {
            vscode.window.showWarningMessage("Arma 3 is already running. Stop it before starting a hosted mission.");
            return;
        }
        if (!(await confirmMissionFunctionRecompile(mission.directory))) return;

        setStatus("$(sync~spin) Starting hosted mission...", false);
        const launchSettings = readSettings();
        const extraArguments = parseLaunchArguments(launchSettings.extraLaunchArguments)
            .filter(argument => !/^-mission(?:=|$)/i.test(argument));
        const started = await launchArma(runtime, launchSettings, {
            missionFolder: mission,
            hostMission: true,
            extraArguments
        });
        if (started) {
            void injectWorkspaceFunctionsWhenReady(readSettings());
        }
        await refreshStatus();
    });

    register(context, "sqfReloader.startDedicatedServer", async () => {
        if (!runtime) {
            vscode.window.showErrorMessage("The SqfReloader files bundled with this extension are missing. Reinstall the extension.");
            return;
        }
        const settings = readSettings();
        const exampleRoots = [
            ...((vscode.workspace.workspaceFolders ?? []).map(folder => path.join(folder.uri.fsPath, "server-example"))),
            path.join(context.extensionPath, "server-example"),
            path.resolve(context.extensionPath, "..", "server-mod"),
            path.resolve(__dirname, "..", "..", "server-mod")
        ];
        const exampleRoot = exampleRoots.find(candidate => fs.existsSync(path.join(candidate, "server.cfg"))) ?? exampleRoots[0];
        const serverConfig = path.join(exampleRoot, "server.cfg");
        const missions = findMissions([exampleRoot]).filter(mission => mission.multiplayer);
        if (!missions.length) {
            vscode.window.showWarningMessage("Open the server-mod example folder or a workspace containing a multiplayer mission first.");
            return;
        }
        const selected = await vscode.window.showQuickPick(missions.map(mission => ({
            label: path.basename(mission.directory),
            description: mission.directory,
            mission
        })), { placeHolder: "Select the dedicated-server mission" });
        if (!selected) return;
        const mission = selected.mission;
        const serverModDirectory = fs.existsSync(path.join(exampleRoot, "@ExampleServerMod", "addons", "server", "config.cpp"))
            ? path.join(exampleRoot, "@ExampleServerMod")
            : path.resolve(context.extensionPath, "..", "server-mod", "@ExampleServerMod");
        if (!fs.existsSync(path.join(serverModDirectory, "addons", "server", "config.cpp"))) {
            vscode.window.showErrorMessage(`Example server mod was not found under ${exampleRoot}.`);
            return;
        }
        if (!fs.existsSync(serverConfig)) {
            vscode.window.showErrorMessage(`Dedicated server example config was not found: ${serverConfig}`);
            return;
        }
        const relativeMission = path.relative(exampleRoot, mission.directory);
        if (relativeMission === ".." || relativeMission.startsWith(`..${path.sep}`) || path.isAbsolute(relativeMission)) {
            const serverDestination = path.join(exampleRoot, "MPMissions", `${path.basename(mission.directory)}.pbo`);
            fs.mkdirSync(path.dirname(serverDestination), { recursive: true });
            fs.cpSync(mission.directory, serverDestination, { recursive: true });
        }
        if (isRunning()) {
            vscode.window.showWarningMessage("A local Arma 3 instance is already running. Stop it before starting a dedicated server.");
            return;
        }
        setStatus("$(sync~spin) Starting dedicated server...", false);
        const started = await launchArma(runtime, settings, {
            dedicatedServer: true,
            missionFolder: mission,
            serverConfig,
            additionalModDirectories: [serverModDirectory]
        });
        if (started) {
            vscode.window.showInformationMessage("Dedicated server process started. SqfReloader live reload uses the local Arma client/editor session; the remote server is not automatically attached.");
        }
        await refreshStatus();
    });

    register(context, "sqfReloader.removeJunctions", async () => {
        await removeJunctions(readSettings());
    });

    register(context, "sqfReloader.openArmaFolder", async () => {
        const armaDirectory = await findArmaDirectory(readSettings());

        if (!armaDirectory) {
            vscode.window.showWarningMessage("Arma 3 was not found. Set \"sqfReloader.armaDirectory\".");
            return;
        }

        await vscode.env.openExternal(vscode.Uri.file(armaDirectory));
    });

    register(context, "sqfReloader.showOutput", async () => {
        getOutput().show(true);
    });

    register(context, "sqfReloader.toggleAutoReload", async () => {
        const enabled = !readSettings().enabled;
        await updateSetting("enabled", enabled);
        vscode.window.showInformationMessage(`Arma 3 SQF Reloader: reload on save ${enabled ? "enabled" : "disabled"}.`);
        await refreshStatus();
    });

    describeWorkspace();
    installTestHook(context, playCommand);
    void promptForExampleIfNeeded(context, version);
    void refreshStatus();
}

async function promptForExampleIfNeeded(context: vscode.ExtensionContext, version: string): Promise<void> {
    if (!(vscode.workspace.workspaceFolders?.length)) return;

    const stateKey = "setupExamplePromptVersion";
    if (context.globalState.get<string>(stateKey) === version) return;

    if (hasArmaWorkspace()) {
        await context.globalState.update(stateKey, version);
        return;
    }

    if (!workspaceHasNoFiles()) return;

    // Record before showing the prompt so workspace/settings changes cannot stack notices.
    await context.globalState.update(stateKey, version);
    const choice = await vscode.window.showInformationMessage(
        "Completed installing extension. This workspace has no Arma mod yet. Set up an example mod?",
        "Setup Example"
    );

    if (choice === "Setup Example") {
        await vscode.commands.executeCommand("sqfReloader.createExample");
    }
}

async function applyRuntimeLogLevel(settings: Settings): Promise<void> {
    const level = settings.logLevel === "verbose" ? "debug" : settings.logLevel;
    const response = await request(settings, "POST", "/log", { level });
    if (response.status !== 200) {
        throw new Error(`SqfReloader could not set log level (${response.status}): ${response.body}`);
    }
}

async function injectWorkspaceFunctionsWhenReady(settings: Settings): Promise<void> {
    if (workspaceInjectionLoop) {
        return workspaceInjectionLoop;
    }

    const generation = ++workspaceInjectionGeneration;
    const injectionLoop = runWorkspaceInjectionLoop(settings, generation);
    workspaceInjectionLoop = injectionLoop;
    try {
        await injectionLoop;
    } finally {
        if (workspaceInjectionGeneration === generation && workspaceInjectionLoop === injectionLoop) {
            workspaceInjectionLoop = undefined;
        }
    }
}

async function runWorkspaceInjectionLoop(settings: Settings, generation: number): Promise<void> {
    let reportedWaiting = false;

    while (generation === workspaceInjectionGeneration && isRunning()) {
        try {
            const status = await getStatus(settings);

            if (status.gameConnected === true) {
                const currentSettings = readSettings();
                if (currentSettings.logLevel === "verbose") {
                    await applyRuntimeLogLevel(currentSettings);
                }
                const injection = await registerWorkspaceFunctions(currentSettings);

                if (injection.ok || injection.message === "No workspace functions found.") {
                    return;
                }

                logError("workspace function injection failed", injection.message);
                return;
            } else if (!reportedWaiting) {
                log("Initial workspace function injection is waiting for Arma's mission callback.");
                reportedWaiting = true;
            }
        } catch (error) {
            if (!reportedWaiting) {
                if (configuredLogLevel() === "verbose") {
                    logError("initial workspace injection is waiting for the SqfReloader API", error);
                }
                reportedWaiting = true;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

export function deactivate(): void {
    log("Arma 3 SQF Reloader deactivated.");
    workspaceInjectionGeneration++;
    workspaceInjectionLoop = undefined;
    statusBar?.dispose();
    disposeOutput();
}

function register(context: vscode.ExtensionContext, command: string, handler: (...args: unknown[]) => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        log(`Command: ${command}`);

        try {
            await handler(...args);
        } catch (error) {
            logError(`command ${command} failed`, error);
            vscode.window.showErrorMessage(`Arma 3 SQF Reloader: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));
}

// Dev hook (not part of the user flow): with ARMA_API_TEST_OUTPUT set to a file path, the
// extension runs "SqfReloader: Create example mod" (ARMA_API_TEST_TEMPLATE=1) or "Play" once and
// mirrors its log there, which is how scripts/verify-template.js and the launcher tests drive
// the extension without automating the UI.
const testWarnings: string[] = [];

function installTestHook(context: vscode.ExtensionContext, play: () => Promise<boolean>): void {
    const target = process.env.ARMA_API_TEST_OUTPUT;

    if (!target) {
        return;
    }

    const fs = require("fs") as typeof import("fs");
    const append = (line: string) => fs.appendFileSync(target, `${line}\n`, "utf8");

    for (const method of ["showWarningMessage", "showErrorMessage"] as const) {
        const original = vscode.window[method].bind(vscode.window);
        (vscode.window as unknown as Record<string, unknown>)[method] = (message: string, ...rest: unknown[]) => {
            testWarnings.push(`${method}: ${message}`);
            return (original as (...params: unknown[]) => unknown)(message, ...rest);
        };
    }

    append(`INFO activated ${context.extension.packageJSON.version}`);
    append(`INFO extensionPath=${context.extensionPath}`);

    setTimeout(async () => {
        try {
            const settings = readSettings();
            append(`INFO armaDirectory=${settings.armaDirectory}`);
            append(`INFO runtime=${runtime ? `${runtime.modDirectory} exists=${fs.existsSync(runtime.modDirectory)}` : "missing"}`);

            if (process.env.ARMA_API_TEST_TEMPLATE) {
                await vscode.commands.executeCommand("sqfReloader.createExample");
                append(`TEMPLATE ${JSON.stringify(workspaceMods().map(mod => mod.name))}`);
            } else {
                const started = await play();
                append(`PLAY ${started ? "started" : "failed"}`);
                append(`INFO running=${isRunning()}`);
                append(`INFO mods=${JSON.stringify(workspaceMods().map(mod => mod.directory))}`);
            }

            for (const warning of testWarnings) {
                append(`WARN ${warning}`);
            }
        } catch (error) {
            append(`ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        } finally {
            append("DONE");
        }
    }, 2000);
}

function setStatus(text: string, warning: boolean, tooltip?: string): void {
    if (!statusBar) {
        return;
    }

    statusBar.text = text;
    statusBar.backgroundColor = warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    statusBar.tooltip = tooltip ?? `${text}\nClick to start Arma 3 with this mod.`;
}

function findCurrentMission(): { directory: string } | undefined {
    const document = vscode.window.activeTextEditor?.document;
    if (!document?.uri.fsPath) return undefined;

    let directory = fs.existsSync(document.uri.fsPath) && fs.statSync(document.uri.fsPath).isDirectory()
        ? document.uri.fsPath : path.dirname(document.uri.fsPath);
    const roots = [
        ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
        directory
    ];
    while (true) {
        const match = findMissions(roots).find(mission => path.resolve(mission.directory).toLowerCase() === path.resolve(directory).toLowerCase());
        if (match) return match;
        const parent = path.dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
    }
}

function hasArmaWorkspace(): boolean {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    return roots.length > 0 && (workspaceMods().length > 0 || findMissions(roots).length > 0);
}

function workspaceHasNoFiles(): boolean {
    const ignoredDirectories = new Set([".git", ".vscode", "node_modules"]);
    const hasFile = (directory: string): boolean => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return false;
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name.toLowerCase()) && hasFile(path.join(directory, entry.name))) return true;
            } else if (entry.isFile()) {
                return true;
            }
        }
        return false;
    };

    return (vscode.workspace.workspaceFolders ?? []).every(folder => !hasFile(folder.uri.fsPath));
}

function findMissionForCurrentEditor(): MissionFolder | undefined {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    const active = vscode.window.activeTextEditor?.document;
    const activePath = active?.uri.scheme === "file" ? active.fileName : undefined;
    const scanRoots = activePath ? [...roots, path.dirname(activePath)] : roots;
    const missions = findMissions(scanRoots);

    if (activePath) {
        const containing = missions
            .filter(mission => {
                const relative = path.relative(mission.directory, activePath);
                return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
            })
            .sort((left, right) => left.directory.length - right.directory.length);
        if (containing.length > 0) return containing[0];
    }

    return missions.find(mission => roots.some(root => path.resolve(root).toLowerCase() === path.resolve(mission.directory).toLowerCase()))
        ?? missions[0];
}

/** Ask before launch/switch and update only the selected mission's description.ext. */
async function confirmMissionFunctionRecompile(missionDirectory: string): Promise<boolean> {
    const descriptionPath = path.join(missionDirectory, "description.ext");
    const descriptionUri = vscode.Uri.file(descriptionPath);
    let descriptionDocument: vscode.TextDocument | undefined;

    try {
        if (fs.existsSync(descriptionPath)) {
            descriptionDocument = await vscode.workspace.openTextDocument(descriptionUri);
        }
        const source = descriptionDocument?.getText() ?? "";
        const masked = maskConfigComments(source);
        const setting = /^[ \t]*allowFunctionsRecompile\s*=\s*([^;]+);/im.exec(masked);
        if (setting && Number(setting[1].trim()) === 1) return true;

        const answer = await vscode.window.showWarningMessage(
            `Live function reload requires allowFunctionsRecompile = 1 in ${path.basename(missionDirectory)}\\description.ext. Enable it now?`,
            { modal: true },
            "Yes, enable",
            "No, continue"
        );
        if (answer === "No, continue") return true;
        if (answer !== "Yes, enable") return false;

        let updated: string;
        if (setting) {
            const start = setting.index;
            const originalMatch = /^[ \t]*allowFunctionsRecompile\s*=\s*[^;]+;/im.exec(source.slice(start));
            if (!originalMatch) throw new Error("Could not update allowFunctionsRecompile in description.ext.");
            const leadingSpace = /^[ \t]*/.exec(originalMatch[0])?.[0] ?? "";
            updated = source.slice(0, start) + `${leadingSpace}allowFunctionsRecompile = 1;` + source.slice(start + originalMatch[0].length);
        } else {
            updated = `${source}${source.length > 0 && !/[\r\n]$/.test(source) ? "\r\n" : ""}allowFunctionsRecompile = 1;\r\n`;
        }

        if (descriptionDocument) {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(descriptionUri, new vscode.Range(descriptionDocument.positionAt(0), descriptionDocument.positionAt(descriptionDocument.getText().length)), updated);
            if (!(await vscode.workspace.applyEdit(edit)) || !(await descriptionDocument.save())) {
                throw new Error("VS Code could not save the updated description.ext.");
            }
        } else {
            await vscode.workspace.fs.writeFile(descriptionUri, Buffer.from(updated, "utf8"));
        }

        log(`Enabled allowFunctionsRecompile in ${descriptionPath}.`);
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Could not enable live function reload: ${message}`);
        return false;
    }
}

function maskConfigComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\r\n]/g, " "))
        .replace(/^\s*\/\/.*$/gm, match => match.replace(/[^\r\n]/g, " "));
}

function parseLaunchArguments(value: string): string[] {
    const argumentsList: string[] = [];
    let current = "";
    let quote: "\"" | "'" | undefined;
    for (const character of value) {
        if (quote) {
            current += character;
            if (character === quote) quote = undefined;
        } else if (character === "\"" || character === "'") {
            quote = character;
            current += character;
        } else if (/\s/.test(character)) {
            if (current) argumentsList.push(current);
            current = "";
        } else {
            current += character;
        }
    }
    if (current) argumentsList.push(current);
    return argumentsList;
}

function shorten(message: string): string {
    return message.length > 40 ? `${message.slice(0, 37)}...` : message;
}

/** Startup log: what the launcher will pass to Arma. */
function describeWorkspace(): void {
    const mods = workspaceMods();
    const missions = findMissions((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath));

    if (mods.length === 0 && missions.length === 0) {
        log("No Arma mod or mission found in this workspace. Open a project folder or choose Setup Example from the Play button.");
        return;
    }

    if (mods.length > 0) log(`Workspace mods: ${mods.map(mod => `${mod.name} [${mod.addons.map(addon => addon.prefix).join(", ")}]`).join(", ")}`);
    if (missions.length > 0) log(`Workspace missions: ${missions.map(mission => `${path.basename(mission.directory)} (${mission.multiplayer ? "MP" : "SP"})`).join(", ")}`);
}

/** Reflects the live API state in the status bar; quiet when Arma is not running. */
async function refreshStatus(): Promise<void> {
    if (isRunning()) {
        statusBar && (statusBar.command = "sqfReloader.stop");
        setStatus("$(debug-stop) Stop Arma 3", false, "Stop the running Arma 3 process");
        return;
    }

    if (statusBar) statusBar.command = "sqfReloader.play";
    const settings: Settings = readSettings();
    if (!hasArmaWorkspace()) {
        setStatus("$(warning) No workspace found for Arma 3", true, "Open an Arma mod or mission, or click to set up an example workspace.");
        return;
    }

    try {
        const status = await getStatus(settings);
        setStatus("$(play) Play Arma 3", false, status.gameConnected ? "Start another Arma 3 session with this mod" : "Start Arma 3 with this mod and SqfReloader");
    } catch {
        setStatus("$(play) Play Arma 3", false, "Start Arma 3 with this mod and SqfReloader");
    }
}

// Kept exported for scripts/verify-extension.js.
export { findModForFile, workspaceAddons, verifyWorkspaceAddons, writeApiConfig };
