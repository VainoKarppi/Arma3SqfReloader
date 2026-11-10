import * as vscode from "vscode";
import { currentApiPort } from "./runtime";
import { DEFAULT_PORT, makeApiUrl, normalizeApiHost } from "./ports";
import { DEFAULT_HOOK_PRESENTATION, readProjectSettings, setProjectSetting } from "./projectSettings";
import { HOOK_EVENTS } from "./hookEvents";

export type ReloadMode = "reload" | "recompile" | "off";
export type DeletedFunctionBehavior = "clear" | "ask" | "keep";
export type JunctionMode = "addon" | "module";
export type LogLevel = "error" | "warning" | "info" | "verbose";
export type HookReveal = "always" | "silent" | "never";
export type HookPanel = "shared" | "dedicated" | "new";

/** Terminal presentation for hook tasks, mirroring VS Code task presentation options. */
export interface HookPresentation {
    echo: boolean;
    reveal: HookReveal;
    focus: boolean;
    panel: HookPanel;
}

/** Commands run for one lifecycle event. */
export interface HookSettings {
    commands: string[];
    /** Whether the caller waits for the commands before continuing. */
    blocking: boolean;
    /** Whether a failing command lets the action continue. */
    continueOnError: boolean;
    /** Per-hook presentation override. */
    presentation?: HookPresentation;
}

export interface Settings {
    enabled: boolean;
    apiUrl: string;
    apiPort: number;
    armaDirectory: string;
    armaProfile: string;
    requestTimeout: number;
    /** Maximum time to wait for an SQF file run to return its value, in seconds. */
    runTimeout: number;
    autoJunction: boolean;
    junctionMode: JunctionMode;
    reloadOnSave: ReloadMode;
    deletedFunctionBehavior: DeletedFunctionBehavior;
    notifyOnError: boolean;
    /** Extra arguments added when launching Arma (e.g. "-window -noSplash"). */
    extraLaunchArguments: string;
    /** "Create example mod" also writes a minimal test mission. */
    createExampleWithMission: boolean;
    /** Remove Arma-generated ~Mission.World preview copies from the active profile. */
    clearArmaMissionArtifacts: boolean;
    /** Diagnostic verbosity in the VS Code output and Arma RPT. */
    logLevel: LogLevel;
    /** Commands keyed by lifecycle event (see hookEvents.ts). */
    hooks: Record<string, HookSettings>;
    /** Default presentation for every hook terminal. */
    hookPresentation: HookPresentation;
}

export function readSettings(): Settings {
    const values = readProjectSettings();
    const apiPort = readApiPort(values);
    const configuredApiUrl = stringValue(values, "apiUrl", "http://127.0.0.1");

    return {
        enabled: booleanValue(values, "enabled", true),
        apiUrl: trimSlash(resolveApiUrl(makeApiUrl(configuredApiUrl, apiPort))),
        apiPort,
        armaDirectory: stringValue(values, "armaDirectory", "").trim(),
        armaProfile: stringValue(values, "armaProfile", "").trim(),
        requestTimeout: Math.max(500, numberValue(values, "requestTimeout", 3000)),
        runTimeout: Math.min(300, Math.max(1, numberValue(values, "runTimeout", 30))),
        autoJunction: booleanValue(values, "autoJunction", true),
        junctionMode: normalizeJunctionMode(stringValue(values, "junctionMode", "addon")),
        reloadOnSave: normalizeReloadMode(stringValue(values, "reloadOnSave", "reload")),
        deletedFunctionBehavior: normalizeDeletedFunctionBehavior(stringValue(values, "deletedFunctionBehavior", "keep")),
        notifyOnError: booleanValue(values, "notifyOnError", true),
        extraLaunchArguments: stringValue(values, "extraLaunchArguments", "-noSplash -skipIntro -noPause"),
        createExampleWithMission: booleanValue(values, "createExampleWithMission", true),
        clearArmaMissionArtifacts: booleanValue(values, "clearArmaMissionArtifacts", true),
        logLevel: normalizeLogLevel(stringValue(values, "logLevel", "info")),
        hooks: hooksValue(values),
        hookPresentation: presentationValue(values, "hookPresentation")
    };
}

export function hooksValue(values: Record<string, unknown>): Record<string, HookSettings> {
    const raw = values.hooks;
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const hooks: Record<string, HookSettings> = {};
    const known = new Set<string>();

    for (const definition of HOOK_EVENTS) {
        known.add(definition.event);
        hooks[definition.event] = hookValue(source[definition.event], definition.blocking);
    }

    // Unknown events are kept so hand-written settings survive a save from the panel.
    for (const [event, value] of Object.entries(source)) {
        if (!known.has(event)) hooks[event] = hookValue(value, false);
    }

    return hooks;
}

export function hookValue(raw: unknown, defaultBlocking: boolean): HookSettings {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const presentation = source.presentation && typeof source.presentation === "object" && !Array.isArray(source.presentation)
        ? presentationValue(source, "presentation")
        : undefined;
    return {
        commands: stringArrayValue(source as Record<string, unknown>, "commands"),
        blocking: typeof source.blocking === "boolean" ? source.blocking : defaultBlocking,
        continueOnError: typeof source.continueOnError === "boolean" ? source.continueOnError : false,
        presentation
    };
}

export function stringArrayValue(values: Record<string, unknown>, key: string): string[] {
    const value = values[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean);
}

export function presentationValue(values: Record<string, unknown>, key: string): HookPresentation {
    const value = values[key];
    const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
        echo: typeof source.echo === "boolean" ? source.echo : DEFAULT_HOOK_PRESENTATION.echo,
        reveal: normalizeReveal(source.reveal),
        focus: typeof source.focus === "boolean" ? source.focus : DEFAULT_HOOK_PRESENTATION.focus,
        panel: normalizePanel(source.panel)
    };
}

export function normalizeReveal(value: unknown): HookReveal {
    return value === "silent" || value === "never" ? value : "always";
}

export function normalizePanel(value: unknown): HookPanel {
    return value === "dedicated" || value === "new" ? value : "shared";
}

export function readApiPort(values: Record<string, unknown> = readProjectSettings()): number {
    return normalizePort(numberValue(values, "apiPort", DEFAULT_PORT));
}

function stringValue(values: Record<string, unknown>, key: string, fallback: string): string {
    const value = values[key];
    return typeof value === "string" ? value : fallback;
}

function numberValue(values: Record<string, unknown>, key: string, fallback: number): number {
    const value = values[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(values: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const value = values[key];
    return typeof value === "boolean" ? value : fallback;
}

function normalizeJunctionMode(mode: string): JunctionMode {
    return mode.trim().toLowerCase() === "module" ? "module" : "addon";
}

function normalizeReloadMode(mode: string): ReloadMode {
    switch (mode.trim().toLowerCase()) {
        case "recompile":
            return "recompile";
        case "off":
            return "off";
        default:
            return "reload";
    }
}

function normalizeDeletedFunctionBehavior(value: string): DeletedFunctionBehavior {
    switch (value.trim().toLowerCase()) {
        case "clear":
            return "clear";
        case "ask":
            return "ask";
        default:
            return "keep";
    }
}

function normalizeLogLevel(level: string): LogLevel {
    switch (level.trim().toLowerCase()) {
        case "error":
            return "error";
        case "warning":
            return "warning";
        case "verbose":
            return "verbose";
        default:
            return "info";
    }
}

function normalizePort(port: number): number {
    return Number.isFinite(port) ? Math.min(65535, Math.max(1, Math.trunc(port))) : DEFAULT_PORT;
}

export async function updateSetting<T>(key: string, value: T): Promise<void> {
    await setProjectSetting(key, value);
}

export function configuredLogLevel(): LogLevel {
    return readSettings().logLevel;
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

/**
 * Overrides the configured port with the port that was written to SqfReloader's config.json.
 *
 * Port 8764 is commonly taken by other Arma tools (EdenOnline, an earlier SqfReloader build),
 * and the DLL then answers "Failed to listen ... conflicts with an existing registration on
 * the machine". The launcher writes the resolved port back, so requests have to follow it.
 */
function resolveApiUrl(apiUrl: string): string {
    const port = currentApiPort();

    if (!port) {
        return apiUrl;
    }

    try {
        const url = new URL(apiUrl);
        if (Number(url.port || 0) === port) {
            return apiUrl;
        }

        url.port = String(port);
        return url.toString();
    } catch {
        return apiUrl;
    }
}

let channel: vscode.OutputChannel | undefined;

export function getOutput(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel("Arma 3 SQF Reloader");
    }

    return channel;
}

export function log(message: string): void {
    if (configuredLogLevel() !== "verbose") {
        return;
    }

    getOutput().appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    mirrorToTestOutput(`LOG ${message}`);
}

export function logError(message: string, error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (configuredLogLevel() !== "error") {
        getOutput().appendLine(`[${new Date().toLocaleTimeString()}] ERROR: ${message} - ${detail}`);
        mirrorToTestOutput(`LOG ERROR: ${message} - ${detail}`);
    }
}

/** Dev aid: scripts/verify-launch.js points ARMA_API_TEST_OUTPUT at a file and reads the log from there. */
function mirrorToTestOutput(line: string): void {
    const target = process.env.ARMA_API_TEST_OUTPUT;

    if (!target) {
        return;
    }

    try {
        require("fs").appendFileSync(target, `${line}\n`, "utf8");
    } catch {
        // The test output file is best effort only.
    }
}

export function disposeOutput(): void {
    channel?.dispose();
    channel = undefined;
}
