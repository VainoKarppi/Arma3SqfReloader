// Verifies that the game is started outside the extension host's process tree, so a VS Code
// window reload (which kills the extension host together with its children) does not close Arma.
//
// A stand-in "game" process is created through the production helper, then the process that
// created it is killed with the same kind of tree kill VS Code uses. The stand-in has to survive.
//
// Run from the repository root:  node scripts/verify-detached-launch.js
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

if (process.platform !== "win32") {
    console.log("Detached launch verification is Windows-only; skipped.");
    process.exit(0);
}

const repoRoot = path.resolve(__dirname, "..");

const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "vscode") {
        return require.resolve("./vscode-stub.js");
    }

    return originalResolve.call(this, request, ...rest);
};

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
}

function sleep(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-detached-"));

function waitForPid(pidFile, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const value = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
            if (Number.isInteger(value) && value > 0) return value;
        } catch {
            // Not written yet.
        }
        sleep(200);
    }
    return undefined;
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function treeKill(pid) {
    try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
        // Already gone.
    }
}

function parentProcessName(pid) {
    const parentPid = execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`
    ], { encoding: "utf8" }).trim();
    if (!parentPid) return "";

    return execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue).ProcessName`
    ], { encoding: "utf8" }).trim();
}

const fakeGame = path.join(root, "fake-game.js");
fs.writeFileSync(fakeGame, [
    "const fs = require('fs');",
    "fs.writeFileSync(process.argv[2], String(process.pid));",
    "setTimeout(() => {}, 120000);",
    ""
].join("\n"), "utf8");

// The stand-in for the VS Code window: it creates the game through the production helper.
const windowProcess = path.join(root, "window.js");
fs.writeFileSync(windowProcess, [
    "const path = require('path');",
    "const Module = require('module');",
    "const originalResolve = Module._resolveFilename;",
    "Module._resolveFilename = function (request, ...rest) {",
    "    if (request === 'vscode') return require.resolve(process.argv[5]);",
    "    return originalResolve.call(this, request, ...rest);",
    "};",
    `const launcher = require(path.join(${JSON.stringify(repoRoot)}, "out", "launcher.js"));`,
    "launcher.startProcessOutsideTree(process.execPath, [process.argv[2], process.argv[3]], process.argv[4]).then(",
    "    pid => { require('fs').writeFileSync(process.argv[6], String(pid || '')); process.exit(pid ? 0 : 1); },",
    "    () => process.exit(1)",
    ");",
    ""
].join("\n"), "utf8");

async function main() {
    const stub = path.join(__dirname, "vscode-stub.js");
    const gamePidFile = path.join(root, "game.pid");
    const reportedPidFile = path.join(root, "reported.pid");

    console.log("Game process creation");
    const window = spawn(process.execPath, [windowProcess, fakeGame, gamePidFile, root, stub, reportedPidFile], { stdio: "ignore" });

    const exitCode = await new Promise(resolve => window.once("exit", resolve));
    check("the helper reports success", exitCode === 0, `exit code ${exitCode}`);

    const reportedPid = Number.parseInt(fs.readFileSync(reportedPidFile, "utf8").trim(), 10) || undefined;
    const gamePid = waitForPid(gamePidFile);
    check("the game process was created and reported its PID", gamePid !== undefined, String(gamePid));
    check("the reported PID is the game process", reportedPid === gamePid, `${reportedPid} vs ${gamePid}`);

    if (gamePid !== undefined) {
        check("the game is running", isAlive(gamePid));

        console.log("Window reload");
        // What VS Code does to the extension host and everything it started.
        treeKill(window.pid);
        sleep(1500);

        check("the game survives the tree kill", isAlive(gamePid), `pid ${gamePid}`);

        const parentName = parentProcessName(gamePid);
        check("the game is not a child of the VS Code process", parentName.toLowerCase() !== "node", parentName || "unknown");

        treeKill(gamePid);
        sleep(800);
        check("the game can still be stopped by PID", !isAlive(gamePid));
    }

    console.log("Configured API port");
    // A reloaded window forgets the port picked at launch; the written config decides.
    const previousLocalAppData = process.env.LOCALAPPDATA;
    const localAppData = path.join(root, "localappdata");
    const configFile = path.join(localAppData, "SqfReloader", "config.json");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ host: "127.0.0.1", port: 8765 }), "utf8");
    process.env.LOCALAPPDATA = localAppData;
    try {
        const { adoptConfiguredApiPort } = require(path.join(repoRoot, "out", "runtime.js"));
        check("the port from the last launch is adopted", adoptConfiguredApiPort() === 8765, String(adoptConfiguredApiPort()));

        fs.writeFileSync(configFile, "{ not json", "utf8");
        check("an unreadable config is ignored", adoptConfiguredApiPort() === undefined);
        fs.rmSync(configFile, { force: true });
        check("a missing config is ignored", adoptConfiguredApiPort() === undefined);
    } finally {
        process.env.LOCALAPPDATA = previousLocalAppData;
    }
}

main().finally(() => {
    fs.rmSync(root, { recursive: true, force: true });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.`);
        process.exit(1);
    }

    console.log("\nAll detached-launch checks passed.");
});
