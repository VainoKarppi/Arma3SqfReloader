import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./settings";

/**
 * Guided tour for workspaces created by "SqfReloader: Create example mod".
 *
 * Progress lives in `workspaceState`, so it is per workspace and survives restarts without
 * adding another file to the project. Steps are completed either by the extension (a successful
 * launch, a reload, the debug console) or by the user through the "Mark done" checkbox.
 */

export type TutorialStepId = "settings" | "play" | "eden" | "edit" | "reload" | "console" | "docs";

export interface TutorialStepDefinition {
    id: TutorialStepId;
    title: string;
    detail: string;
    /** Heading in the example project's README that explains this step. */
    docHeading?: string;
    /** Completed by the extension instead of by the user. */
    automatic: boolean;
}

export const TUTORIAL_STEPS: TutorialStepDefinition[] = [
    {
        id: "settings",
        title: "Create the project settings",
        detail: "The tour works with .vscode/sqfReloader-settings.json, which stores launch options, mod roles and watches.",
        docHeading: "Try live reload as a client",
        automatic: true
    },
    {
        id: "play",
        title: "Click Play Arma 3",
        detail: "Starts Arma 3 with the example mod, the missions and the SqfReloader API.",
        docHeading: "Try live reload as a client",
        automatic: true
    },
    {
        id: "eden",
        title: "Open the example mission",
        detail: "Run the mission or open it in the Eden Editor so the mod's functions are compiled.",
        docHeading: "Close Arma and open the mission in Eden",
        automatic: false
    },
    {
        id: "edit",
        title: "Edit an SQF function",
        detail: "Open ClientMod/@ExampleMod/addons/scripts/functions/fn_hello.sqf and change the hint text.",
        docHeading: "Try live reload as a client",
        automatic: true
    },
    {
        id: "reload",
        title: "Save and see the reload",
        detail: "Saving the file recompiles the function in the running game, without restarting the mission.",
        docHeading: "Try live reload as a client",
        automatic: true
    },
    {
        id: "console",
        title: "Run code in the Debug Console",
        detail: "Open the Debug Console from the Arma Project view and evaluate an SQF expression.",
        docHeading: "Try live reload as a client",
        automatic: true
    },
    {
        id: "docs",
        title: "Hover a function name or jump to it",
        detail: "Ctrl+click a TAG_fnc_name to open its definition; hover it to read the function header.",
        docHeading: "Jump from a call to its function",
        automatic: false
    }
];

export interface TutorialProgress {
    /** The user asked to start the tour (the sidebar section is visible while true). */
    started: boolean;
    /** The offer was declined; it is not shown again for this workspace. */
    dismissed: boolean;
    /** Step id -> ISO timestamp of completion. */
    completed: Record<string, string>;
    /** This workspace was created by "SqfReloader: Create example mod". */
    sampleWorkspace: boolean;
}

/** What is persisted; `sampleWorkspace` is derived on read. */
type StoredTutorial = Pick<TutorialProgress, "started" | "dismissed" | "completed">;

const STATE_KEY = "sqfReloader.tutorial";

/** Set once the scaffold has run so the offer is not tied to the file layout afterwards. */
const SAMPLE_KEY = "sqfReloader.tutorial.sampleWorkspace";

let store: vscode.Memento | undefined;

export function initTutorialStore(memento: vscode.Memento): void {
    store = memento;
}

export function readTutorial(): TutorialProgress {
    const raw = store?.get<Partial<TutorialProgress>>(STATE_KEY) ?? {};
    return {
        started: raw.started === true,
        dismissed: raw.dismissed === true,
        completed: raw.completed && typeof raw.completed === "object" ? { ...raw.completed } : {},
        sampleWorkspace: store?.get<boolean>(SAMPLE_KEY) === true || looksLikeExampleWorkspace()
    };
}

async function writeTutorial(progress: TutorialProgress): Promise<void> {
    if (!store) return;
    await store.update(STATE_KEY, {
        started: progress.started,
        dismissed: progress.dismissed,
        completed: progress.completed
    } satisfies StoredTutorial);
}

/** A workspace that still has the scaffold layout counts as an example workspace too. */
function looksLikeExampleWorkspace(): boolean {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return false;
    return fs.existsSync(path.join(root.uri.fsPath, "ClientMod", "@ExampleMod"));
}

export async function markExampleWorkspace(): Promise<void> {
    await store?.update(SAMPLE_KEY, true);
}

export async function startTutorial(): Promise<void> {
    const progress = readTutorial();
    progress.started = true;
    progress.dismissed = false;
    await writeTutorial(progress);
}

export async function dismissTutorial(): Promise<void> {
    const progress = readTutorial();
    progress.started = false;
    progress.dismissed = true;
    await writeTutorial(progress);
}

export async function resetTutorial(): Promise<void> {
    await store?.update(STATE_KEY, undefined);
}

/** Marks one step done; a manual "unmark" is supported by passing `done: false`. */
export async function setTutorialStep(stepId: string, done = true): Promise<TutorialProgress> {
    const progress = readTutorial();
    if (!TUTORIAL_STEPS.some(step => step.id === stepId)) return progress;

    if (done) {
        progress.completed[stepId] ??= new Date().toISOString();
    } else {
        delete progress.completed[stepId];
    }

    await writeTutorial(progress);
    return progress;
}

/** Called by the extension when something observable happened; no-op when the tour is not running. */
export async function noteTutorialEvent(stepId: TutorialStepId): Promise<void> {
    const progress = readTutorial();
    if (!progress.started || progress.completed[stepId]) return;
    await setTutorialStep(stepId, true);
    log(`Tutorial step completed: ${stepId}.`);
}

/**
 * Marks a step done even before the tour is started.
 *
 * The example scaffold already creates `.vscode/sqfReloader-settings.json`, so the "Create the
 * project settings" step has to be ticked when the user accepts the tour right after creating
 * the example mod.
 */
export async function completeTutorialStep(stepId: TutorialStepId): Promise<void> {
    if (readTutorial().completed[stepId]) return;
    await setTutorialStep(stepId, true);
}

export interface TutorialStepView extends TutorialStepDefinition {
    done: boolean;
    /** Absolute path of the README section for this step, when one exists. */
    docPath?: string;
}

export function tutorialSteps(): TutorialStepView[] {
    const progress = readTutorial();
    // One lookup for the whole list: refresh() runs every 2 s while the view is open.
    const docPath = readmeForStep();
    return TUTORIAL_STEPS.map(step => ({
        ...step,
        done: progress.completed[step.id] !== undefined,
        docPath: step.docHeading ? docPath : undefined
    }));
}

/** The example project's README, which the scaffold copies into the workspace. */
export function readmeForStep(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return undefined;
    for (const candidate of [
        path.join(root.uri.fsPath, "ClientMod", "README.md"),
        path.join(root.uri.fsPath, "ServerMod", "README.md"),
        path.join(root.uri.fsPath, "README.md")
    ]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

/** Opens the README at the heading that explains one step. */
export async function openTutorialDoc(stepId: string): Promise<void> {
    const step = TUTORIAL_STEPS.find(item => item.id === stepId);
    const file = readmeForStep();
    if (!step?.docHeading || !file) {
        void vscode.window.showInformationMessage(step?.detail ?? "No documentation for this step.");
        return;
    }

    const document = await vscode.workspace.openTextDocument(file);
    const line = document.getText().split(/\r?\n/)
        .findIndex(text => text.trim().toLowerCase() === `## ${step.docHeading}`.toLowerCase());
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    if (line >= 0) {
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
    }
}
