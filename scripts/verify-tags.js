// Checks how the function tag and the mount prefix are derived.
//
// The tag comes from CfgFunctions (`tag = "...";`). The mounted layout is usually
// z\<tag>\addons\<addon folder>, but a config that already spells out its Arma path
// (`file = "z\eoex\addons\functions\extension"`) decides the prefix instead, so the declared
// path resolves in the game. A stale $PBOPREFIX$ influences neither of them, because Play
// rewrites the file from CfgFunctions before launching.
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

const { findAddonForFile, readAddon, readFunctionTag, toArmaPath, toFunctionVariable } = require(path.join(repoRoot, "out", "arma.js"));

/** [config.cpp body or null, addon folder name, expected tag, expected prefix, extra folders] */
const cases = [
    ['class CfgFunctions { class example { tag = "example"; }; };', "example", "example", "z\\example\\addons\\example"],
    ['class CfgFunctions { class mymod { tag = "mymod"; }; };', "mymod", "mymod", "z\\mymod\\addons\\mymod"],
    ['class CfgFunctions { class Core { tag = "sre"; }; };', "instance", "sre", "z\\sre\\addons\\instance"],
    ['class CfgFunctions { class launch { }; };', "core", "launch", "z\\launch\\addons\\core"],
    ['class CfgFunctions { // tag = "commented";\n class real { tag = "real"; }; };', "real", "real", "z\\real\\addons\\real"],
    [null, "plain", "plain", "z\\plain\\addons\\plain"],

    // A config that mounts itself: the declared z path wins, and the folder's own category
    // subfolder ("extension") is not part of the mount root.
    [
        'class CfgFunctions { class EdenOnline { tag = "EOEX"; class Functions_Extension { file = "z\\eoex\\addons\\functions\\extension"; class callExtension {}; }; }; };',
        "functions",
        "eoex",
        "z\\eoex\\addons\\functions",
        ["extension"]
    ],
    // Forward slashes, a leading separator and mixed case are normalized.
    [
        'class CfgFunctions { class Mod { tag = "MOD"; class C { file = "\\Z/Other/Addons/Core/functions"; }; }; };',
        "core",
        "mod",
        "z\\other\\addons\\core",
        ["functions"]
    ],
    // The declared path may already be the addon root itself.
    [
        'class CfgFunctions { class Mod { tag = "mod"; class C { file = "z\\mod\\addons\\core"; }; }; };',
        "core",
        "mod",
        "z\\mod\\addons\\core"
    ],
    // A relative path keeps the derived layout.
    [
        'class CfgFunctions { class Mod { tag = "mod"; class C { file = "functions"; }; }; };',
        "core",
        "mod",
        "z\\mod\\addons\\core",
        ["functions"]
    ]
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqfreloader-tags-"));
const failures = [];

try {
    let index = 0;

    for (const [config, folder, tag, prefix, extraFolders = []] of cases) {
        const addonDir = path.join(dir, `@Mod${index++}`, "addons", folder);
        fs.mkdirSync(addonDir, { recursive: true });

        for (const extra of extraFolders) {
            fs.mkdirSync(path.join(addonDir, extra), { recursive: true });
        }

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

    // End to end: a mod that mounts itself, like EdenOnline's z\eoex layout. Every configured
    // path has to be reproduced exactly, because that is where the game looks for the function.
    const edenAddon = path.join(dir, "@EdenOnline", "addons", "functions");
    const edenFiles = [
        "extension/fn_callExtension.sqf",
        "extension/fn_handleExtensionMessage.sqf",
        "extension/init/fn_init3DENEvents.sqf",
        "objects/helpers/fn_getId.sqf"
    ];
    fs.mkdirSync(edenAddon, { recursive: true });
    fs.writeFileSync(path.join(edenAddon, "config.cpp"), [
        "class CfgPatches { class Scripts { units[] = {}; weapons[] = {}; requiredAddons[] = {\"A3_Functions_F\", \"3DEN\"}; }; };",
        "class CfgFunctions {",
        "    class EdenOnline {",
        "        tag = \"EOEX\";",
        "        class Functions_Extension {",
        "            file = \"z\\eoex\\addons\\functions\\extension\";",
        "            class callExtension {};",
        "            class handleExtensionMessage {};",
        "        };",
        "        class Functions_Extension_Init {",
        "            file = \"z\\eoex\\addons\\functions\\extension\\init\";",
        "            class init3DENEvents {};",
        "        };",
        "        class Functions_Objects_Helpers {",
        "            file = \"z\\eoex\\addons\\functions\\objects\\helpers\";",
        "            class getId {};",
        "        };",
        "    };",
        "};"
    ].join("\n"), "utf8");

    for (const relative of edenFiles) {
        const file = path.join(edenAddon, ...relative.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "1;\n", "utf8");
    }

    const eden = readAddon(edenAddon);
    const edenOk = eden && eden.prefix === "z\\eoex\\addons\\functions";
    console.log(`  ${edenOk ? "PASS" : "FAIL"}  declared mount -> ${eden ? eden.prefix : "<none>"}`);
    if (!edenOk) {
        failures.push(`declared mount -> ${eden ? eden.prefix : "<none>"}`);
    }

    if (eden) {
        for (const relative of edenFiles) {
            const file = path.join(edenAddon, ...relative.split("/"));
            const armaPath = toArmaPath(eden, file);
            const expected = `z\\eoex\\addons\\functions\\${relative.split("/").join("\\")}`;
            const okPath = armaPath === expected;
            console.log(`  ${okPath ? "PASS" : "FAIL"}  ${relative} -> ${armaPath}`);
            if (!okPath) failures.push(`${relative}: expected ${expected}`);
        }

        const variable = toFunctionVariable(eden, path.join(edenAddon, "extension", "init", "fn_init3DENEvents.sqf"));
        const okVariable = variable === "eoex_fnc_init3DENEvents";
        console.log(`  ${okVariable ? "PASS" : "FAIL"}  function variable -> ${variable}`);
        if (!okVariable) failures.push(`function variable -> ${variable}`);

        const owner = findAddonForFile(path.join(edenAddon, "objects", "helpers", "fn_getId.sqf"));
        const okOwner = owner && owner.prefix === "z\\eoex\\addons\\functions";
        console.log(`  ${okOwner ? "PASS" : "FAIL"}  owning addon -> ${owner ? owner.prefix : "<none>"}`);
        if (!okOwner) failures.push("owning addon not resolved");
    }

    // One CfgFunctions at the mod root that names the addon folders: the folder has no config of
    // its own, so the root config decides both that it is an addon and where it is mounted.
    const rootMod = path.join(dir, "@RootConfig");
    const rootAddon = path.join(rootMod, "addons", "functions");
    fs.mkdirSync(path.join(rootAddon, "extension"), { recursive: true });
    fs.mkdirSync(path.join(rootAddon, "objects", "helpers"), { recursive: true });
    fs.writeFileSync(path.join(rootMod, "config.cpp"), [
        "class CfgFunctions {",
        "    class EdenOnline {",
        "        tag = \"EOEX\";",
        "        class Functions_Extension { file = \"z\\eoex\\addons\\functions\\extension\"; class callExtension {}; };",
        "        class Functions_Objects_Helpers { file = \"z\\eoex\\addons\\functions\\objects\\helpers\"; class getId {}; };",
        "    };",
        "};"
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(rootAddon, "extension", "fn_callExtension.sqf"), "1;\n", "utf8");
    fs.writeFileSync(path.join(rootAddon, "objects", "helpers", "fn_getId.sqf"), "1;\n", "utf8");

    const fromRoot = readAddon(rootAddon);
    const rootOk = fromRoot && fromRoot.prefix === "z\\eoex\\addons\\functions" && fromRoot.tag === "eoex";
    console.log(`  ${rootOk ? "PASS" : "FAIL"}  mod-root config -> ${fromRoot ? `${fromRoot.tag} / ${fromRoot.prefix}` : "<none>"}`);
    if (!rootOk) failures.push(`mod-root config -> ${fromRoot ? fromRoot.prefix : "<none>"}`);

    if (fromRoot) {
        const armaPath = toArmaPath(fromRoot, path.join(rootAddon, "extension", "fn_callExtension.sqf"));
        const pathOk = armaPath === "z\\eoex\\addons\\functions\\extension\\fn_callExtension.sqf";
        console.log(`  ${pathOk ? "PASS" : "FAIL"}  mod-root config path -> ${armaPath}`);
        if (!pathOk) failures.push(`mod-root config path -> ${armaPath}`);
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
