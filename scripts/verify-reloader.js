// Checks the file-patching setup that keeps ArmaApi's PBO-installed SQF hot reloadable:
// the generated replacement config, the reloader scripts and the copied fn_*.sqf sources.
// Run from the repository root:  node scripts/verify-reloader.js
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "vscode") {
        return require.resolve("./vscode-stub.js");
    }

    return originalResolve.call(this, request, ...rest);
};

const { writeReplacement, parseFunctionGroups, REPLACEMENT_DIRECTORY } = require(path.join(repoRoot, "out", "reloader.js"));

const failures = [];

function check(name, condition, detail) {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
    }
}

const sources = path.join(repoRoot, "ArmaApiExtension", "addons", "armaapi");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "armaapi-reloader-"));
const modDirectory = path.join(sandbox, "@ArmaApi");

try {
    const config = fs.readFileSync(path.join(sources, "config.cpp"), "utf8");
    const groups = parseFunctionGroups(config);

    check("CfgFunctions classes parsed", groups.length === 4, groups.map(group => group.name).join(","));
    check("tag is ArmaApi", groups.every(group => group.tag === "ArmaApi"), groups.map(group => group.tag).join(","));

    const core = groups.find(group => group.name === "Core");
    check("Core lists its functions", !!core && core.functions.some(entry => entry.name === "apiStart" && entry.file === "functions/extension/fn_apiStart.sqf"), JSON.stringify(core && core.functions[0]));
    check("init functions are skipped", groups.every(group => group.functions.every(entry => entry.name !== "init")));

    // The real sources have config.cpp next to functions\, so copy them like build-all.ps1 does.
    const sourceCopy = path.join(sandbox, "armaapi-src");
    fs.mkdirSync(sourceCopy, { recursive: true });
    fs.cpSync(path.join(sources, "functions"), path.join(sourceCopy, "functions"), { recursive: true });
    fs.copyFileSync(path.join(sources, "config.cpp"), path.join(sourceCopy, "config.cpp"));
    fs.copyFileSync(path.join(sources, "$PBOPREFIX$"), path.join(sourceCopy, "$PBOPREFIX$"));

    const plan = writeReplacement({ modDirectory, prefix: "z\\armaapi\\addons\\armaapi", sourcesDirectory: sourceCopy });
    check("replacement plan written", !!plan && plan.groups.length === 4);

    const replacement = path.join(modDirectory, REPLACEMENT_DIRECTORY, "armaapi");
    const patchedConfig = fs.readFileSync(path.join(replacement, "config.cpp"), "utf8");

    check("replacement config declares allowFunctionsRecompile", /allowFunctionsRecompile\s*=\s*1;/.test(patchedConfig));
    check("replacement config keeps one CfgFunctions block", (patchedConfig.match(/class CfgFunctions/g) ?? []).length === 1);
    check("replacement config declares each tag once", (patchedConfig.match(/class ArmaApi\s*\{/g) ?? []).length === 1, `${(patchedConfig.match(/class ArmaApi\s*\{/g) ?? []).length} wrappers`);
    check("replacement config does not redefine the classes' file", !/\bfile\s*=/.test(patchedConfig));
    check("replacement config points at the reloader", patchedConfig.includes('reloader = "\\z\\armaapi\\addons\\armaapi\\functions\\extension\\reloader.sqf";'));
    check("every class got a reloader", (patchedConfig.match(/reloader\s*=/g) ?? []).length === 4, `${(patchedConfig.match(/reloader\s*=/g) ?? []).length} reloader entries`);

    const extensionReloader = path.join(replacement, "functions", "extension", "reloader.sqf");
    check("extension reloader.sqf created", fs.existsSync(extensionReloader));

    const reloaderText = fs.readFileSync(extensionReloader, "utf8");
    check("reloader compiles apiStart", reloaderText.includes('ArmaApi_fnc_apiStart = compile preprocessFileLineNumbers "\\z\\armaapi\\addons\\armaapi\\functions\\extension\\fn_apiStart.sqf";'));
    check("reloader skips functions without recompile = 1", !reloaderText.includes("ArmaApi_fnc_runStartup"));

    const recompilable = groups.reduce((sum, group) => sum + group.functions.filter(entry => entry.recompile).length, 0);
    const compiled = (reloaderText.match(/= compile preprocessFileLineNumbers/g) ?? []).length;
    check("reloader compiles every recompile = 1 function of Core", compiled === groups.find(group => group.name === "Core").functions.filter(entry => entry.recompile).length, `${compiled}`);

    for (const group of groups) {
        check(`reloader script for ${group.name} exists`, fs.existsSync(path.join(replacement, ...group.file.replace(/\\/g, "/").split("/"), "reloader.sqf")));
    }

    check("recompile flag parsed from config", groups.every(group => group.functions.some(entry => entry.recompile)), `${recompilable} flagged function(s)`);

    check("fn_*.sqf sources copied for editing", fs.existsSync(path.join(replacement, "functions", "extension", "fn_apiStart.sqf")));

    const second = writeReplacement({ modDirectory, prefix: "z\\armaapi\\addons\\armaapi", sourcesDirectory: sourceCopy });
    check("second run is a no-op", second && second.unchanged === true);

    // A changed SQF file must be picked up on the next launch.
    fs.appendFileSync(path.join(sourceCopy, "functions", "extension", "fn_apiStart.sqf"), "\n// edited\n");
    const third = writeReplacement({ modDirectory, prefix: "z\\armaapi\\addons\\armaapi", sourcesDirectory: sourceCopy });
    check("edited sources are re-copied", third && third.unchanged === false);
    check("edited content reached the replacement", fs.readFileSync(path.join(replacement, "functions", "extension", "fn_apiStart.sqf"), "utf8").includes("// edited"));
} finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
    console.log(`RELOADER VERIFY FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
}

console.log("RELOADER VERIFY PASSED");
