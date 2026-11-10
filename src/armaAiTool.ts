import * as vscode from "vscode";
import * as path from "path";
import { evalCode, getStatus } from "./api";
import { refreshRunningStatus } from "./launcher";
import { Settings } from "./settings";

export const ARMA_AI_TOOL_NAME = "armaAiTool";

export interface ArmaAiToolInput {
    action: "context" | "status" | "eval";
    code?: string;
}

interface ArmaConnectionCheck {
    gameRunning: boolean;
    apiResponding: boolean;
    gameConnected: boolean;
    apiVersion?: string;
    logDirectory?: string;
    error?: string;
}

export async function checkArmaConnection(settings: Settings): Promise<ArmaConnectionCheck> {
    const gameRunning = await refreshRunningStatus();

    try {
        const status = await getStatus(settings);
        return {
            gameRunning,
            apiResponding: true,
            gameConnected: status.gameConnected === true,
            apiVersion: status.version,
            logDirectory: status.logDirectory
        };
    } catch (error) {
        return {
            gameRunning,
            apiResponding: false,
            gameConnected: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function evaluateSqfInArma(settings: Settings, code: string): Promise<Record<string, unknown>> {
    const connection = await checkArmaConnection(settings);
    if (!connection.gameRunning || !connection.apiResponding || !connection.gameConnected) {
        return {
            ok: false,
            ...connection,
            message: "SQF was not evaluated. Arma must be running, the SqfReloader API must respond, and the game callback must be connected."
        };
    }

    try {
        const result = await evalCode(settings, code);
        if (!result.success) {
            return { ok: false, ...connection, error: result.error ?? "Arma rejected the SQF evaluation." };
        }
        return {
            ok: true,
            ...connection,
            result: result.result,
            text: result.text
        };
    } catch (error) {
        return {
            ok: false,
            ...connection,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

const ARMA_CONTEXT_CODE = `private _mode = if (is3DEN) then {"3DEN"} else {if (!isMultiplayer) then {"Singleplayer"} else {if (isDedicated) then {"Dedicated Server"} else {if (isServer) then {"Hosted Server"} else {"Client"}}}};
str [
    ["mode", _mode],
    ["isMultiplayer", isMultiplayer],
    ["isServer", isServer],
    ["isDedicated", isDedicated],
    ["hasInterface", hasInterface],
    ["is3DEN", is3DEN],
    ["missionName", missionName],
    ["worldName", worldName],
    ["profileName", profileName],
    ["clientOwner", clientOwner],
    ["playerCount", count allPlayers],
    ["loadedMods", getLoadedModsInfo apply {_x select 0}],
    ["activatedAddons", activatedAddons]
]`;

export class ArmaAiTool implements vscode.LanguageModelTool<ArmaAiToolInput> {
    constructor(private readonly getSettings: () => Settings) {}

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ArmaAiToolInput>): Promise<vscode.PreparedToolInvocation> {
        const action = options.input.action;
        if (action === "context") {
            return { invocationMessage: "Reading the current Arma session context" };
        }
        if (action === "eval") {
            return {
                invocationMessage: "Evaluating SQF in Arma",
                confirmationMessages: {
                    title: "Run SQF in Arma?",
                    message: "This SQF runs in the current Arma session and may change its state."
                }
            };
        }
        return { invocationMessage: "Checking Arma and SqfReloader API status" };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ArmaAiToolInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        let result: Record<string, unknown>;
        if (token.isCancellationRequested) {
            result = { ok: false, error: "The Arma tool request was cancelled." };
        } else if (options.input.action === "context") {
            const settings = this.getSettings();
            const connection = await checkArmaConnection(settings);
            if (!connection.gameRunning || !connection.apiResponding || !connection.gameConnected) {
                result = {
                    ok: false,
                    ...connection,
                    message: "Arma context is unavailable until Arma is running, the API responds, and the game callback is connected."
                };
            } else {
                try {
                    const context = await evalCode(settings, ARMA_CONTEXT_CODE);
                    result = context.success
                        ? {
                            ok: true,
                            ...connection,
                            apiUrl: settings.apiUrl,
                            sqfReloaderLogFile: connection.logDirectory
                                ? path.join(connection.logDirectory, "SqfReloader.log")
                                : undefined,
                            context: context.text ?? context.result
                        }
                        : { ok: false, ...connection, error: context.error ?? "Could not read the current Arma context." };
                } catch (error) {
                    result = {
                        ok: false,
                        ...connection,
                        error: error instanceof Error ? error.message : String(error)
                    };
                }
            }
        } else if (options.input.action === "status") {
            const status = await checkArmaConnection(this.getSettings());
            result = {
                ok: status.gameRunning && status.apiResponding && status.gameConnected,
                ...status
            };
        } else if (typeof options.input.code !== "string" || options.input.code.trim().length === 0) {
            result = { ok: false, error: "Provide SQF code to evaluate." };
        } else if (options.input.code.length > 20000) {
            result = { ok: false, error: "SQF input is limited to 20,000 characters." };
        } else if (token.isCancellationRequested) {
            result = { ok: false, error: "The Arma tool request was cancelled." };
        } else {
            result = await evaluateSqfInArma(this.getSettings(), options.input.code);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
        ]);
    }
}
