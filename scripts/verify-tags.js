// Checks the $PBOPREFIX$ -> function tag rule for the layouts the reloader must support.
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

const { readAddon } = require(path.join(repoRoot, "out", "arma.js"));

const cases = [
    // [prefix, expected tag, expected name]
    ["z\\mymod\\addons\\core", "mymod", "core"],
    ["x\\other\\addons\\main", "other", "main"],
    ["mymod\\addons\\core", "mymod", "core"],
    ["example\\addons\\example", "example", "example"],
    ["launchmod\\addons\\core", "launchmod", "core"]
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-tags-"));
let failed = 0;

try {
    for (const [prefix, tag, name] of cases) {
        const folder = path.join(dir, tag, name);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, "$PBOPREFIX$"), prefix, "utf8");

        const addon = readAddon(folder);
        const ok = addon && addon.tag === tag && addon.name === name;
        console.log(`  ${ok ? "PASS" : "FAIL"}  ${prefix} -> ${addon ? `${addon.tag}/${addon.name}` : "<none>"}`);
        failed += ok ? 0 : 1;
    }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
