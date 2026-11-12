// Verifies the guided tour state machine (src/tutorial.ts) and the project-settings cache
// (src/projectSettings.ts) without VS Code. Both back recent fixes: the cache removes the
// per-log-line file read, and the tour must only offer itself in an example workspace.
// Run from the repository root:  node scripts/verify-tutorial.js
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

const repoRoot = path.resolve(__dirname, "..");

const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "vscode") {
        return require.resolve("./vscode-stub.js");
    }

    return originalResolve.call(this, request, ...rest);
};

const vscode = require("./vscode-stub.js");
const tutorial = require(path.join(repoRoot, "out", "tutorial.js"));
const banner = require(path.join(repoRoot, "out", "exampleBanner.js"));
const projectSettings = require(path.join(repoRoot, "out", "projectSettings.js"));

let failures = 0;
function check(label, condition) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}`);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-tutorial-"));
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace }, name: path.basename(workspace), index: 0 }];

    try {
        // --- tutorial ------------------------------------------------------
        console.log("Tutorial state");
        const memento = new Map();
        tutorial.initTutorialStore({
            get: key => memento.get(key),
            update: async (key, value) => {
                if (value === undefined) memento.delete(key);
                else memento.set(key, value);
            }
        });

        check("a plain folder is not an example workspace", tutorial.readTutorial().sampleWorkspace === false);

        fs.mkdirSync(path.join(workspace, "ClientMod", "@ExampleMod"), { recursive: true });
        check("the scaffold layout is detected", tutorial.readTutorial().sampleWorkspace === true);
        check("no step is done before the tour starts", tutorial.tutorialSteps().every(step => !step.done));

        await tutorial.noteTutorialEvent("play");
        check("events are ignored while the tour is not running", tutorial.readTutorial().completed.play === undefined);

        // "Create example mod" writes the project settings, so that step is already done when the
        // tour is accepted right afterwards.
        await tutorial.completeTutorialStep("settings");
        check("the settings step is recorded before the tour starts", tutorial.readTutorial().completed.settings !== undefined);

        await tutorial.startTutorial();
        check("start marks the tour running", tutorial.readTutorial().started === true);
        check("the settings step shows as done in the first render",
            tutorial.tutorialSteps().find(step => step.id === "settings").done === true);
        check("still exactly one step is done", tutorial.tutorialSteps().filter(step => step.done).length === 1);

        await tutorial.noteTutorialEvent("play");
        check("a launch completes the play step", tutorial.readTutorial().completed.play !== undefined);
        check("steps() reports the play step done", tutorial.tutorialSteps().find(step => step.id === "play").done === true);

        const afterFirst = tutorial.readTutorial().completed.play;
        await tutorial.noteTutorialEvent("play");
        check("repeating an event keeps the first timestamp", tutorial.readTutorial().completed.play === afterFirst);

        await tutorial.setTutorialStep("eden", true);
        check("a manual step can be marked done", tutorial.readTutorial().completed.eden !== undefined);
        await tutorial.setTutorialStep("eden", false);
        check("a manual step can be unmarked", tutorial.readTutorial().completed.eden === undefined);
        await tutorial.setTutorialStep("not-a-step", true);
        check("unknown step ids are ignored", Object.keys(tutorial.readTutorial().completed).length === 2);

        await tutorial.dismissTutorial();
        const dismissed = tutorial.readTutorial();
        check("dismiss stops the tour but keeps progress",
            dismissed.started === false && dismissed.completed.play !== undefined && dismissed.completed.settings !== undefined);

        await tutorial.resetTutorial();
        const reset = tutorial.readTutorial();
        check("reset clears everything", reset.started === false && reset.dismissed === false && Object.keys(reset.completed).length === 0);

        // --- example-ready banner -------------------------------------------
    console.log("Example-ready banner");
    check("nothing is shown before the command runs", banner.exampleReady() === undefined);
    banner.markExampleReady("Example mod is ready");
    check("the banner carries its title", banner.exampleReady()?.title === "Example mod is ready");
    banner.markExampleReady();
    check("a second run without a folder keeps a generic title", banner.exampleReady()?.title === "Example files are ready");
    banner.clearExampleReady();
    check("dismissing hides it", banner.exampleReady() === undefined);

    // --- project settings cache ----------------------------------------
        console.log("Project settings cache");
        const settingsFile = path.join(workspace, ".vscode", "sqfReloader-settings.json");
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });

        fs.writeFileSync(settingsFile, '{"logLevel":"info"}', "utf8");
        const first = projectSettings.readProjectSettings();
        check("first read parses the file", first.logLevel === "info");

        // Same window: the cached object is reused, so an out-of-band edit is not seen yet.
        fs.writeFileSync(settingsFile, '{"logLevel":"warning","runTimeout":5}', "utf8");
        check("a read inside the stat window reuses the cached object", projectSettings.readProjectSettings().logLevel === "info");
        check("the cached object is shared, not copied", projectSettings.readProjectSettings() === first);

        projectSettings.invalidateProjectSettings(settingsFile);
        check("invalidating picks up the new content", projectSettings.readProjectSettings().logLevel === "warning");

        // mtime/size detection without an explicit invalidation (what an external editor relies on).
        fs.writeFileSync(settingsFile, '{"logLevel":"verbose"}', "utf8");
        await delay(300);
        check("a changed file is re-read after the stat window", projectSettings.readProjectSettings().logLevel === "verbose");

        // Writers must invalidate so the next read is never stale.
        await projectSettings.setProjectSetting("logLevel", "error");
        check("a write is visible to the next read", projectSettings.readProjectSettings().logLevel === "error");

        const cached = projectSettings.readProjectSettings();
        check("readProjectSettings returns a stable object while unchanged", projectSettings.readProjectSettings() === cached);

        // Writers clone, so a write must not mutate the shared cached object.
        await projectSettings.setProjectSetting("enabled", false);
        check("the write did not corrupt the cache entry", projectSettings.readProjectSettings().enabled === false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

main().then(() => {
    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.`);
        process.exit(1);
    }

    console.log("\nAll tutorial and settings-cache checks passed.");
}, error => {
    console.error(error);
    process.exit(1);
});
