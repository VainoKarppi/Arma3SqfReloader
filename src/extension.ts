import * as vscode from "vscode";
import { getStatus } from "./api";
import { disposeOutput, getOutput, log, logError, readSettings, Settings, updateSetting } from "./settings";
import { ensureJunctions, openArmaFolder, removeJunctions, setupFromContext, setupWorkspace } from "./setup";
import { findArmaDirectory, findModForFile } from "./arma";
import { removeAllLinks, removeModInZLink } from "./junctions";
import { isReloadable, registerWorkspaceFunctions, reloadAll, reloadDocument, reloadFileNow } from "./reload";
import { isRunning, launchArma, setRptDiagnosticCollection, startRptMonitor, stopRptMonitor } from "./launcher";
import { loadRuntime, Runtime, workspaceMods, workspaceAddons, writeApiConfig } from "./runtime";
import { verifyWorkspaceAddons } from "./runtime";
import { scaffoldExample } from "./scaffold";

let statusBar: vscode.StatusBarItem | undefined;
let runtime: Runtime | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const version = context.extension.packageJSON.version;
    log(`Arma 3 SQF Reloader ${version} activated.`);

    runtime = loadRuntime(context);
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
    const statusTimer = setInterval(() => void refreshStatus(), 2000);
    context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });

    // --- Save -> reload ---------------------------------------------------
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async document => {
        const settings = readSettings();

        if (!settings.enabled || !isReloadable(document)) {
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
            await ensureJunctions(readSettings());
            await refreshStatus();
        } catch (error) {
            logError("workspace change handling failed", error);
        }
    };

    void onWorkspaceChange();

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(onWorkspaceChange));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("sqfReloader")) {
            log("Settings changed.");
            void onWorkspaceChange();
        }
    }));

    // --- Commands ---------------------------------------------------------
    const playCommand = async (): Promise<boolean> => {
        if (!runtime) {
            vscode.window.showErrorMessage("The SqfReloader files bundled with this extension are missing. Reinstall the extension.");
            return false;
        }

        const settings = readSettings();
        setStatus("$(sync~spin) Starting Arma 3...", false);

        const started = await launchArma(runtime, settings);

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
            // Pick up the new $PBOPREFIX$ right away (and create the junctions eagerly).
            await ensureJunctions(readSettings());
            await refreshStatus();
        }
    });

    register(context, "sqfReloader.connect", async () => {
        const settings = readSettings();

        try {
            const status = await getStatus(settings);
            const connected = status.gameConnected === true;
            const message = `SqfReloader ${status.version ?? "?"} on ${settings.apiUrl} - game callback ${connected ? "registered" : "NOT registered"}.`;

            if (connected) {
                const injection = await registerWorkspaceFunctions(settings);
                if (!injection.ok) {
                    log(`Workspace function injection failed: ${injection.message}`);
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
    void refreshStatus();
}

async function injectWorkspaceFunctionsWhenReady(settings: Settings): Promise<void> {
    let reportedWaiting = false;

    while (isRunning()) {
        try {
            const status = await getStatus(settings);

            if (status.gameConnected === true) {
                const injection = await registerWorkspaceFunctions(settings);

                if (injection.ok || injection.message === "No workspace functions found.") {
                    return;
                }

                log(`Workspace function injection failed: ${injection.message}`);
            } else if (!reportedWaiting) {
                log("Initial workspace function injection is waiting for Arma's mission callback.");
                reportedWaiting = true;
            }
        } catch {
            if (!reportedWaiting) {
                log("Initial workspace function injection is waiting for the SqfReloader API.");
                reportedWaiting = true;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

export function deactivate(): void {
    log("Arma 3 SQF Reloader deactivated.");
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

function shorten(message: string): string {
    return message.length > 40 ? `${message.slice(0, 37)}...` : message;
}

/** Startup log: what the launcher will pass to Arma. */
function describeWorkspace(): void {
    const mods = workspaceMods();

    if (mods.length === 0) {
        log("No mod in this workspace yet. Open a folder that contains addons/ (or config.cpp) to launch it with Arma.");
        return;
    }

    log(`Workspace mods: ${mods.map(mod => `${mod.name} [${mod.addons.map(addon => addon.prefix).join(", ")}]`).join(", ")}`);
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

    try {
        const status = await getStatus(settings);
        setStatus("$(play) Play Arma 3", false, status.gameConnected ? "Start another Arma 3 session with this mod" : "Start Arma 3 with this mod and SqfReloader");
    } catch {
        setStatus("$(play) Play Arma 3", false, "Start Arma 3 with this mod and SqfReloader");
    }
}

// Kept exported for scripts/verify-extension.js.
export { findModForFile, workspaceAddons, verifyWorkspaceAddons, writeApiConfig };
