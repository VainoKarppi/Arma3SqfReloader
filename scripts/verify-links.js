// Verifies the link logic that decides whether Play Arma 3 launches: broken junctions are
// replaced instead of aborting the launch, mission links are registered, orphan links are
// removed, and real folders are never touched.
// Run from the repository root:  node scripts/verify-links.js
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

const links = require(path.join(repoRoot, "out", "junctions.js"));

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` (${detail})`}`);
}

function makeJunction(linkPath, target) {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    const { execFileSync } = require("child_process");
    if (process.platform === "win32") {
        execFileSync("cmd", ["/c", "mklink", "/J", linkPath, target], { stdio: "pipe" });
    } else {
        fs.symlinkSync(target, linkPath, "dir");
    }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-links-"));
const arma = path.join(root, "arma3");
const profile = path.join(root, "profile");
const workspace = path.join(root, "workspace");

function addonMod() {
    const addonDirectory = path.join(workspace, "@ExampleMod", "addons", "scripts");
    fs.mkdirSync(addonDirectory, { recursive: true });
    return {
        directory: path.join(workspace, "@ExampleMod"),
        name: "@ExampleMod",
        hasModFiles: true,
        addons: [{
            localDirectory: addonDirectory,
            prefix: "z\\example\\addons\\scripts",
            tag: "example",
            name: "scripts",
            instance: "scripts"
        }]
    };
}

function mission(name, multiplayer) {
    const directory = path.join(workspace, multiplayer ? "mpmissions" : "missions", name);
    fs.mkdirSync(directory, { recursive: true });
    return { directory, name, multiplayer, maxPlayers: 1 };
}

try {
    fs.mkdirSync(arma, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });

    console.log("Broken junction (the launch blocker)");
    const mod = addonMod();
    const mountPath = links.addonLinkPath(arma, mod.addons[0]);
    // A junction whose target was deleted: existsSync() is false, mklink then fails.
    const tempTarget = path.join(root, "gone-target");
    fs.mkdirSync(tempTarget, { recursive: true });
    makeJunction(mountPath, tempTarget);
    fs.rmSync(tempTarget, { recursive: true, force: true });
    check("the stale junction is invisible to existsSync", fs.existsSync(mountPath) === false);
    check("but lstat sees the entry", links.pathEntryExists(mountPath) === true);

    const created = links.createLinks(arma, [mod], "addon");
    check("createLinks does not warn about the stale junction", created.warnings.length === 0, created.warnings.join(" | "));
    check("the junction was recreated and links the workspace", created.links.length === 1);
    check("the link resolves to the addon source", fs.realpathSync(mountPath).toLowerCase() === mod.addons[0].localDirectory.toLowerCase());
    check("a file in the workspace is visible through the junction", fs.existsSync(path.join(mountPath)) && fs.statSync(mountPath).isDirectory());

    console.log("Mission links");
    const singlePlayer = mission("example.Altis", false);
    const multiplayer = mission("multi.Altis", true);
    const missionLinks = links.linkMissions(arma, profile, [singlePlayer, multiplayer]);
    // Single-player: Missions + MPMissions in the profile and the Arma root (4). Multiplayer: MPMissions only (2).
    check("both missions are linked", missionLinks.links.length === 6, `links=${missionLinks.links.length}`);
    check("no warnings for clean missions", missionLinks.warnings.length === 0, missionLinks.warnings.join(" | "));
    check("the single-player mission is in the profile Missions folder", links.pathEntryExists(path.join(profile, "Missions", "example.Altis")));
    check("the multiplayer mission is in the profile MPMissions folder", links.pathEntryExists(path.join(profile, "MPMissions", "multi.Altis")));

    const registry = links.readRegistry(arma);
    check("mission links are registered", registry.filter(entry => entry.kind === "mission").length === 6,
        JSON.stringify(registry.map(entry => `${entry.kind ?? "addon"}:${path.basename(entry.linkPath)}`)));

    console.log("Reconcile keeps mission links");
    links.reconcileLinks(arma, [mod], "addon");
    const afterReconcile = links.readRegistry(arma);
    check("reconcile does not drop mission links", afterReconcile.filter(entry => entry.kind === "mission").length === 6);
    check("reconcile does not drop the addon link", afterReconcile.some(entry => entry.kind !== "mission"));

    console.log("Mission junction whose target disappeared (the reported Play blocker)");
    const profileMissionLink = path.join(profile, "Missions", "example.Altis");
    fs.rmSync(singlePlayer.directory, { recursive: true, force: true });
    check("the link still exists while its target is gone", links.pathEntryExists(profileMissionLink) === true);
    check("existsSync reports it as missing", fs.existsSync(profileMissionLink) === false);

    const brokenRun = links.linkMissions(arma, profile, [singlePlayer]);
    check("linking does not throw for a broken junction", Array.isArray(brokenRun.links));
    check("the broken link is not silently reported as linked", brokenRun.links.every(link => !fs.existsSync(link.linkPath)));

    // Restoring the workspace folder (the normal case: the folder is back) must repair the link.
    fs.mkdirSync(singlePlayer.directory, { recursive: true });
    const repairedRun = links.linkMissions(arma, profile, [singlePlayer]);
    check("the junction is repaired once the target is back", repairedRun.links.length === 4, `links=${repairedRun.links.length}`);
    check("the repaired link resolves to the mission folder", fs.realpathSync(profileMissionLink).toLowerCase() === singlePlayer.directory.toLowerCase());

    console.log("Orphan cleanup");
    // A workspace-like target that disappears (workspace deleted or moved).
    const orphanTarget = path.join(root, "orphan-workspace");
    fs.mkdirSync(orphanTarget, { recursive: true });
    const orphanLink = path.join(profile, "Missions", "orphan.Altis");
    makeJunction(orphanLink, orphanTarget);
    links.reconcileLinks(arma, [mod], "addon"); // registers the existing mod only
    const orphanRegistry = links.readRegistry(arma);
    orphanRegistry.push({ linkPath: orphanLink, target: orphanTarget, kind: "mission" });
    fs.writeFileSync(links.registryPath(arma), JSON.stringify(orphanRegistry, null, 2), "utf8");

    fs.rmSync(orphanTarget, { recursive: true, force: true });
    const orphans = links.removeOrphanLinks(arma);
    check("the orphaned link is removed", orphans.removed.includes(orphanLink), JSON.stringify(orphans));
    check("the orphaned link is gone from disk", links.pathEntryExists(orphanLink) === false);
    check("working missions are kept", links.pathEntryExists(path.join(profile, "Missions", "example.Altis")));

    console.log("Real folders are never deleted");
    const realFolderPath = links.addonLinkPath(arma, { ...mod.addons[0], name: "real", instance: "real", prefix: "z\\example\\addons\\real" });
    fs.mkdirSync(realFolderPath, { recursive: true });
    fs.writeFileSync(path.join(realFolderPath, "config.cpp"), "// user data\n", "utf8");
    const realMod = {
        ...mod,
        addons: [{ ...mod.addons[0], name: "real", instance: "real", prefix: "z\\example\\addons\\real" }]
    };
    const conflictResult = links.createLinks(arma, [realMod], "addon");
    check("a real folder is reported as a conflict", conflictResult.conflicts.length === 1, JSON.stringify(conflictResult.conflicts));
    check("a real folder is not replaced automatically", fs.existsSync(path.join(realFolderPath, "config.cpp")));

    console.log("Cleanup removes everything the extension created");
    const removed = links.removeAllLinks(arma);
    check("addon links are removed", removed.removed.some(file => file.toLowerCase() === mountPath.toLowerCase()));
    check("mission links are removed", removed.removed.some(file => file.toLowerCase() === path.join(profile, "Missions", "example.Altis").toLowerCase()));
    check("nothing failed", removed.failed.length === 0, removed.failed.join(", "));
    check("the registry is empty afterwards", links.readRegistry(arma).length === 0);
    check("the user's real folder survives cleanup", fs.existsSync(path.join(realFolderPath, "config.cpp")));
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
}

console.log("\nAll link checks passed.");
