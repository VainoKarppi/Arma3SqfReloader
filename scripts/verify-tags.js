// Checks how the function tag and the mount prefix are derived.
//
// The tag comes from CfgFunctions (`tag = "...";`), and the mounted layout is always
// z\<tag>\addons\<addon folder>. A stale $PBOPREFIX$ does not influence either of them,
// because Play rewrites the file from CfgFunctions before launching.
//
// Run from the repository root:  node scripts/verify-tags.js
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

const { readAddon, readFunctionTag } = require(path.join(repoRoot, "out", "arma.js"));

/** [config.cpp body or null, addon folder name, expected tag, expected prefix] */
const cases = [
    ['class CfgFunctions { class example { tag = "example"; }; };', "example", "example", "z\\example\\addons\\example"],
    ['class CfgFunctions { class mymod { tag = "mymod"; }; };', "mymod", "mymod", "z\\mymod\\addons\\mymod"],
    ['class CfgFunctions { class Core { tag = "sre"; }; };', "instance", "sre", "z\\sre\\addons\\instance"],
    ['class CfgFunctions { class launch { }; };', "core", "launch", "z\\launch\\addons\\core"],
    ['class CfgFunctions { // tag = "commented";\n class real { tag = "real"; }; };', "real", "real", "z\\real\\addons\\real"],
    [null, "plain", "plain", "z\\plain\\addons\\plain"]
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-tags-"));
const failures = [];

try {
    let index = 0;

    for (const [config, folder, tag, prefix] of cases) {
        const addonDir = path.join(dir, `@Mod${index++}`, "addons", folder);
        fs.mkdirSync(addonDir, { recursive: true });

        if (config) {
            fs.writeFileSync(path.join(addonDir, "config.cpp"), config, "utf8");
        } else {
            fs.mkdirSync(path.join(addonDir, "functions"), { recursive: true });
        }

        // A stale or hand-made file must not change the result.
        fs.writeFileSync(path.join(addonDir, "$PBOPREFIX$"), "stale\\addons\\stale", "utf8");

        const addon = readAddon(addonDir);
        const ok = addon && addon.tag === tag && addon.prefix === prefix;
        console.log(`  ${ok ? "PASS" : "FAIL"}  ${folder} -> ${addon ? `${addon.tag} / ${addon.prefix}` : "<none>"}`);
        if (!ok) {
            failures.push(`${folder}: expected ${tag} / ${prefix}`);
        }
    }

    // The tag reader on its own: an explicit tag wins over the class name.
    const first = path.join(dir, "@Mod0", "addons", "example");
    const tag = readFunctionTag(first);
    const ok = tag === "example";
    console.log(`  ${ok ? "PASS" : "FAIL"}  readFunctionTag -> ${tag}`);
    if (!ok) {
        failures.push(`readFunctionTag -> ${tag}`);
    }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
    console.log(`TAG VERIFY FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
}

console.log("TAG VERIFY PASSED");
