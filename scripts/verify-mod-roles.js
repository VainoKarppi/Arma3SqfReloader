// Verifies which workspace mods reach Arma (-mod= / -serverMod=) and how the launch command is
// echoed: a project that saves mod roles launches only folders it opted into, so a Publish copy of
// the mod is not mounted a second time, and the echo prints plain quoted paths instead of file URLs.
// Run from the repository root:  node scripts/verify-mod-roles.js
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
const { findMods } = require(path.join(repoRoot, "out", "arma.js"));
const { hasSavedModRoles, modLaunchesInArma } = require(path.join(repoRoot, "out", "modTypes.js"));
const { invalidateProjectSettings } = require(path.join(repoRoot, "out", "projectSettings.js"));
const { formatLaunchArgument } = require(path.join(repoRoot, "out", "launchArgs.js"));

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-modroles-"));
const settingsFile = path.join(root, ".vscode", "sqfReloader-settings.json");

function writeFile(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
}

function writeSettings(modTypes) {
    writeFile(settingsFile, JSON.stringify({ enabled: true, modTypes }, null, 4));
    // The settings reader caches by mtime/size for a short while; a test must not wait for it.
    invalidateProjectSettings(settingsFile);
}

function writeMod(base) {
    writeFile(path.join(base, "mod.cpp"), 'name = "Example";\n');
    writeFile(path.join(base, "addons", "core", "config.cpp"), 'class CfgFunctions { class mymod { tag = "mymod"; }; };\n');
}

const sourceMod = path.join(root, "@ExampleMod");
const publishMod = path.join(root, "Publish", "EdenOnline_v1.1.0");

vscode.workspace.workspaceFolders = [{ uri: { fsPath: root }, name: path.basename(root), index: 0 }];

try {
    writeMod(sourceMod);
    writeMod(publishMod);
    check("both copies are discovered", findMods(root).length === 2, String(findMods(root).length));

    console.log("No project settings");
    try { fs.rmSync(settingsFile, { force: true }); } catch { /* not written yet */ }
    invalidateProjectSettings(settingsFile);
    check("no saved roles", !hasSavedModRoles(sourceMod));
    check("an unclassified folder still launches as a client mod", modLaunchesInArma(sourceMod));
    check("the discovered copy launches too", modLaunchesInArma(publishMod));

    console.log('modTypes: { "@ExampleMod": "client" }');
    writeSettings({ "@ExampleMod": "client" });
    check("the project saves roles", hasSavedModRoles(sourceMod) && hasSavedModRoles(publishMod));
    check("the opted-in folder launches", modLaunchesInArma(sourceMod));
    check("the folder without a role does not launch", !modLaunchesInArma(publishMod));

    console.log('modTypes: { "@ExampleMod": "off" }');
    writeSettings({ "@ExampleMod": "off" });
    check("an explicit off role does not launch", !modLaunchesInArma(sourceMod));
    check("a folder without a role does not launch", !modLaunchesInArma(publishMod));

    console.log('modTypes: { "Publish/EdenOnline_v1.1.0": "server" }');
    writeSettings({ "Publish/EdenOnline_v1.1.0": "server" });
    check("a nested path is matched relative to the workspace", modLaunchesInArma(publishMod));
    check("the other folder stays out", !modLaunchesInArma(sourceMod));

    console.log('modTypes: {} on disk');
    writeSettings({});
    check("an empty modTypes keeps the unclassified default", !hasSavedModRoles(sourceMod) && modLaunchesInArma(sourceMod));

    console.log("Launch argument echo");
    const [modFirst, ...modPaths] = formatLaunchArgument(`"-mod=C:\\A\\@Mod;D:\\Steam\\@SqfReloader"`);
    check("-mod keeps its own line", modFirst === "-mod=", modFirst);
    check("paths are printed as plain quoted paths", JSON.stringify(modPaths) === JSON.stringify(['\t\t"C:\\A\\@Mod"', '\t\t"D:\\Steam\\@SqfReloader"']), JSON.stringify(modPaths));
    check("no file URL is printed", modPaths.every(line => !line.includes("file://")));
    const [, ...serverModPaths] = formatLaunchArgument(`"-serverMod=C:\\A\\@ServerMod"`);
    check("-serverMod paths are printed the same way", JSON.stringify(serverModPaths) === JSON.stringify(['\t\t"C:\\A\\@ServerMod"']), JSON.stringify(serverModPaths));
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
}

console.log("\nAll mod-role checks passed.");
