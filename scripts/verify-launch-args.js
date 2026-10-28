// End-to-end check of "SqfReloader: Play" for a real workspace, without starting Arma and without
// VS Code: applies the workspace settings, deploys the runtime, links the mod, then prints the
// command line Arma would get.
//   node scripts/verify-launch-args.js --workspace "C:\path\to\mod" [--arma "E:\...\Arma 3"]
"use strict";

const path = require("path");
const fs = require("fs");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "vscode") {
        return require.resolve("./vscode-stub.js");
    }

    return originalResolve.call(this, request, ...rest);
};

const { readSettings } = require(path.join(repoRoot, "out", "settings.js"));
const { launchArguments } = require(path.join(repoRoot, "out", "launcher.js"));
const { prepareRuntime, bundledModFolder } = require(path.join(repoRoot, "out", "runtime.js"));
const { findMods, findMissions } = require(path.join(repoRoot, "out", "arma.js"));
const { readLinkTarget, addonLinkPath } = require(path.join(repoRoot, "out", "junctions.js"));

/** Reads sqfReloader.* from <workspace>/.vscode/settings.json (JSONC, comments stripped). */
function workspaceSettings(workspace) {
    const file = path.join(workspace, ".vscode", "settings.json");

    if (!fs.existsSync(file)) {
        return {};
    }

    const text = fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(line => !line.trim().startsWith("//"))
        .join("\n")
        .replace(/,\s*([}\]])/g, "$1");

    const result = {};

    for (const [key, value] of Object.entries(JSON.parse(text))) {
        if (key.startsWith("sqfReloader.")) {
            result[key.slice("sqfReloader.".length)] = value;
        }
    }

    return result;
}

// --- arguments --------------------------------------------------------------
const argv = process.argv.slice(2);
let workspace;
let armaDirectory = "E:/SteamLibrary/steamapps/common/Arma 3";

for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace") {
        workspace = path.resolve(argv[++i]);
    } else if (argv[i] === "--arma") {
        armaDirectory = path.resolve(argv[++i]);
    } else if (!workspace) {
        workspace = path.resolve(argv[i]);
    }
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

function resolvedPath(file) {
    const target = readLinkTarget(file);

    if (target) {
        return path.resolve(target).toLowerCase();
    }

    try {
        return fs.realpathSync.native(file).toLowerCase();
    } catch {
        return "";
    }
}


if (!fs.existsSync(path.join(armaDirectory, "arma3_x64.exe"))) {
    console.log(`SKIP: ${armaDirectory} does not contain arma3_x64.exe`);
    process.exit(0);
}

const settings = { ...readSettings(), ...(workspace ? workspaceSettings(workspace) : {}) };
const mods = workspace ? findMods(workspace) : [];

console.log(`Workspace: ${workspace ?? "<none>"}`);
console.log(`Arma 3   : ${armaDirectory}`);
console.log(`Settings : junctionMode=${settings.junctionMode} extra="${settings.extraLaunchArguments}"`);
console.log(`Mods     : ${mods.map(mod => `${mod.name} [${mod.addons.map(addon => addon.prefix).join(", ")}]`).join(" | ") || "none"}`);

const runtimeRoot = path.join(repoRoot, "vscode-runtime");
const runtime = {
    modDirectory: path.join(runtimeRoot, "mod", "@SqfReloader")
};

const prefixesBeforeLaunch = new Map();
for (const mod of mods) {
    for (const addon of mod.addons) {
        const file = path.join(addon.localDirectory, "$PBOPREFIX$");
        prefixesBeforeLaunch.set(file, fs.existsSync(file) ? fs.readFileSync(file) : undefined);
    }
}

const launch = prepareRuntime(runtime, armaDirectory, settings, mods);
const modFolder = bundledModFolder(armaDirectory);

console.log(`Warnings : ${launch.warnings.length ? launch.warnings.join(" | ") : "none"}`);

check("no deployment warnings", launch.warnings.length === 0, launch.warnings[0]);
check("@SqfReloader deployed as a real folder (not a junction)", !readLinkTarget(modFolder), modFolder);
check("@SqfReloader has mod.cpp", fs.existsSync(path.join(modFolder, "mod.cpp")));
check("@SqfReloader has logo.paa (mod.cpp references it)", fs.existsSync(path.join(modFolder, "logo.paa")));
check("@SqfReloader has addons\\scripts.pbo", fs.existsSync(path.join(modFolder, "addons", "scripts.pbo")));
check("DLL in the mod ROOT (Arma does not search dll\\)", fs.existsSync(path.join(modFolder, "SqfReloader_x64.dll")));
check("no dll\\ subfolder (not resolvable by Arma)", !fs.existsSync(path.join(modFolder, "dll")));
check("no replacement\\ folder", !fs.existsSync(path.join(modFolder, "replacement")));
check("no unpacked addon copy", !fs.existsSync(path.join(modFolder, "addons", "scripts")));
check("no DLL next to arma3_x64.exe", !fs.existsSync(path.join(armaDirectory, "SqfReloader_x64.dll")));
check("no <arma>\\SqfReloader folder", !fs.existsSync(path.join(armaDirectory, "SqfReloader")));

for (const mod of mods) {
    for (const addon of mod.addons) {
        const linkPath = addonLinkPath(armaDirectory, addon);

        check(`${addon.prefix} linked into the Arma folder`, resolvedPath(linkPath) === resolvedPath(addon.localDirectory), linkPath);
        check(`the link is below the z\\ mount root (not the Arma root)`, linkPath.toLowerCase().includes(`\\z\\`), linkPath);
        const prefixFile = path.join(addon.localDirectory, "$PBOPREFIX$");
        const prefixBefore = prefixesBeforeLaunch.get(prefixFile);
        const prefixAfter = fs.existsSync(prefixFile) ? fs.readFileSync(prefixFile) : undefined;
        check(`developer $PBOPREFIX$ is left unchanged`, prefixBefore === undefined
            ? prefixAfter === undefined
            : prefixAfter !== undefined && prefixBefore.equals(prefixAfter), prefixFile);
        check(`scripts visible through the link (${addon.prefix})`, fs.existsSync(path.join(linkPath, "functions")) || fs.existsSync(path.join(linkPath, "config.cpp")));
    }

    check(`${mod.name} is handed to Arma as a @Mod folder`, mod.hasModFiles || fs.existsSync(path.join(armaDirectory, mod.name.startsWith("@") ? mod.name : `@${mod.name}`, "mod.cpp")), mod.directory);

    // The whole @Mod folder must not be junctioned below z\: the addon is mounted at
    // z\<tag>\addons\<addon> and a second copy makes Arma load the files twice.
    const zModLink = path.join(armaDirectory, "z", mod.name.startsWith("@") ? mod.name : `@${mod.name}`);
    check(`no z\\${mod.name} junction (addon is linked below z\\<tag>)`, !fs.existsSync(zModLink) || resolvedPath(zModLink) !== resolvedPath(mod.directory), zModLink);
}

const missions = findMissions([workspace]);
const mpNames = new Set(missions.filter(mission => mission.multiplayer).map(mission => path.basename(mission.directory).toLowerCase()));

for (const mission of missions) {
    const name = path.basename(mission.directory);
    const folders = mission.multiplayer
        ? ["MPMissions"]
        : ["Missions", "MPMissions"].filter(folder => folder !== "MPMissions" || !mpNames.has(name.toLowerCase()));

    for (const folder of folders) {
        const linkPath = path.join(armaDirectory, folder, name);
        check(`${name} linked into ${folder}`, resolvedPath(linkPath) === resolvedPath(mission.directory), linkPath);
    }
}

const cmdArgs = launchArguments(launch, settings, {});
console.log(`  args: ${cmdArgs.join(" ")}`);

check("starts with -filePatching", cmdArgs[0] === "-filePatching", cmdArgs[0]);
check("BattlEye disabled", cmdArgs.includes("-noBattlEye"));
// One quoted -mod="a;b" argument: the semicolons are inside the quotes, the paths are not
// quoted individually (quoting each path makes Arma ignore the startup scenario).
check("-mod= is one quoted argument (quotes wrap all paths, ; separated)",
    cmdArgs.some(value => value.startsWith('"-mod=') && value.endsWith('"') && !value.slice(1, -1).includes('"')),
    cmdArgs.find(value => value.startsWith('"-mod=')));
check("does not inject a -init startup parameter", !cmdArgs.some(value => /^-init(?:=|$)/i.test(value)), cmdArgs.find(value => value.startsWith("-init")));

if (mods.length > 0) {
    const modValue = cmdArgs.find(value => value.startsWith("-mod="))?.slice("-mod=".length) ?? "";
    check("-mod= includes @SqfReloader and the workspace mod", modValue.includes(modFolder) && mods.some(mod => modValue.includes(mod.directory)), modValue);
}

const forced = launchArguments(launch, settings, { extraArguments: ["-be"] });
check("-be in extraLaunchArguments wins", forced.includes("-be") && !forced.includes("-noBattlEye"), forced.join(" "));

console.log("");
if (failures.length > 0) {
    console.log(`LAUNCH VERIFY FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
}

console.log("LAUNCH VERIFY PASSED");
