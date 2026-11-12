/**
 * "Example mod is ready" banner in the Arma Project view.
 *
 * It replaces the old notification: VS Code only styles the first notification action as a
 * filled button, so the two follow-up actions (Play Arma 3 / Start dedicated server) could not
 * both look like buttons. The webview uses the theme's button colour for both.
 *
 * Session state on purpose: the banner is a follow-up to a command the user just ran, so it does
 * not need to survive a window reload.
 */
let ready = false;
let title = "";

export function markExampleReady(modDirectory?: string): void {
    ready = true;
    title = modDirectory ? "Example mod is ready" : "Example files are ready";
}

export function clearExampleReady(): void {
    ready = false;
}

export function exampleReady(): { title: string } | undefined {
    return ready ? { title } : undefined;
}
