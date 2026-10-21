// Verifies the parts of the extension that need a live SqfReloader: addon detection, the Arma
// file path, and reloadDocument's HTTP calls (including the "not linked" diagnostics).
// Run from the repository root:  node scripts/verify-extension.js <modFolder> <armaFolder>
"use strict";

const path = require("path");
const fs = require("fs");

const repoRoot = path.resolve(__dirname, "..");

// arma.js imports the "vscode" module for a couple of dialogs; outside the extension host
// it is provided by this stub (only the functions used by this script are exercised).
const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "vscode") {
        return require.resolve("./vscode-stub.js");
    }

    return originalResolve.call(this, request, ...rest);
};

const { findModForFile, findAddonForFile, toArmaPath, toFunctionVariable } = require(path.join(repoRoot, "out", "arma.js"));
const { reloadDocument } = require(path.join(repoRoot, "out", "reload.js"));

const modFolder = path.resolve(process.argv[2] ?? "SqfReloaderExtension/dist/@SqfReloader");
const armaFolder = path.resolve(process.argv[3] ?? "C:/Users/vaino/AppData/Local/Temp/Arma3Test");
const file = path.join(modFolder, "addons", "core", "functions", "fn_hello.sqf");

function settings() {
    return {
        enabled: true,
        apiUrl: "http://127.0.0.1:8765/api",
        armaDirectory: armaFolder,
        requestTimeout: 3000,
        autoJunction: false,
        junctionMode: "addon",
        reloadOnSave: "reload",
        notifyOnError: false
    };
}

const failures = [];

function check(name, condition, detail) {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
    }
}

function fakeDocument(filePath) {
    return {
        uri: { scheme: "file", fsPath: filePath },
        fileName: filePath,
        languageId: "sqf",
        getText: () => fs.readFileSync(filePath, "utf8")
    };
}

(async () => {
    const mod = findModForFile(file);
    check("mod found for the saved file", !!mod, mod ? mod.name : "none");
    check("mod has one addon (core)", mod && mod.addons.length === 1, mod && mod.addons.map(a => a.prefix).join(","));

    const addon = findAddonForFile(file);
    check("addon found (z\\mymod\\addons\\core)", addon?.prefix === "z\\mymod\\addons\\core", addon?.prefix);

    const armaPath = addon ? toArmaPath(addon, file) : "";
    check("Arma path uses the PBO prefix", armaPath === "z\\mymod\\addons\\core\\functions\\fn_hello.sqf", armaPath);

    const variable = addon ? toFunctionVariable(addon, file) : "";
    check("function variable is mymod_fnc_hello", variable === "mymod_fnc_hello", variable);

    // Offline Arma first: the error has to be clear (and must not throw).
    const offline = await reloadDocument(fakeDocument(file), { ...settings(), apiUrl: "http://127.0.0.1:59999/api", requestTimeout: 700 });
    check("offline Arma produces a clear error", !offline.ok && /not listening|ECONNREFUSED|Timed out/i.test(offline.message), offline.message);

    // Linked: junction inside the Arma folder pointing at the working copy.
    const linkPath = path.join(armaFolder, "z", "mymod", "addons", "core");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });

    if (!fs.existsSync(linkPath)) {
        require("child_process").execFileSync("cmd", ["/c", "mklink", "/J", linkPath, path.join(modFolder, "addons", "core")], { stdio: "pipe" });
    }

    const linked = await reloadDocument(fakeDocument(file), settings());
    console.log(`        (linked) ${linked.message}`);
    check("reload succeeds once linked", linked.ok, linked.message);

    fs.writeFileSync(file, `diag_log "v${Date.now()}";\n`, "utf8");

    // config.cpp (not a fn_*) reloads everything instead of a single variable.
    const configFile = path.join(modFolder, "addons", "core", "config.cpp");
    const configResult = await reloadDocument(fakeDocument(configFile), settings());
    console.log(`        (config.cpp) ${configResult.message}`);

    console.log("");
    if (failures.length > 0) {
        console.log(`EXTENSION VERIFY FAILED (${failures.length}): ${failures.join(", ")}`);
        process.exit(1);
    }

    console.log("EXTENSION VERIFY PASSED");
})().catch(error => {
    console.error(error);
    process.exit(1);
});
