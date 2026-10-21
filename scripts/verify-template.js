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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-template-"));const failures = [];

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
    check("files written", result.files.length === 12, `${result.files.length} files`);
    check("nothing skipped in an empty folder", result.skipped.length === 0, result.skipped.join(", "));
    check("mission written", !!result.missionDirectory && fs.existsSync(result.missionDirectory));
    check("MP mission written", !!result.mpMissionDirectory && fs.existsSync(result.mpMissionDirectory));
    check("no $PBOPREFIX$ in the template", !fs.existsSync(path.join(result.modDirectory, "addons", "example", "$PBOPREFIX$")));
    check("missions have a mission.sqm", fs.existsSync(path.join(result.missionDirectory, "mission.sqm")) && fs.existsSync(path.join(result.mpMissionDirectory, "mission.sqm")));

    // --- the extension has to see it as a mod -------------------------------
    const mods = findMods(sandbox);
    check("findMods() returns the example mod", mods.length === 1 && mods[0].name === TEMPLATE_MOD_NAME, mods.map(m => m.name).join(","));
    check("exampleMod() helper finds it", exampleMod(sandbox)?.name === TEMPLATE_MOD_NAME);

    const addon = mods[0]?.addons[0];
    check("one addon with the z\\example\\addons\\example prefix", addon?.prefix === "z\\example\\addons\\example", addon?.prefix);
    check("function tag is example", addon?.tag === "example", addon?.tag);

    // --- reloadability: file -> variable -> source path SqfReloader looks for ---
    const hello = path.join(result.modDirectory, "addons", "example", "functions", "fn_hello.sqf");
    check("fn_hello.sqf exists", fs.existsSync(hello));

    const addonForFile = findAddonForFile(hello);
    check("fn_hello.sqf belongs to the addon", addonForFile?.prefix === "z\\example\\addons\\example", addonForFile?.prefix);

    const variable = addonForFile ? toFunctionVariable(addonForFile, hello) : "";
    check("function variable is example_fnc_hello", variable === "example_fnc_hello", variable);

    const armaPath = addonForFile ? toArmaPath(addonForFile, hello) : "";
    // SqfReloader_fnc_reloadFunction resolves this to \z\example\addons\example\functions\fn_hello.sqf
    check(
        "Arma fileExists() path matches the reload candidate",
        armaPath === "z\\example\\addons\\example\\functions\\fn_hello.sqf",
        armaPath
    );

    const flatFunctions = fs.readdirSync(path.join(result.modDirectory, "addons", "example", "functions")).sort();
    check("functions live flat in functions/", flatFunctions.join(",") === "fn_add.sqf,fn_hello.sqf,fn_showCounter.sqf", flatFunctions.join(","));

    // --- CfgFunctions config + declared tag --------------------------------
    const config = fs.readFileSync(path.join(result.modDirectory, "addons", "example", "config.cpp"), "utf8");
    check("config.cpp declares the tag", /tag = "example";/.test(config));
    check("config.cpp uses the tag-relative function path", /file = "\\example\\functions";/.test(config));
    check("every function class exists in config.cpp", ["hello", "add", "showCounter"].every(name => new RegExp(`class ${name} \\{ recompile = 1; \\};`).test(config)));

    const settingsJson = fs.readFileSync(path.join(sandbox, ".vscode", "settings.json"), "utf8");
    check("workspace settings written", /"sqfReloader\.junctionMode": "addon"/.test(settingsJson));

    // --- second run must not overwrite work --------------------------------
    const before = fs.readFileSync(hello, "utf8");
    fs.writeFileSync(hello, `${before}\n// edited by the user\n`, "utf8");
    const second = writeTemplate(sandbox, true, false);
    check("second run skips existing files", second.skipped.length === 12, `${second.skipped.length} skipped`);
    check("user edits survive a second run", fs.readFileSync(hello, "utf8").includes("edited by the user"));

    // --- mod-only variant ---------------------------------------------------
    const modOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-template-modonly-"));
    const modOnly = writeTemplate(modOnlyRoot, false, false);
    check("mod-only variant writes no mission", !modOnly.missionDirectory && !modOnly.mpMissionDirectory && !fs.existsSync(path.join(modOnlyRoot, "missions")) && !fs.existsSync(path.join(modOnlyRoot, "mpmissions")));
    check("mod-only variant writes 6 files (no $PBOPREFIX$)", modOnly.files.length === 6, `${modOnly.files.length} files`);
    fs.rmSync(modOnlyRoot, { recursive: true, force: true });

    // --- extension .vscode/settings.json must be valid JSON ---------------
    // (comments are allowed by VS Code, so strip them before parsing)
    const jsonc = settingsJson
        .split(/\r?\n/)
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
    const parsed = JSON.parse(jsonc);
    check("generated settings.json parses", parsed["sqfReloader.junctionMode"] === "addon");
    check("generated settings.json has armaDirectory", typeof parsed["sqfReloader.armaDirectory"] === "string");
} finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
    console.log(`TEMPLATE VERIFY FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
}

console.log("TEMPLATE VERIFY PASSED");
