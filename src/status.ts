import { Settings } from "./settings";

export interface ServiceState {
    api: boolean;
    game: boolean;
}

export interface StatusSnapshot {
    /** Arma 3 (client) process detected. */
    game: boolean;
    /** Dedicated server process detected. */
    dedicatedServer: boolean;
    /** The single SqfReloader API every Arma instance uses. */
    api: ServiceState;
}

/** Icon/colour the status bar entry should use. */
export type StatusTone = "ok" | "warning" | "busy" | "error";

export interface StatusPresentation {
    text: string;
    tone: StatusTone;
    tooltip: string;
}

/** A cold Arma start loads mods and opens the API within seconds; allow for slow machines. */
const STARTUP_GRACE_MS = 180_000;

/**
 * Startup-grace state. Kept in an explicit object (instead of module state) so the status text
 * does not depend on activation history when several workspaces share one extension host.
 */
export interface StatusTracker {
    /** First moment a game/server process was reported while it had no API connection. */
    processSeenAt?: number;
}

export function createStatusTracker(): StatusTracker {
    return {};
}

/** Tracker used when a caller does not pass one. */
export const defaultStatusTracker: StatusTracker = createStatusTracker();

/**
 * Milliseconds the current process has been running without the API answering, or undefined
 * when no game/server runs. Cleared when the process disappears, so the next launch starts a
 * fresh grace period.
 */
function processAge(snapshot: StatusSnapshot, now: number, tracker: StatusTracker): number | undefined {
    if (!snapshot.game && !snapshot.dedicatedServer) {
        tracker.processSeenAt = undefined;
        return undefined;
    }

    tracker.processSeenAt ??= now;
    return now - tracker.processSeenAt;
}

function port(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    } catch {
        return "?";
    }
}

/**
 * "Game: Running · Dedicated Server: Stopped · API: Running"
 *
 * There is one API for every Arma instance (client, editor, hosted mission, dedicated server),
 * so it is reported once instead of per instance type.
 */
export function statusSummary(snapshot: StatusSnapshot): string {
    const api = snapshot.api.api ? "Running" : "Stopped";
    return [
        `Game: ${snapshot.game ? "Running" : "Stopped"}`,
        `Dedicated Server: ${snapshot.dedicatedServer ? "Running" : "Stopped"}`,
        `API: ${api}`,
    ].join(" · ");
}

/**
 * Status bar text and tone. Everything that is meant to run is green; a game/server that is
 * still booting shows a spinner, and only a missing API after the startup grace period is red
 * (reloads cannot work then). With nothing running the neutral "Play" action is shown.
 */
export function statusPresentation(snapshot: StatusSnapshot, settings: Settings, now = Date.now(), tracker: StatusTracker = defaultStatusTracker): StatusPresentation {
    const detail = [
        statusSummary(snapshot),
        `SqfReloader API: ${settings.apiUrl} (port ${port(settings.apiUrl)})`
    ];
    const age = processAge(snapshot, now, tracker);

    if (age !== undefined && !snapshot.api.api) {
        if (age < STARTUP_GRACE_MS) {
            return {
                text: `$(sync~spin) Arma 3 · starting`,
                tone: "busy",
                tooltip: ["Arma 3 is starting; waiting for the SqfReloader API.", ...detail].join("\n")
            };
        }

        return {
            text: `$(error) SqfReloader: API offline`,
            tone: "warning",
            tooltip: [
                "Arma 3 is running but its SqfReloader API does not answer.",
                "Open the Eden Editor or start a mission to initialize the API.\n",
                ...detail
            ].join("\n")
        };
    }

    if (snapshot.game || snapshot.dedicatedServer) {
        if (!snapshot.api.game) {
            return {
                text: `$(sync~spin) Arma 3 · connecting`,
                tone: "busy",
                tooltip: ["Waiting for Arma's SqfReloader callback.", ...detail].join("\n")
            };
        }

        return {
            text: `$(pass-filled) Arma 3${snapshot.dedicatedServer ? " + server" : ""}`,
            tone: "ok",
            tooltip: ["Arma 3 is connected.", ...detail].join("\n")
        };
    }

    if (snapshot.api.api) {
        // An API outlives the game it was started from; it is not a problem, but not green either.
        return {
            text: `$(warning) SqfReloader API idle`,
            tone: "warning",
            tooltip: ["An SqfReloader API still answers, but no Arma 3 process was found.", ...detail].join("\n")
        };
    }

    return {
        text: `$(play) Play Arma 3`,
        tone: "ok",
        tooltip: ["Start Arma 3 with this mod and SqfReloader.", ...detail].join("\n")
    };
}

/** The status tone describes this state as a ThemeColor id for the status bar. */
export function toneColor(tone: StatusTone): string | undefined {
    switch (tone) {
        case "error":
            return "statusBarItem.errorBackground";
        case "warning":
            return "statusBarItem.warningBackground";
        default:
            return undefined;
    }
}
