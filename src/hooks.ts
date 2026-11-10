import * as vscode from "vscode";
import { HookPresentation, log, logError, Settings } from "./settings";

/** Values available to a hook command as ${variables} and SQFRELOADER_* environment entries. */
export interface HookContext {
    armaDirectory?: string;
    missionFolder?: string;
    file?: string;
    exitCode?: number;
    apiUrl?: string;
}

/**
 * Runs the commands configured for one lifecycle event. Returns false when a blocking command
 * failed and the action must not continue. Non-blocking hooks return true immediately.
 */
export async function runHook(event: string, settings: Settings, context: HookContext = {}): Promise<boolean> {
    const hook = settings.hooks[event];
    if (!hook || hook.commands.length === 0) return true;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        // Launching Arma or reloading always happens in a project, so this only hits commands
        // triggered without a folder; they cannot resolve ${workspaceFolder}.
        logError(`hook ${event} skipped`, new Error("no workspace folder is open"));
        return !hook.blocking;
    }
    if (!vscode.workspace.isTrusted) {
        log(`Hook ${event} skipped: the workspace is not trusted.`);
        return true;
    }

    const presentation = resolvePresentation(settings.hookPresentation, hook.presentation);
    const env = hookEnvironment(event, folder, context);

    const execute = async (): Promise<boolean> => {
        for (const rawCommand of hook.commands) {
            const command = expandVariables(rawCommand, folder, context, event);
            log(`Hook ${event}: ${command}`);
            const exitCode = await runCommandInTerminal(event, command, folder, presentation, env);
            if (exitCode !== undefined && exitCode !== 0) {
                logError(`hook ${event} command failed`, new Error(`exit code ${exitCode}: ${command}`));
                if (hook.continueOnError) {
                    log(`Hook ${event} continues after a failing command.`);
                    continue;
                }
                if (hook.blocking) {
                    void vscode.window.showErrorMessage(`Hook ${event} failed (exit code ${exitCode}): ${rawCommand}.`);
                    return false;
                }
            }
        }
        return true;
    };

    if (hook.blocking) return execute();
    void execute().catch(error => logError(`hook ${event} failed`, error));
    return true;
}

/** Runs a non-blocking hook without awaiting it. */
export function fireHook(event: string, settings: Settings, context: HookContext = {}): void {
    void runHook(event, settings, context).catch(error => logError(`hook ${event} failed`, error));
}

function resolvePresentation(base: HookPresentation, override: HookPresentation | undefined): HookPresentation {
    return override ? { ...base, ...override } : base;
}

async function runCommandInTerminal(
    event: string,
    command: string,
    folder: vscode.WorkspaceFolder,
    presentation: HookPresentation,
    env: Record<string, string>
): Promise<number | undefined> {
    const task = new vscode.Task(
        { type: "shell" },
        folder,
        `SqfReloader: ${event}`,
        "SqfReloader",
        new vscode.ShellExecution(command, { cwd: folder.uri.fsPath, env }),
        []
    );
    task.presentationOptions = {
        echo: presentation.echo,
        reveal: presentation.reveal === "never"
            ? vscode.TaskRevealKind.Never
            : presentation.reveal === "silent" ? vscode.TaskRevealKind.Silent : vscode.TaskRevealKind.Always,
        focus: presentation.focus,
        panel: presentation.panel === "dedicated"
            ? vscode.TaskPanelKind.Dedicated
            : presentation.panel === "new" ? vscode.TaskPanelKind.New : vscode.TaskPanelKind.Shared,
        showReuseMessage: false
    };

    const execution = await vscode.tasks.executeTask(task);

    return new Promise<number | undefined>(resolve => {
        let settled = false;
        const finish = (exitCode: number | undefined): void => {
            if (settled) return;
            settled = true;
            endProcess.dispose();
            endTask.dispose();
            resolve(exitCode);
        };
        const endProcess = vscode.tasks.onDidEndTaskProcess(event => {
            if (event.execution === execution) finish(event.exitCode);
        });
        const endTask = vscode.tasks.onDidEndTask(event => {
            if (event.execution === execution) finish(undefined);
        });
    });
}

function expandVariables(command: string, folder: vscode.WorkspaceFolder, context: HookContext, event: string): string {
    const values: Record<string, string | undefined> = {
        workspaceFolder: folder.uri.fsPath,
        workspaceFolderBasename: folder.name,
        event,
        armaDirectory: context.armaDirectory,
        missionFolder: context.missionFolder,
        file: context.file,
        apiUrl: context.apiUrl,
        exitCode: context.exitCode === undefined ? undefined : String(context.exitCode)
    };

    return command.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => values[name] ?? match);
}

function hookEnvironment(event: string, folder: vscode.WorkspaceFolder, context: HookContext): Record<string, string> {
    const env: Record<string, string> = {
        SQFRELOADER_EVENT: event,
        SQFRELOADER_WORKSPACE: folder.uri.fsPath
    };
    if (context.armaDirectory) env.SQFRELOADER_ARMA_DIR = context.armaDirectory;
    if (context.missionFolder) env.SQFRELOADER_MISSION = context.missionFolder;
    if (context.file) env.SQFRELOADER_FILE = context.file;
    if (context.apiUrl) env.SQFRELOADER_API_URL = context.apiUrl;
    if (context.exitCode !== undefined) env.SQFRELOADER_EXIT_CODE = String(context.exitCode);
    return env;
}
