// Verifies that every place carrying the product version agrees, so a hand edit cannot ship a
// vsix whose DLL, package metadata and CfgPatches disagree.
// Run from the repository root:  node scripts/verify-version.js
"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const SEMVER = /^\d+\.\d+\.\d+$/;

function read(relative) {
    return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

function match(relative, pattern, label) {
    const text = read(relative);
    const found = pattern.exec(text);
    if (!found) throw new Error(`${relative}: could not find ${label} (pattern ${pattern}).`);
    return found[1].trim();
}

const sources = [];

const packageJson = JSON.parse(read("package.json"));
sources.push({ file: "package.json", value: packageJson.version });

const lockText = read("package-lock.json");
const lockTop = /^\{\s*"name"\s*:\s*"[^"]*",\s*"version"\s*:\s*"([^"]+)"/m.exec(lockText);
const lockRoot = /"packages"\s*:\s*\{\s*"":\s*\{\s*"name"\s*:\s*"[^"]*",\s*"version"\s*:\s*"([^"]+)"/m.exec(lockText);
if (!lockTop) throw new Error("package-lock.json: no top-level version.");
if (!lockRoot) throw new Error('package-lock.json: no version in the "" package entry.');
sources.push({ file: "package-lock.json", value: lockTop[1] });
if (lockTop[1] !== lockRoot[1]) {
    sources.push({ file: 'package-lock.json (packages[""])', value: lockRoot[1] });
}

sources.push({
    file: "SqfReloaderExtension/SqfReloaderExtension.csproj",
    value: match("SqfReloaderExtension/SqfReloaderExtension.csproj", /<Version>([^<]+)<\/Version>/, "<Version>")
});
sources.push({
    file: "SqfReloaderExtension/src/BuildStamp.cs",
    value: match("SqfReloaderExtension/src/BuildStamp.cs", /Version\s*=\s*"([^"]+)"/, "BuildStamp.Version")
});
sources.push({
    file: "SqfReloaderExtension/@SqfReloader/addons/scripts/config.cpp",
    value: match("SqfReloaderExtension/@SqfReloader/addons/scripts/config.cpp", /(?<=\bversion\s*=\s*")([^"]+)/, "CfgPatches version")
});
sources.push({
    file: "SqfReloaderExtension/@SqfReloader/addons/scripts/config.cpp (versionStr)",
    value: match("SqfReloaderExtension/@SqfReloader/addons/scripts/config.cpp", /(?<=\bversionStr\s*=\s*")([^"]+)/, "versionStr")
});
sources.push({
    file: "SqfReloaderExtension/@SqfReloader/addons/scripts/config.cpp (versionAr[])",
    value: (() => {
        const numbers = match("SqfReloaderExtension/@SqfReloader/addons/scripts/config.cpp", /versionAr\[\]\s*=\s*\{([^}]*)\}/, "versionAr")
            .split(",")
            .map(part => part.trim())
            .filter(Boolean);
        return numbers.join(".");
    })()
});

const problems = [];
for (const source of sources) {
    if (!SEMVER.test(source.value)) {
        problems.push(`${source.file}: "${source.value}" is not a three-part version.`);
    }
}

const unique = [...new Set(sources.map(source => source.value))];
if (unique.length > 1) {
    problems.push(`Versions disagree: ${sources.map(source => `${source.file}=${source.value}`).join(", ")}`);
}

if (problems.length > 0) {
    console.error("Version check failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nRun build-all.ps1 -Version <x.y.z> to set every file at once.");
    process.exit(1);
}

console.log(`Version ${unique[0]} is consistent across ${sources.length} places:`);
for (const source of sources) console.log(`  ${source.value}  ${source.file}`);
