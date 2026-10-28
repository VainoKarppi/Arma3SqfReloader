import { ApiError, getStatus, request, Status } from "./api";
import { getOutput, log, readSettings, Settings } from "./settings";

export interface ApiTarget {
    /** The single SqfReloader API used by every Arma instance. */
    name: "client" | "server";
    apiUrl: string;
}

export interface ApiTargetState {
    /** The REST API answers on this port. */
    api: boolean;
    /** The game registered its extension callback and can run SQF. */
    game: boolean;
    /** Last status payload, when the API answered. */
    status?: Status;
}

/** Returns a line for the output channel when the reported state changes, or undefined to stay quiet. */
export type ConnectionDescriber = (target: ApiTarget, state: ApiTargetState) => string | undefined;

type TargetState = "offline" | "waiting" | "connected";

const CONNECTED_POLL_MS = 3000;
const DISCONNECTED_POLL_MS = 1000;
/** Status errors that mean "nothing listens on this port" rather than "the API rejected us". */
const OFFLINE_CODES = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"];

/**
 * The one endpoint every instance uses: client, editor, hosted mission and dedicated server all
 * bind sqfReloader.apiPort, so there is nothing to guess from the instance type.
 */
export function apiTargets(settings: Settings = readSettings()): ApiTarget[] {
    return [{ name: "client", apiUrl: settings.apiUrl }];
}

/** Probes one endpoint: is the API listening, and is a game callback connected? */
export async function readApiTarget(target: ApiTarget, settings: Settings = readSettings()): Promise<ApiTargetState> {
    try {
        const status = await getStatus({ ...settings, apiUrl: target.apiUrl });
        return { api: true, game: status.gameConnected === true, status };
    } catch (error) {
        if (isOffline(error)) return { api: false, game: false };
        throw error;
    }
}

function isOffline(error: unknown): boolean {
    if (!(error instanceof ApiError)) return false;

    const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
    return (!!code && OFFLINE_CODES.includes(code)) || /not listening|ECONNREFUSED/i.test(error.message);
}

/**
 * Polls the client and server endpoints and writes connection changes to the output channel,
 * so the first Arma 3 (or dedicated server) callback is visible without watching the panel.
 */
export class GameConnectionMonitor {
    private timer: NodeJS.Timeout | undefined;
    private polling = false;
    private readonly states = new Map<string, TargetState>();

    constructor(private readonly describe: ConnectionDescriber) { }

    start(): void {
        if (this.timer || this.polling) return;
        void this.poll();
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private async poll(): Promise<void> {
        this.polling = true;
        let delay = CONNECTED_POLL_MS;

        try {
            const settings = readSettings();

            for (const target of apiTargets(settings)) {
                let state: ApiTargetState;
                try {
                    state = await readApiTarget(target, settings);
                } catch (error) {
                    log(`Connection check for the ${target.name} API failed: ${error instanceof Error ? error.message : String(error)}`);
                    delay = DISCONNECTED_POLL_MS;
                    continue;
                }

                const next: TargetState = state.game ? "connected" : state.api ? "waiting" : "offline";
                if (this.states.get(target.apiUrl) !== next) {
                    this.states.set(target.apiUrl, next);
                    const message = this.describe(target, state);
                    if (message) getOutput().appendLine(message);
                }

                if (next !== "connected") delay = Math.min(delay, DISCONNECTED_POLL_MS);
            }
        } finally {
            this.polling = false;
            this.timer = setTimeout(() => void this.poll(), delay);
        }
    }
}

/** Sends a supported log level to an endpoint; "verbose" maps to the DLL's "debug". */
export async function setRemoteLogLevel(settings: Settings, apiUrl: string, level: string): Promise<void> {
    const response = await request({ ...settings, apiUrl }, "POST", "/log", { level });
    if (response.status !== 200) {
        throw new Error(`SqfReloader could not set log level (${response.status}): ${response.body}`);
    }
}
