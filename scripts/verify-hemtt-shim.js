// Verifies the HEMTT executable resolution that makes scoop/Chocolatey .cmd shims work
// (src/hemtt.ts -> resolveShim). Windows-only, no VS Code needed.
// Run from the repository root:  node scripts/verify-hemtt-shim.js
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

if (process.platform !== "win32") {
    console.log("HEMTT shim verification is Windows-only; skipped.");
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

const { resolveShim } = require(path.join(repoRoot, "out", "hemtt.js"));

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-shim-"));
const shimDir = path.join(root, "shim");
const exeDir = path.join(root, "exe");
fs.mkdirSync(shimDir, { recursive: true });
fs.mkdirSync(exeDir, { recursive: true });

const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;

try {
    console.log("HEMTT executable resolution");
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

    // 1. A bare name that only exists as a .cmd shim -> the shim path is returned.
    fs.writeFileSync(path.join(shimDir, "hemttshimonly.cmd"), "@echo off\r\n", "utf8");
    process.env.PATH = `${shimDir};${exeDir}`;
    check("a .cmd shim is detected", resolveShim("hemttshimonly") === path.join(shimDir, "hemttshimonly.cmd"),
        String(resolveShim("hemttshimonly")));

    // 2. A .bat shim behaves the same way.
    fs.writeFileSync(path.join(shimDir, "hemttbatshim.bat"), "@echo off\r\n", "utf8");
    check("a .bat shim is detected", resolveShim("hemttbatshim") === path.join(shimDir, "hemttbatshim.bat"));

    // 3. A real .exe must win over a shim that sits in the same folder (PATHEXT order).
    fs.writeFileSync(path.join(exeDir, "hemttboth.exe"), "", "utf8");
    fs.writeFileSync(path.join(exeDir, "hemttboth.cmd"), "@echo off\r\n", "utf8");
    process.env.PATH = exeDir;
    check("a real .exe wins over a shim in the same folder", resolveShim("hemttboth") === undefined,
        String(resolveShim("hemttboth")));

    // 3b. A shim earlier in PATH is what the OS would run, so it is returned.
    process.env.PATH = `${shimDir};${exeDir}`;
    fs.writeFileSync(path.join(shimDir, "hemttorder.cmd"), "@echo off\r\n", "utf8");
    fs.writeFileSync(path.join(exeDir, "hemttorder.exe"), "", "utf8");
    check("a shim earlier in PATH is used", resolveShim("hemttorder") === path.join(shimDir, "hemttorder.cmd"));

    // 4. An absolute .cmd path is accepted, a missing one is not.
    const absoluteShim = path.join(shimDir, "hemttshimonly.cmd");
    check("an absolute .cmd path is accepted", resolveShim(absoluteShim) === absoluteShim);
    check("a missing absolute path is ignored", resolveShim(path.join(shimDir, "nope.cmd")) === undefined);

    // 5. An absolute .exe is never treated as a shim.
    check("an absolute .exe is spawned directly", resolveShim(path.join(exeDir, "hemttboth.exe")) === undefined);

    // 6. A name that is not on PATH resolves to nothing (the caller then spawns it and fails loudly).
    check("an unknown command resolves to nothing", resolveShim("hemttdoesnotexist") === undefined);
} finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
}

console.log("\nAll HEMTT shim checks passed.");
