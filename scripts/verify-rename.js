// Verifies the SQF rename provider: F2 on a global variable renames every occurrence in the
// workspace (identifier and getVariable/setVariable string form, any namespace), F2 on a local
// renames only the occurrences that resolve to the same declaration.
// Run from the repository root:  node scripts/verify-rename.js
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
const { Position, Range } = vscode;

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
}

// --- an in-memory TextDocument that behaves like VS Code's model ---------------------------
function makeDocument(file, text) {
    const lineStarts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === "\n") lineStarts.push(index + 1);
    }
    const lines = text.split("\n");

    const positionAt = offset => {
        let line = 0;
        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++;
        return new Position(line, offset - lineStarts[line]);
    };

    const offsetAt = position => (lineStarts[position.line] ?? 0) + position.character;

    const getText = range => {
        if (!range) return text;
        return text.slice(offsetAt(range.start), offsetAt(range.end));
    };

    return {
        uri: { fsPath: file, scheme: "file", toString: () => `file://${file}` },
        fileName: file,
        version: 1,
        lineCount: lines.length,
        getText,
        positionAt,
        offsetAt,
        lineAt: line => ({ text: lines[line] ?? "" }),
        getWordRangeAtPosition: (position, pattern) => {
            const line = lines[position.line] ?? "";
            const source = pattern instanceof RegExp ? pattern.source : String(pattern);
            const regex = new RegExp(source, "g");
            let match;
            while ((match = regex.exec(line)) !== null) {
                const start = match.index;
                const end = start + match[0].length;
                if (position.character >= start && position.character <= end) {
                    return new Range(positionAt(offsetAt({ line: position.line, character: start })),
                        new Position(position.line, end));
                }
                if (match[0].length === 0) regex.lastIndex++;
            }
            return undefined;
        }
    };
}

function positionOf(text, needle, occurrence = 0) {
    let index = -1;
    for (let found = 0; found <= occurrence; found++) {
        index = text.indexOf(needle, index + 1);
        if (index < 0) throw new Error(`'${needle}' not found`);
    }
    const before = text.slice(0, index).split("\n");
    return new Position(before.length - 1, before[before.length - 1].length);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-rename-"));
const files = new Map();

function writeFile(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
    files.set(path.resolve(file).toLowerCase(), file);
}

vscode.workspace.workspaceFolders = [{ uri: { fsPath: root }, name: path.basename(root), index: 0 }];
writeFile(path.join(root, ".vscode", "sqfReloader-settings.json"), JSON.stringify({ enabled: true }, null, 4));

const definitions = path.join(root, "@Mod", "addons", "core", "functions");
const globalA = path.join(definitions, "fn_store.sqf");
const globalB = path.join(definitions, "fn_read.sqf");
writeFile(globalA, [
    "// Creates the comment store.",
    "EOEX_var_Comments = createHashMap;",
    "missionNamespace setVariable [\"EOEX_var_Comments\", EOEX_var_Comments];",
    ""
].join("\n"));
writeFile(globalB, [
    "private _data = missionNamespace getVariable [\"EOEX_var_Comments\", nil];",
    "if !(isNil \"EOEX_var_Comments\") then {",
    "    private _map = EOEX_var_Comments get \"Data\";",
    "};",
    "// A comment mentioning EOEX_var_Comments is not renamed.",
    "diag_log \"EOEX_var_Comments\";",
    ""
].join("\n"));

const localFile = path.join(definitions, "fn_scope.sqf");
const localText = [
    "private _value = 1;",
    "private _first = {",
    "    private _value = 2;",
    "    _value",
    "};",
    "private _second = {",
    "    private _value = 3;",
    "    _value",
    "};",
    "_value",
    ""
].join("\n");
writeFile(localFile, localText);

const { SqfSymbolLookup } = require(path.join(repoRoot, "out", "links.js"));
const lookup = new SqfSymbolLookup();

/** Applies a WorkspaceEdit to a text and returns the new text (ranges sorted backwards). */
function applyEdit(uriLike, text, edits) {
    const sorted = [...edits].sort((left, right) => right.range.start.line - left.range.start.line
        || right.range.start.character - left.range.start.character);
    const lineStarts = [0];
    for (let index = 0; index < text.length; index++) if (text[index] === "\n") lineStarts.push(index + 1);
    const offset = position => (lineStarts[position.line] ?? 0) + position.character;

    let result = text;
    for (const edit of sorted) {
        result = result.slice(0, offset(edit.range.start)) + edit.text + result.slice(offset(edit.range.end));
    }
    return result;
}

const token = { isCancellationRequested: false };

try {
    console.log("Global variable from an assignment");
    vscode.workspace.textDocuments = [];
    const documentA = makeDocument(globalA, fs.readFileSync(globalA, "utf8"));
    const documentB = makeDocument(globalB, fs.readFileSync(globalB, "utf8"));

    const startA = positionOf(documentA.getText(), "EOEX_var_Comments");
    const prepared = lookup.prepareRename(documentA, startA, token);
    check("F2 offers the variable", !!prepared && prepared.placeholder === "EOEX_var_Comments",
        prepared ? prepared.placeholder : "none");

    const globalEdit = lookup.provideRenameEdits(documentA, startA, "EOEX_var_Notes", token);
    const editsA = globalEdit.edits.filter(edit => path.resolve(edit.uri.fsPath) === path.resolve(globalA));
    const editsB = globalEdit.edits.filter(edit => path.resolve(edit.uri.fsPath) === path.resolve(globalB));
    // globalA: assignment, setVariable name and the value passed to it.
    check("the definition file gets three edits", editsA.length === 3, String(editsA.length));
    // globalB: getVariable, isNil, the map access and a string that is exactly the name.
    check("the reader file gets four edits", editsB.length === 4, String(editsB.length));

    const renamedA = applyEdit(globalA, documentA.getText(), editsA);
    const renamedB = applyEdit(globalB, documentB.getText(), editsB);
    check("the assignment keeps its comment", renamedA.includes("// Creates the comment store."));
    check("the new name is used in the definition", renamedA.includes("EOEX_var_Notes = createHashMap;"));
    check("the setVariable string is renamed", renamedA.includes('setVariable ["EOEX_var_Notes", EOEX_var_Notes]'));
    check("getVariable is renamed", renamedB.includes('getVariable ["EOEX_var_Notes", nil]'));
    check("isNil is renamed", renamedB.includes('isNil "EOEX_var_Notes"'));
    check("the map access is renamed", renamedB.includes('EOEX_var_Notes get "Data"'));
    check("a comment mentioning the old name is left alone", renamedB.includes("// A comment mentioning EOEX_var_Comments"));
    check("a string that is exactly the name is renamed too", renamedB.includes('diag_log "EOEX_var_Notes";'));
    check("the old name is gone from the code",
        !/EOEX_var_Comments/.test(renamedB.replace(/\/\/.*$/gm, "")));

    console.log("Global variable from a getVariable string (same file)");
    vscode.workspace.textDocuments = [documentB];
    const insideString = positionOf(documentB.getText(), "EOEX_var_Comments", 0);
    const preparedString = lookup.prepareRename(documentB, insideString, token);
    check("F2 inside the quoted name resolves the variable",
        !!preparedString && preparedString.placeholder === "EOEX_var_Comments",
        preparedString ? preparedString.placeholder : "none");

    const stringEdit = lookup.provideRenameEdits(documentB, insideString, "EOEX_var_Entries", token);
    const stringEdits = stringEdit.edits.filter(edit => path.resolve(edit.uri.fsPath) === path.resolve(globalB));
    const renamedString = applyEdit(globalB, documentB.getText(), stringEdits);
    check("the quotes stay in place", renamedString.includes('getVariable ["EOEX_var_Entries", nil]'));
    check("the same-file identifier is renamed too", renamedString.includes('EOEX_var_Entries get "Data"'));

    console.log("Invalid names");
    let threw = false;
    try {
        lookup.provideRenameEdits(documentA, startA, "noTag", token);
    } catch {
        threw = true;
    }
    check("a global without a tag is rejected", threw);

    console.log("Local variable inside its own scope");
    vscode.workspace.textDocuments = [];
    const localDocument = makeDocument(localFile, localText);
    const innerValue = positionOf(localText, "_value", 1);
    const preparedLocal = lookup.prepareRename(localDocument, innerValue, token);
    check("F2 offers the local name", !!preparedLocal && preparedLocal.placeholder === "_value",
        preparedLocal ? preparedLocal.placeholder : "none");

    const localEdit = lookup.provideRenameEdits(localDocument, innerValue, "_inner", token);
    const renamedLocal = applyEdit(localFile, localText, localEdit.edits);
    check("the first block is renamed", renamedLocal.includes("private _inner = 2;\n    _inner"));
    check("the sibling block keeps its own _value", renamedLocal.includes("private _value = 3;\n    _value"));
    check("the outer _value is untouched",
        renamedLocal.startsWith("private _value = 1;") && renamedLocal.trimEnd().endsWith("_value"));
    check("only the declaration and its use were edited", localEdit.edits.length === 2, String(localEdit.edits.length));

    console.log("Local variable at file scope");
    const outerValue = positionOf(localText, "_value", 0);
    const outerEdit = lookup.provideRenameEdits(localDocument, outerValue, "_outer", token);
    const renamedOuter = applyEdit(localFile, localText, outerEdit.edits);
    check("the outermost declaration is renamed", renamedOuter.startsWith("private _outer = 1;"));
    check("its trailing use is renamed", /_outer$/.test(renamedOuter.trimEnd()));
    check("the block-local names are untouched",
        renamedOuter.includes("private _value = 2;") && renamedOuter.includes("private _value = 3;"));
    check("the outer rename edits two occurrences", outerEdit.edits.length === 2, String(outerEdit.edits.length));

    let localThrew = false;
    try {
        lookup.provideRenameEdits(localDocument, innerValue, "inner", token);
    } catch {
        localThrew = true;
    }
    check("a local rename without the underscore is rejected", localThrew);

    console.log("Places where rename is not offered");
    const commentOnly = path.join(definitions, "fn_plain.sqf");
    const plainText = "private _count = 0;\n_count = _count + 1;\n";
    writeFile(commentOnly, plainText);
    const plainDocument = makeDocument(commentOnly, plainText);
    const onWord = positionOf(plainText, "private");
    check("a keyword is not renameable", lookup.prepareRename(plainDocument, onWord, token) === undefined);
    const undeclared = makeDocument(path.join(definitions, "fn_undeclared.sqf"), "private _other = 1;\n_other + _ghost;\n");
    check("an undeclared local is not renameable",
        lookup.prepareRename(undeclared, positionOf("private _other = 1;\n_other + _ghost;", "_ghost"), token) === undefined);
} finally {
    lookup.dispose();
    fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
}

console.log("\nAll rename checks passed.");
