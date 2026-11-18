// Verifies the `excludedFolders` project setting: a publish copy of the mod must disappear from
// discovery, from the duplicate-function check and from mission discovery.
// Run from the repository root:  node scripts/verify-excluded-folders.js
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
const { findAddonForFile, findMods, findMissions } = require(path.join(repoRoot, "out", "arma.js"));
const { deletedFunctionVariable, findDuplicateFunctionFiles } = require(path.join(repoRoot, "out", "reload.js"));
const { isExcludedPath } = require(path.join(repoRoot, "out", "excludedFolders.js"));
const { invalidateProjectSettings } = require(path.join(repoRoot, "out", "projectSettings.js"));

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-excluded-"));
const settingsFile = path.join(root, ".vscode", "sqfReloader-settings.json");

function writeFile(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
}

function writeSettings(excludedFolders) {
    writeFile(settingsFile, JSON.stringify({ enabled: true, excludedFolders }, null, 4));
    // The settings reader caches by mtime/size for a short while; a test must not wait for it.
    invalidateProjectSettings(settingsFile);
}

function writeMod(base) {
    writeFile(path.join(base, "mod.cpp"), 'name = "Example";\n');
    const addon = path.join(base, "addons", "core");
    writeFile(path.join(addon, "config.cpp"), 'class CfgFunctions { class mymod { tag = "mymod"; }; };\n');
    writeFile(path.join(addon, "functions", "fn_test.sqf"), "mymod_variable = 1;\n");
    return path.join(addon, "functions", "fn_test.sqf");
}

function writeMission(directory) {
    writeFile(path.join(directory, "description.ext"), "class Header { maxPlayers = 1; };\n");
}

vscode.workspace.workspaceFolders = [{ uri: { fsPath: root }, name: path.basename(root), index: 0 }];

try {
    const sourceFunction = writeMod(path.join(root, "@ExampleMod"));
    const publishFunction = writeMod(path.join(root, "Publish", "@ExampleMod"));
    writeMission(path.join(root, "missions", "Real.Altis"));
    writeMission(path.join(root, "Publish", "missions", "Copy.Altis"));

    console.log("No exclusions");
    writeSettings([]);
    check("both mod copies are discovered", findMods(root).length === 2, String(findMods(root).length));
    check("the publish copy is not excluded", !isExcludedPath(publishFunction));
    const duplicate = findDuplicateFunctionFiles(sourceFunction);
    check("the publish copy is reported as a duplicate definition", !!duplicate && duplicate.files.length === 2,
        duplicate ? duplicate.files.join(", ") : "no duplicate");
    check("both missions are discovered", findMissions([root]).length === 2);

    console.log("excludedFolders: [\"Publish\"]");
    writeSettings(["Publish"]);
    check("the publish copy is excluded", isExcludedPath(publishFunction));
    check("the publish copy is detected case-insensitively", isExcludedPath(path.join(root, "publish", "@ExampleMod", "mod.cpp")));
    check("the source mod is not excluded", !isExcludedPath(sourceFunction));
    check("only the source mod is discovered", findMods(root).length === 1, String(findMods(root).length));
    check("no duplicate function is reported", findDuplicateFunctionFiles(sourceFunction) === undefined);
    check("the source function still resolves to its variable", deletedFunctionVariable(sourceFunction) === "mymod_fnc_test");
    check("the excluded function resolves to nothing", deletedFunctionVariable(publishFunction) === undefined);
    check("the excluded file has no owning addon", findAddonForFile(publishFunction) === undefined);
    check("only the source mission is discovered", findMissions([root]).length === 1, String(findMissions([root]).length));

    console.log("excludedFolders: nested and absolute paths");
    writeSettings(["publish/@ExampleMod/"]);
    check("a nested relative path with separators and a trailing slash is excluded", isExcludedPath(publishFunction));
    check("a sibling mission folder is not excluded", !isExcludedPath(path.join(root, "missions", "Real.Altis", "description.ext")));

    writeSettings([path.join(root, "Publish")]);
    check("an absolute path is excluded", isExcludedPath(publishFunction));

    writeSettings(["missing-folder"]);
    check("an unknown folder excludes nothing", !isExcludedPath(publishFunction));
    check("the duplicate comes back once the exclusion is removed", !!findDuplicateFunctionFiles(sourceFunction));
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
}

console.log("\nAll excluded-folders checks passed.");
