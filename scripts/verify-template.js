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

const { writeTemplate, exampleMod, TEMPLATE_MOD_NAME } = require(path.join(repoRoot, "out", "scaffold.js"));
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

try {
    // --- first run: empty folder, mod + mission ------------------------------
    const result = writeTemplate(sandbox, true, false);
    check("mod folder created", result.modDirectory === path.join(sandbox, TEMPLATE_MOD_NAME), result.modDirectory);
    check("files written", result.files.length === 48, `${result.files.length} files`);
    check("nothing skipped in an empty folder", result.skipped.length === 0, result.skipped.join(", "));
    const generatedSettings = fs.readFileSync(path.join(sandbox, ".vscode", "sqfReloader-settings.json"), "utf8");
    check("server example mod is configured as server-only", /"server-example\/@ExampleServerMod"\s*:\s*"server"/.test(generatedSettings));
    check("generated project includes the one-second watcher default", /"watchInterval"\s*:\s*1000/.test(generatedSettings));
    check("generated project has no hooks by default", /"hooks"\s*:\s*\{\s*\}/.test(generatedSettings));
    check("generated project has the default hook presentation", /"reveal"\s*:\s*"always"/.test(generatedSettings) && /"panel"\s*:\s*"shared"/.test(generatedSettings));
    check("mission written", !!result.missionDirectory && fs.existsSync(result.missionDirectory));
    check("MP mission written", !!result.mpMissionDirectory && fs.existsSync(result.mpMissionDirectory));
    check("no $PBOPREFIX$ in the template", !fs.existsSync(path.join(result.modDirectory, "addons", "scripts", "$PBOPREFIX$")));
    check("missions have a mission.sqm", fs.existsSync(path.join(result.missionDirectory, "mission.sqm")) && fs.existsSync(path.join(result.mpMissionDirectory, "mission.sqm")));
    check("server example is created", !!result.serverExampleDirectory && fs.existsSync(path.join(result.serverExampleDirectory, "server.cfg")));
    check("server example includes mod and mission files", fs.existsSync(path.join(result.serverExampleDirectory, "@ExampleServerMod", "addons", "server", "config.cpp"))
        && fs.existsSync(path.join(result.serverExampleDirectory, "ExampleMission.Altis", "mission.sqm"))
        && fs.existsSync(path.join(result.serverExampleDirectory, "ExampleMission.Altis", "CfgRemoteExec.hpp"))
        && fs.existsSync(path.join(result.serverExampleDirectory, "ExampleMission.Altis", "init.sqf"))
        && fs.existsSync(path.join(result.serverExampleDirectory, "ExampleMission.Altis", "initServer.sqf"))
        && fs.existsSync(path.join(result.serverExampleDirectory, "ExampleMission.Altis", "initPlayerLocal.sqf")));
    const serverMission = path.join(result.serverExampleDirectory, "ExampleMission.Altis");
    const serverDescription = fs.readFileSync(path.join(serverMission, "description.ext"), "utf8");
    check("server mission defines CfgRemoteExec only once",
        serverDescription.includes('#include "CfgRemoteExec.hpp"')
        && (fs.readFileSync(path.join(serverMission, "CfgRemoteExec.hpp"), "utf8").match(/class\s+CfgRemoteExec\s*\{/g) ?? []).length === 1);
    check("server mission has init scripts", ["init.sqf", "initServer.sqf", "initPlayerLocal.sqf"].every(file => fs.existsSync(path.join(serverMission, file))));
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
        && /respawnTemplates\[\]\s*=\s*\{[^}]*ExampleRespawn/.test(mpDescription)
        && /onPlayerKilled\s*=\s*"OnPlayerKilled\.sqf"/.test(mpDescription)
        && /onPlayerRespawn\s*=\s*"OnPlayerRespawn\.sqf"/.test(mpDescription)
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
    check("every function class exists in config.cpp", ["hello", "add", "showCounter", "receiveReloadedFunction"].every(name => new RegExp(`class ${name} \\{\\}`).test(config)));

    const settingsJson = fs.readFileSync(path.join(sandbox, ".vscode", "sqfReloader-settings.json"), "utf8");
    check("project settings written", /"junctionMode": "addon"/.test(settingsJson));
    check("project settings include normal log verbosity", /"logLevel": "info"/.test(settingsJson));

    // --- second run must not overwrite work --------------------------------
    const before = fs.readFileSync(hello, "utf8");
    fs.writeFileSync(hello, `${before}\n// edited by the user\n`, "utf8");
    const settingsPath = path.join(sandbox, ".vscode", "sqfReloader-settings.json");
    fs.writeFileSync(settingsPath, "{\n    \"logLevel\": \"verbose\"\n}\n", "utf8");
    const second = writeTemplate(sandbox, true, false);
    check("second run skips existing files", second.skipped.length === 48, `${second.skipped.length} skipped`);
    check("user edits survive a second run", fs.readFileSync(hello, "utf8").includes("edited by the user"));
    check("second run keeps the project settings file", fs.readFileSync(settingsPath, "utf8").includes('"logLevel": "verbose"'));

    // --- mod-only variant ---------------------------------------------------
    const modOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-template-modonly-"));
    const modOnly = writeTemplate(modOnlyRoot, false, false);
    check("mod-only variant writes no mission", !modOnly.missionDirectory && !modOnly.mpMissionDirectory && !fs.existsSync(path.join(modOnlyRoot, "missions")) && !fs.existsSync(path.join(modOnlyRoot, "mpmissions")));
    check("mod-only variant still writes server example (no $PBOPREFIX$)", modOnly.files.length === 21, `${modOnly.files.length} files`);
    fs.rmSync(modOnlyRoot, { recursive: true, force: true });

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
} finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
    console.log(`TEMPLATE VERIFY FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
}

console.log("TEMPLATE VERIFY PASSED");
