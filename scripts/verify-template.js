// Verifies "SqfReloader: Create example mod" without VS Code: writes the template into a temporary
// folder and checks that the extension can discover, link and reload the generated mod.
// Run from the repository root:  node scripts/verify-template.js
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

const repoRoot = path.resolve(__dirname, "..");

// arma.js / scaffold.js import "vscode" for dialogs; outside the extension host the stub is used.
const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "vscode") {
        return require.resolve("./vscode-stub.js");
    }

    return originalResolve.call(this, request, ...rest);
};

const { writeTemplate, exampleMod, TEMPLATE_MOD_NAME, ensureGitIgnore, ignoresHemttOutput, shouldOfferExample } = require(path.join(repoRoot, "out", "scaffold.js"));
const { findMods, findModForFile, findAddonForFile, toArmaPath, toFunctionVariable } = require(path.join(repoRoot, "out", "arma.js"));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-template-"));
const failures = [];

function check(name, condition, detail) {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
    }
}

function sameTemplateTree(source, destination, includeFile = () => true) {
    function listFiles(directory, relative = "") {
        return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
            const child = path.join(directory, entry.name);
            const childRelative = path.join(relative, entry.name);
            return entry.isDirectory() ? listFiles(child, childRelative) : [childRelative];
        }).sort();
    }

    const sourceFiles = listFiles(source).filter(includeFile);
    return sourceFiles.every(file => {
        const destinationFile = path.join(destination, file);
        return fs.existsSync(destinationFile)
            && fs.readFileSync(path.join(source, file), "utf8").replace(/\r\n/g, "\n")
                === fs.readFileSync(destinationFile, "utf8").replace(/\r\n/g, "\n");
    });
}

try {
    // --- first run: empty folder, client mod + server mod + missions ---------
    const result = writeTemplate(sandbox, true, false);
    const clientRoot = path.join(sandbox, "ClientMod");
    check("mod folder created below ClientMod", result.modDirectory === path.join(clientRoot, TEMPLATE_MOD_NAME), result.modDirectory);
    check("client example folder created", result.clientExampleDirectory === clientRoot, result.clientExampleDirectory);
    check("files written", result.files.length > 0, `${result.files.length} files`);
    check("nothing skipped in an empty folder", result.skipped.length === 0, result.skipped.join(", "));
    check("client mod copied from editable source",
        sameTemplateTree(
            path.join(repoRoot, "examples", "armaExamples", "client-example"),
            clientRoot,
            file => file.split(path.sep)[0] === "@ExampleMod"
                || file.split(path.sep)[0] === "missions"
                || file.split(path.sep)[0] === "mpmissions"
        ));
    check("project settings copied from the workspace template",
        fs.readFileSync(path.join(repoRoot, "examples", "armaExamples", "workspace-settings.json"), "utf8").replace(/\r\n/g, "\n")
        === fs.readFileSync(path.join(sandbox, ".vscode", "sqfReloader-settings.json"), "utf8").replace(/\r\n/g, "\n"));
    const generatedSettings = fs.readFileSync(path.join(sandbox, ".vscode", "sqfReloader-settings.json"), "utf8");
    check("client example mod is configured as client", /"ClientMod\/@ExampleMod"\s*:\s*"client"/.test(generatedSettings));
    check("server example mod is configured as server-only", /"ServerMod\/@ExampleServerMod"\s*:\s*"server"/.test(generatedSettings));
    check("generated project includes the one-second watcher default", /"watchInterval"\s*:\s*1000/.test(generatedSettings));
    check("generated project has no hooks by default", /"hooks"\s*:\s*\{\s*\}/.test(generatedSettings));
    check("generated project has the default hook presentation", /"reveal"\s*:\s*"always"/.test(generatedSettings) && /"panel"\s*:\s*"shared"/.test(generatedSettings));
    check("client example readme is copied", fs.existsSync(path.join(clientRoot, "README.md")));
    check("mission written", !!result.missionDirectory && fs.existsSync(result.missionDirectory));
    check("MP mission written", !!result.mpMissionDirectory && fs.existsSync(result.mpMissionDirectory));

    // HEMTT support: both example mods carry a project and the prefix file HEMTT requires.
    const clientPrefix = path.join(result.modDirectory, "addons", "scripts", "$PBOPREFIX$");
    const clientHemtt = path.join(result.modDirectory, ".hemtt", "project.toml");
    check("client example ships a .hemtt project", fs.existsSync(clientHemtt));
    check("client $PBOPREFIX$ matches the SqfReloader mount path",
        fs.readFileSync(clientPrefix, "utf8").trim() === "z\\example\\addons\\scripts",
        fs.readFileSync(clientPrefix, "utf8").trim());
    const serverPrefix = path.join(result.serverExampleDirectory, "@ExampleServerMod", "addons", "server", "$PBOPREFIX$");
    check("server example ships a .hemtt project",
        fs.existsSync(path.join(result.serverExampleDirectory, "@ExampleServerMod", ".hemtt", "project.toml")));
    check("server $PBOPREFIX$ matches the SqfReloader mount path",
        fs.readFileSync(serverPrefix, "utf8").trim() === "z\\Example\\addons\\server",
        fs.readFileSync(serverPrefix, "utf8").trim());
    check("missions have a mission.sqm", fs.existsSync(path.join(result.missionDirectory, "mission.sqm")) && fs.existsSync(path.join(result.mpMissionDirectory, "mission.sqm")));
    const generatedIgnore = fs.readFileSync(path.join(sandbox, ".gitignore"), "utf8");
    check("workspace .gitignore is created", /^\*\*\/\.hemttout\/$/m.test(generatedIgnore), JSON.stringify(generatedIgnore));
    check(".gitignore explains why the rule is there", /# HEMTT build output/.test(generatedIgnore));
    check("nested HEMTT projects are covered by the ignore rule", ignoresHemttOutput("**/.hemttout/"));
    check("single-player mission copied from editable source",
        sameTemplateTree(path.join(repoRoot, "examples", "armaExamples", "client-example", "missions"), path.join(clientRoot, "missions")));
    check("multiplayer mission copied from editable source",
        sameTemplateTree(path.join(repoRoot, "examples", "armaExamples", "client-example", "mpmissions"), path.join(clientRoot, "mpmissions")));
    check("server example is created", !!result.serverExampleDirectory && fs.existsSync(path.join(result.serverExampleDirectory, "server.cfg")));
    check("server example folder is ServerMod", result.serverExampleDirectory === path.join(sandbox, "ServerMod"), result.serverExampleDirectory);
    check("server example copied from editable source",
        sameTemplateTree(path.join(repoRoot, "examples", "armaExamples", "server-example"), result.serverExampleDirectory));
    check("server example includes mod and mission files", fs.existsSync(path.join(result.serverExampleDirectory, "@ExampleServerMod", "addons", "server", "config.cpp"))
        && fs.existsSync(path.join(result.serverExampleDirectory, "ExampleMission.Altis", "mission.sqm"))
        && fs.existsSync(path.join(result.serverExampleDirectory, "ExampleMission.Altis", "CfgRemoteExec.hpp")));
    const serverMission = path.join(result.serverExampleDirectory, "ExampleMission.Altis");
    const serverDescription = fs.readFileSync(path.join(serverMission, "description.ext"), "utf8");
    check("server mission defines CfgRemoteExec only once",
        serverDescription.includes('#include "CfgRemoteExec.hpp"')
        && (fs.readFileSync(path.join(serverMission, "CfgRemoteExec.hpp"), "utf8").match(/class\s+CfgRemoteExec\s*\{/g) ?? []).length === 1);
    check("server example readme is copied", fs.existsSync(path.join(result.serverExampleDirectory, "README.md")));
    const serverExampleMod = findMods(result.serverExampleDirectory).find(mod => mod.name === "@ExampleServerMod");
    check("server mod is independently discoverable", !!serverExampleMod && serverExampleMod.addons.length === 1);

    // The SP and MP scenarios are two distinct Eden files: both place a BLUFOR and an OPFOR
    // fire team, but only the MP one marks the OPFOR leader playable for the lobby.
    const spSqm = fs.readFileSync(path.join(result.missionDirectory, "mission.sqm"), "utf8");
    const mpSqm = fs.readFileSync(path.join(result.mpMissionDirectory, "mission.sqm"), "utf8");
    check("mission.sqm uses the Eden v54 format", /^version=54;/.test(spSqm) && /^version=54;/.test(spSqm));
    check("both scenarios place a BLUFOR and an OPFOR group", [spSqm, mpSqm].every(sqm => (sqm.match(/side="West"/g) ?? []).length === 5 && (sqm.match(/side="East"/g) ?? []).length === 5));
    check("SP scenario has no playable MP slot", !/isPlayable=1;/.test(spSqm));
    check("MP scenario marks the OPFOR leader playable", /isPlayable=1;/.test(mpSqm) && /property="speaker";/.test(mpSqm));
    check("mission CfgFunctions declares the live test", /class CfgFunctions[\s\S]*class liveTest/.test(fs.readFileSync(path.join(result.missionDirectory, "description.ext"), "utf8")));
    check("live test function exists in both missions", fs.existsSync(path.join(result.missionDirectory, "functions", "fn_liveTest.sqf")) && fs.existsSync(path.join(result.mpMissionDirectory, "functions", "fn_liveTest.sqf")));
    const spDescription = fs.readFileSync(path.join(result.missionDirectory, "description.ext"), "utf8");
    const mpDescription = fs.readFileSync(path.join(result.mpMissionDirectory, "description.ext"), "utf8");
    check("MP example mission has init scripts and remote init callback",
        ["init.sqf", "initServer.sqf", "initPlayerLocal.sqf", "initPlayerServer.sqf", "initRespawn.sqf", "OnPlayerKilled.sqf", "OnPlayerRespawn.sqf", "functions/fn_preInit.sqf", "functions/fn_postInit.sqf", "functions/fn_broadcastInitMessage.sqf", "functions/fn_receiveReloadedFunction.sqf"]
            .every(file => fs.existsSync(path.join(result.mpMissionDirectory, file)))
        && /CfgRemoteExec/.test(mpDescription)
        && (mpDescription.match(/#include\s+"CfgRemoteExec\.hpp"/g) ?? []).length === 1
        && (fs.readFileSync(path.join(result.mpMissionDirectory, "CfgRemoteExec.hpp"), "utf8").match(/class\s+CfgRemoteExec\s*\{/g) ?? []).length === 1
        && /respawn\s*=\s*3/.test(mpDescription)
        && /respawnOnStart\s*=\s*0/.test(mpDescription)
        && /respawnTemplates\[\]\s*=\s*\{[^}]*MenuPosition/.test(mpDescription)
        && /ExampleMission_fnc_broadcastInitMessage/.test(fs.readFileSync(path.join(result.mpMissionDirectory, "CfgRemoteExec.hpp"), "utf8")));
    check("MP scenario includes a BLUFOR respawn marker", /name\s*=\s*"respawn_west";/.test(mpSqm));
    check("SP example mission has separate initialization scripts",
        ["init.sqf", "initServer.sqf", "initPlayerLocal.sqf", "initPlayerServer.sqf", "initRespawn.sqf", "functions/fn_preInit.sqf", "functions/fn_postInit.sqf"]
            .every(file => fs.existsSync(path.join(result.missionDirectory, file)))
        && !/CfgRemoteExec/.test(spDescription));
    check("SP init scripts have single-player-specific behavior",
        fs.readFileSync(path.join(result.missionDirectory, "initPlayerLocal.sqf"), "utf8").includes("ExampleMission_fnc_liveTest")
        && !fs.readFileSync(path.join(result.missionDirectory, "initPlayerLocal.sqf"), "utf8").includes("remoteExec"));

    // --- the extension has to see it as a mod -------------------------------
    const mods = findMods(sandbox);
    check("findMods() returns both example mods", mods.length === 2 && mods.some(mod => mod.name === TEMPLATE_MOD_NAME) && mods.some(mod => mod.name === "@ExampleServerMod"), mods.map(m => m.name).join(","));
    check("exampleMod() helper finds it", exampleMod(sandbox)?.name === TEMPLATE_MOD_NAME);

    const addon = mods.find(mod => mod.name === TEMPLATE_MOD_NAME)?.addons[0];
    check("one scripts addon with the z\\example\\addons\\scripts prefix", addon?.prefix === "z\\example\\addons\\scripts", addon?.prefix);
    check("function tag is example", addon?.tag === "example", addon?.tag);

    // --- reloadability: file -> variable -> source path SqfReloader looks for ---
    const hello = path.join(result.modDirectory, "addons", "scripts", "functions", "fn_hello.sqf");
    check("fn_hello.sqf exists", fs.existsSync(hello));

    const addonForFile = findAddonForFile(hello);
    check("fn_hello.sqf belongs to the scripts addon", addonForFile?.prefix === "z\\example\\addons\\scripts", addonForFile?.prefix);

    const variable = addonForFile ? toFunctionVariable(addonForFile, hello) : "";
    check("function variable is example_fnc_hello", variable === "example_fnc_hello", variable);

    const armaPath = addonForFile ? toArmaPath(addonForFile, hello) : "";
    // SqfReloader_fnc_reloadFunction resolves this to \z\example\addons\scripts\functions\fn_hello.sqf
    check(
        "Arma fileExists() path matches the reload candidate",
        armaPath === "z\\example\\addons\\scripts\\functions\\fn_hello.sqf",
        armaPath
    );

    const flatFunctions = fs.readdirSync(path.join(result.modDirectory, "addons", "scripts", "functions")).sort();
    check("functions live flat in functions/", flatFunctions.join(",") === "fn_add.sqf,fn_hello.sqf,fn_showCounter.sqf", flatFunctions.join(","));

    // --- CfgFunctions config + declared tag --------------------------------
    const config = fs.readFileSync(path.join(result.modDirectory, "addons", "scripts", "config.cpp"), "utf8");
    check("config.cpp declares the tag", /tag = "example";/.test(config));
    check("config.cpp uses the tag-relative function path", /file = "\\example\\functions";/.test(config));
    check("every function class exists in config.cpp", ["hello", "add", "showCounter"].every(name => new RegExp(`class ${name} \\{\\}`).test(config)));

    const settingsJson = fs.readFileSync(path.join(sandbox, ".vscode", "sqfReloader-settings.json"), "utf8");
    check("project settings written", /"junctionMode": "addon"/.test(settingsJson));
    check("project settings include normal log verbosity", /"logLevel": "info"/.test(settingsJson));

    // --- second run must not overwrite work --------------------------------
    const before = fs.readFileSync(hello, "utf8");
    fs.writeFileSync(hello, `${before}\n// edited by the user\n`, "utf8");
    const settingsPath = path.join(sandbox, ".vscode", "sqfReloader-settings.json");
    fs.writeFileSync(settingsPath, "{\n    \"logLevel\": \"verbose\"\n}\n", "utf8");
    const second = writeTemplate(sandbox, true, false);
    check("second run skips existing files", second.skipped.length === result.files.length, `${second.skipped.length} skipped`);
    check("user edits survive a second run", fs.readFileSync(hello, "utf8").includes("edited by the user"));
    check("second run keeps the project settings file", fs.readFileSync(settingsPath, "utf8").includes('"logLevel": "verbose"'));
    writeTemplate(sandbox, true, true);
    check("force recreate keeps customized project settings",
        fs.readFileSync(settingsPath, "utf8").includes('"logLevel": "verbose"'));

    // --- mod-only variant ---------------------------------------------------
    const modOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-template-modonly-"));
    const modOnly = writeTemplate(modOnlyRoot, false, false);
    check("mod-only variant writes no mission", !modOnly.missionDirectory && !modOnly.mpMissionDirectory && !fs.existsSync(path.join(modOnlyRoot, "ClientMod", "missions")) && !fs.existsSync(path.join(modOnlyRoot, "ClientMod", "mpmissions")));
    check("mod-only variant copies only the client mod",
        sameTemplateTree(
            path.join(repoRoot, "examples", "armaExamples", "client-example"),
            path.join(modOnlyRoot, "ClientMod"),
            file => file.split(path.sep)[0] === "@ExampleMod"
        ));
    check("mod-only variant still writes server example (no $PBOPREFIX$)",
        fs.existsSync(path.join(modOnly.serverExampleDirectory, "server.cfg"))
        && fs.existsSync(path.join(modOnly.modDirectory, "mod.cpp")));
    fs.rmSync(modOnlyRoot, { recursive: true, force: true });

    // --- .gitignore handling ------------------------------------------------
    const ignorePath = path.join(sandbox, ".gitignore");
    const ignoreAfterSecondRun = fs.readFileSync(ignorePath, "utf8");
    check(".gitignore rule is not duplicated by a second run",
        (ignoreAfterSecondRun.match(/^\*\*\/\.hemttout\/$/gm) ?? []).length === 1, JSON.stringify(ignoreAfterSecondRun));

    const ignoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-ignore-"));
    fs.writeFileSync(path.join(ignoreRoot, ".gitignore"), "node_modules/\n*.log\n", "utf8");
    const appended = ensureGitIgnore(ignoreRoot);
    const appendedText = fs.readFileSync(path.join(ignoreRoot, ".gitignore"), "utf8");
    check("existing .gitignore keeps its rules", appendedText.includes("node_modules/") && appendedText.includes("*.log"));
    check("existing .gitignore gets the HEMTT rule appended", appended.updated && /\*\*\/\.hemttout\/$/m.test(appendedText), JSON.stringify(appendedText));
    check("a second ensureGitIgnore() call changes nothing", !ensureGitIgnore(ignoreRoot).updated);

    fs.writeFileSync(path.join(ignoreRoot, ".gitignore"), "node_modules/\n.hemttout/\n", "utf8");
    check("an equivalent existing rule is not duplicated", !ensureGitIgnore(ignoreRoot).updated);
    fs.writeFileSync(path.join(ignoreRoot, ".gitignore"), "", "utf8");
    check("an empty .gitignore is filled in", ensureGitIgnore(ignoreRoot).updated);
    fs.rmSync(ignoreRoot, { recursive: true, force: true });

    // --- .vscode/sqfReloader-settings.json must be valid JSON -------------
    // (whole-line comments are allowed in the template, so strip them before parsing)
    const jsonc = settingsJson
        .split(/\r?\n/)
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
    const parsed = JSON.parse(jsonc);
    check("generated project settings parse", parsed.junctionMode === "addon");
    check("generated project settings log verbosity defaults to info", parsed.logLevel === "info");
    check("generated project settings omit armaDirectory (auto-detected, never written)", !("armaDirectory" in parsed));
    check("generated project settings have one shared API port", parsed.apiPort > 0 && !("serverApiPort" in parsed));
    check("generated project settings have no watch target (always the local game)", !("watchTarget" in parsed));

    // --- the "create the example mod?" offer -----------------------------
    const base = { hasWorkspace: true, emptyWorkspace: true, exampleExists: false, declined: false, asked: false };
    check("an empty workspace offers the example mod", shouldOfferExample(base));
    check("a second window in the same folder is not asked again", !shouldOfferExample({ ...base, asked: true }));
    check("a folder with files is not offered the example", !shouldOfferExample({ ...base, emptyWorkspace: false }));
    check("a folder that already has the example mod is not offered", !shouldOfferExample({ ...base, exampleExists: true }));
    check("Don't ask again suppresses it everywhere", !shouldOfferExample({ ...base, declined: true }));
    check("no workspace folder means no offer", !shouldOfferExample({ ...base, hasWorkspace: false }));
} finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
}

// --- "Create example mod" must leave the editor on the ClientMod README preview ----
async function checkReveal() {
    const vscode = require(path.join(__dirname, "vscode-stub.js"));
    const revealRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-reveal-"));
    vscode.calls.showTextDocument.length = 0;
    vscode.calls.executeCommand.length = 0;

    try {
        const { scaffoldExample } = require(path.join(repoRoot, "out", "scaffold.js"));
        await scaffoldExample({ target: revealRoot });

        const previews = vscode.calls.executeCommand.filter(call => call.command === "markdown.showPreview");
        check("create example opens the ClientMod README preview once", previews.length === 1, `${previews.length}`);
        check("the preview targets ClientMod/README.md",
            previews.length === 1 && previews[0].args[0].fsPath === path.join(revealRoot, "ClientMod", "README.md"),
            previews.length === 1 ? previews[0].args[0].fsPath : "no preview");
        check("create example opens no other editor tabs",
            vscode.calls.showTextDocument.length === 0
            && vscode.calls.executeCommand.length === 1,
            vscode.calls.executeCommand.map(call => call.command).join(", "));
    } finally {
        fs.rmSync(revealRoot, { recursive: true, force: true });
    }

    console.log("");
    if (failures.length > 0) {
        console.log(`TEMPLATE VERIFY FAILED (${failures.length}): ${failures.join(", ")}`);
        process.exit(1);
    }

    console.log("TEMPLATE VERIFY PASSED");
}

checkReveal().catch(error => {
    console.error(error);
    process.exit(1);
});
