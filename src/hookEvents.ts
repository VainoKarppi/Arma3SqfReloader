/** Lifecycle events that can run commands. Kept free of VS Code imports so settings can use it. */
export interface HookDefinition {
    event: string;
    label: string;
    /** Whether the caller waits for the commands before continuing. */
    blocking: boolean;
    /** Whether a failing command cancels the action. */
    cancellable: boolean;
}

export const HOOK_EVENTS: HookDefinition[] = [
    { event: "preClientLaunch", label: "Before Arma 3 starts", blocking: true, cancellable: true },
    { event: "postClientLaunch", label: "After Arma 3 starts", blocking: false, cancellable: false },
    { event: "onClientConnected", label: "When Arma 3 connects to the API", blocking: false, cancellable: false },
    { event: "preClientStop", label: "Before Arma 3 is stopped", blocking: true, cancellable: true },
    { event: "postClientStop", label: "After Arma 3 is stopped", blocking: false, cancellable: false },
    { event: "onClientExit", label: "When Arma 3 exits", blocking: false, cancellable: false },

    { event: "preServerLaunch", label: "Before the dedicated server starts", blocking: true, cancellable: true },
    { event: "postServerLaunch", label: "After the dedicated server starts", blocking: false, cancellable: false },
    { event: "onServerConnected", label: "When the dedicated server connects to the API", blocking: false, cancellable: false },
    { event: "preServerStop", label: "Before the dedicated server is stopped", blocking: true, cancellable: true },
    { event: "postServerStop", label: "After the dedicated server is stopped", blocking: false, cancellable: false },
    { event: "onServerCrash", label: "When the dedicated server exits unexpectedly", blocking: false, cancellable: false },

    { event: "preReload", label: "Before a saved file is reloaded", blocking: true, cancellable: true },
    { event: "postReload", label: "After a file is reloaded", blocking: false, cancellable: false },
    { event: "onReloadError", label: "When a reload fails", blocking: false, cancellable: false },
    { event: "preReloadAll", label: "Before all functions are reloaded", blocking: true, cancellable: true },
    { event: "postReloadAll", label: "After all functions are reloaded", blocking: false, cancellable: false },
    { event: "postMissionRestart", label: "After mission functions are restarted", blocking: false, cancellable: false },

    { event: "preSetup", label: "Before project setup / junctions are created", blocking: true, cancellable: true },
    { event: "postSetup", label: "After project setup", blocking: false, cancellable: false },
    { event: "preJunction", label: "Before junctions are created", blocking: true, cancellable: true },
    { event: "postJunctionCleanup", label: "After junctions are removed", blocking: false, cancellable: false },
    { event: "postScaffold", label: "After the example project is created", blocking: false, cancellable: false },
    { event: "onModConfigChanged", label: "When a mod launch role changes", blocking: false, cancellable: false },
    { event: "onSettingsChanged", label: "When project settings are saved", blocking: false, cancellable: false },

    { event: "preMissionLink", label: "Before a mission is linked", blocking: true, cancellable: true },
    { event: "postMissionLink", label: "After a mission is linked", blocking: false, cancellable: false },
    { event: "preHostMission", label: "Before a mission is hosted", blocking: true, cancellable: true },
    { event: "postHostMission", label: "After a mission is hosted", blocking: false, cancellable: false }
];

export function hookDefinition(event: string): HookDefinition | undefined {
    return HOOK_EVENTS.find(definition => definition.event === event);
}
