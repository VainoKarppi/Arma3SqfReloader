// Verifies that duplicate-function markers re-validate themselves: a conflict whose file was
// deleted (by another tool, without a VS Code event or a save) must disappear on its own.
// Run from the repository root:  node scripts/verify-duplicate-diagnostics.js
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

const vscode = require("./vscode-stub.js");

// --- the few VS Code APIs the diagnostic collection touches --------------------------------
const entries = new Map();
vscode.languages = {
    createDiagnosticCollection: () => ({
        set: (uri, diagnostics) => entries.set(uri.fsPath, diagnostics),
        delete: uri => entries.delete(uri.fsPath),
        forEach: callback => {
            for (const key of [...entries.keys()]) callback({ fsPath: key });
        },
        dispose: () => entries.clear()
    })
};
vscode.DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
vscode.Position = class {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
};
vscode.Range = class {
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
};
vscode.Diagnostic = class {
    constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
    }
};
vscode.workspace.textDocuments = [];
vscode.workspace.openTextDocument = uri => {
    const lines = fs.readFileSync(uri.fsPath, "utf8").split(/\r?\n/);
    return Promise.resolve({
        uri,
        fileName: uri.fsPath,
        lineCount: lines.length,
        lineAt: line => ({ text: lines[line] ?? "" })
    });
};

const { DuplicateFunctionDiagnostics } = require(path.join(repoRoot, "out", "duplicateFunctions.js"));

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-duplicates-"));

function writeFile(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
}

function writeAddon(mod, tag, name) {
    const addon = path.join(root, mod, "addons", "core");
    writeFile(path.join(root, mod, "mod.cpp"), `name = "${mod}";\n`);
    writeFile(path.join(addon, "config.cpp"), `class CfgFunctions { class ${tag} { tag = "${tag}"; }; };\n`);
    const file = path.join(addon, "functions", `fn_${name}.sqf`);
    writeFile(file, "1;\n");
    return file;
}

vscode.workspace.workspaceFolders = [{ uri: { fsPath: root }, name: path.basename(root), index: 0 }];
writeFile(path.join(root, ".vscode", "sqfReloader-settings.json"), JSON.stringify({ enabled: true }, null, 4));

const first = writeAddon("@FirstMod", "mymod", "duplicate");
const second = writeAddon("@SecondMod", "mymod", "duplicate");
const diagnostics = new DuplicateFunctionDiagnostics();

(async () => {
    try {
        console.log("Conflicting definitions");
        const conflicts = await diagnostics.update([first], false);
        check("the conflict is reported", conflicts.size === 1, String(conflicts.size));
        check("both files are marked", entries.size === 2, String(entries.size));
        check("the first file is marked", entries.has(first));
        check("the second file is marked", entries.has(second));

        console.log("A file disappears without a VS Code event");
        fs.rmSync(second, { force: true });
        await diagnostics.revalidate();
        check("the surviving file loses its marker", !entries.has(first), [...entries.keys()].join(", "));
        check("the deleted file loses its marker", !entries.has(second), [...entries.keys()].join(", "));
        check("nothing is left in the Problems panel", entries.size === 0, String(entries.size));

        console.log("The duplicate comes back");
        writeAddon("@SecondMod", "mymod", "duplicate");
        // This is the path the file watcher takes for a file created outside VS Code.
        await diagnostics.revalidate([second]);
        check("the watcher re-check reports the conflict again", entries.size === 2, String(entries.size));

        console.log("A deleted folder clears the marker too");
        fs.rmSync(path.join(root, "@SecondMod"), { recursive: true, force: true });
        await diagnostics.revalidate();
        check("no stale marker survives a folder delete", entries.size === 0, String(entries.size));
        check("a second sweep stays clean", await (async () => {
            await diagnostics.revalidate();
            return entries.size === 0;
        })());
    } finally {
        diagnostics.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.`);
        process.exit(1);
    }

    console.log("\nAll duplicate-function diagnostic checks passed.");
})();
