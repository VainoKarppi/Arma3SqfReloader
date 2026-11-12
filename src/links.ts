import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findAddonForFile, findMissions, readFunctionTag, toFunctionVariable } from "./arma";
import { deletedFunctionVariable } from "./reload";
import { workspaceAddons } from "./runtime";
import { log, logError } from "./settings";

/** `TAG_fnc_name` as it appears in SQF code (call sites, comments, config.cpp). */
const FUNCTION_VARIABLE_SOURCE = "\\b[A-Za-z][A-Za-z0-9]*_fnc_[A-Za-z0-9]+\\b";
const FUNCTION_FILE = /^fn_[\w-]+\.sqf$/i;
/** A name that is neither a function (`TAG_fnc_*`) nor a local (`_x`) variable. */
const GLOBAL_VARIABLE = /^[A-Za-z][A-Za-z0-9]*_(?![fF][nN][cC])[A-Za-z0-9][A-Za-z0-9_]*$/;
const IDENTIFIER = /[A-Za-z0-9_]+/;
/** A file-local name such as `_test`, `_test2` or a `params` entry such as `_myValue`. */
const LOCAL_VARIABLE = /^_[A-Za-z0-9_]+$/;
const SETTING_FUNCTIONS = "functionLinks";
const SETTING_GLOBALS = "globalVariableLinks";
const SETTING_LOCALS = "localVariableLinks";
/** Guard against walking an enormous tree on the first lookup. */
const MAX_FILES = 20000;
/**
 * `TAG_fnc_name` at the cursor in one line. The caret counts as being on the symbol when it is
 * anywhere from the first character to just after the last one, because VS Code's own
 * references command queries the exact caret position (which is often right after the word).
 */
function functionVariableAt(document: vscode.TextDocument, position: vscode.Position): { variable: string; range: vscode.Range } | undefined {
    const line = document.lineAt(position.line).text;
    const pattern = new RegExp(FUNCTION_VARIABLE_SOURCE, "gi");

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (position.character >= start && position.character <= end) {
            return { variable: match[0], range: new vscode.Range(position.line, start, position.line, end) };
        }
    }

    return undefined;
}

/**
 * Function variable of a `fn_*.sqf` file (`<tag>_fnc_<name>`), or undefined for anything else.
 * Uses the same resolution as the reloader, so the tag casing and fallbacks match exactly.
 */
export function functionVariableForFile(file: string): string | undefined {
    return /^fn_[\w-]+\.sqf$/i.test(path.basename(file)) ? deletedFunctionVariable(file) : undefined;
}

/**
 * Backs "SqfReloader: See references": reports where the function file's `TAG_fnc_name` is used.
 * Shared by the Explorer context menu (a resource is passed) and the editor context menu (the
 * active editor is used), so both go through exactly the same logic.
 */
export async function seeReferences(file: string | undefined, lookup: SqfSymbolLookup): Promise<void> {
    if (!file) {
        void vscode.window.showInformationMessage("Open or right-click an .sqf function file first.");
        return;
    }
    if (!/\.sqf$/i.test(file)) {
        void vscode.window.showInformationMessage(`See references works on .sqf files (${path.basename(file)} is not one).`);
        return;
    }

    const variable = functionVariableForFile(file);
    if (!variable) {
        void vscode.window.showInformationMessage(`${path.basename(file)} is not a function file (expected fn_*.sqf), so there is no function variable to search for.`);
        return;
    }

    const locations = lookup.referencesForVariable(variable);
    if (locations.length === 0) {
        void vscode.window.showInformationMessage(`No references to ${variable} were found in this workspace.`);
        return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    // The standard peek UI: every call site, and selecting one jumps to it.
    await vscode.commands.executeCommand("editor.action.showReferences", document.uri, new vscode.Position(0, 0), locations);
}

/** A variable defined in many places only needs the first hits. */
const MAX_DEFINITIONS = 50;
/** Cap on reported call sites, so the peek list stays responsive in a large workspace. */
const MAX_REFERENCES = 2000;
/** Longest code preview shown in a hover before it is cut with `...`. */
export const MAX_PREVIEW_LENGTH = 125;

export function functionLinksEnabled(): boolean {
    return vscode.workspace.getConfiguration("sqfReloader").get<boolean>(SETTING_FUNCTIONS, true);
}

/** Global (`TAG_name`) variables, resolved across the workspace. */
export function globalVariableLinksEnabled(scope?: vscode.Uri): boolean {
    return vscode.workspace.getConfiguration("sqfReloader", scope).get<boolean>(SETTING_GLOBALS, true);
}

/** File-local names (`_name`, `params` entries), resolved inside the open document. */
export function localVariableLinksEnabled(document?: vscode.Uri): boolean {
    return vscode.workspace.getConfiguration("sqfReloader", document).get<boolean>(SETTING_LOCALS, true);
}

interface VariableDefinition {
    file: string;
    line: number;
    character: number;
}

/** A local definition plus the `{ ... }` scope it belongs to. */
interface ScopedDefinition extends VariableDefinition {
    scopeId: number;
}

/** Scope information of one open document. */
interface LocalIndex {    version: number;
    index: Map<string, ScopedDefinition[]>;
    /** Innermost scope id at each character offset. */
    scopeAt: number[];
    /** Parent scope of every scope; the file scope (0) has no entry. */
    parent: Map<number, number>;
}

/**
 * Makes SQF symbols resolvable in `.sqf` files:
 *
 *  - `TAG_fnc_name` -> the `fn_name.sqf` source, with the function header as hover.
 *  - global variables (`TAG_name`, i.e. anything tagged that is not a `fnc` function) -> every
 *    place they are defined, with the defining line as hover. `missionNamespace setVariable
 *    ["TAG_name", value]` counts as a definition; `getVariable "TAG_name"` /
 *    `getVariable ["TAG_name", default]` resolve to the same index. Only the mission namespace is
 *    tracked, matching how these globals are used.
 *  - file-local names (`_name`, `params` entries) -> their declarations in the open document.
 *
 * The first two are gated by `sqfReloader.functionLinks` / `sqfReloader.globalVariableLinks`,
 * the local names by `sqfReloader.localVariableLinks`.
 *
 * A definition/hover provider is used instead of document links because VS Code always
 * underlines document links, and link styling cannot be changed through the extension API.
 *
 * Function resolution reuses the reloader's own rules (`fn_*.sqf` inside an addon source folder
 * plus mission functions). Variables are collected from every `.sqf` file in the workspace.
 */
export class SqfSymbolLookup implements vscode.DefinitionProvider, vscode.ReferenceProvider, vscode.HoverProvider, vscode.Disposable {
    private functions: Map<string, string> | undefined;
    private variables: Map<string, VariableDefinition[]> | undefined;
    private missionDirs: string[] | undefined;
    /** Per-open-document local index, keyed by file and tagged with the document version. */
    private readonly localCache = new Map<string, LocalIndex>();
    private readonly docCache = new Map<string, string[]>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        const functionWatcher = vscode.workspace.createFileSystemWatcher("**/{fn_*.sqf,config.cpp,config.bin,description.ext}");
        const invalidateFunctions = (): void => {
            this.functions = undefined;
            this.docCache.clear();
        };

        const sqfWatcher = vscode.workspace.createFileSystemWatcher("**/*.sqf");
        const refreshVariables = (uri: vscode.Uri): void => this.refreshVariableFile(uri.fsPath);
        const dropVariables = (uri: vscode.Uri): void => this.refreshVariableFile(uri.fsPath, true);

        this.disposables.push(
            functionWatcher,
            functionWatcher.onDidCreate(invalidateFunctions),
            functionWatcher.onDidDelete(invalidateFunctions),
            functionWatcher.onDidChange(invalidateFunctions),
            sqfWatcher,
            sqfWatcher.onDidChange(refreshVariables),
            sqfWatcher.onDidCreate(refreshVariables),
            sqfWatcher.onDidDelete(dropVariables),
            vscode.workspace.onDidCloseTextDocument(document => {
                this.localCache.delete(this.cacheKey(document.uri.fsPath));
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                invalidateFunctions();
                this.variables = undefined;
                this.missionDirs = undefined;
                this.localCache.clear();
            })
        );
    }

    dispose(): void {
        for (const disposable of this.disposables) disposable.dispose();
        this.disposables.length = 0;
    }

    provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
        const fn = this.resolveFunction(document, position);
        if (fn) return new vscode.Location(vscode.Uri.file(fn.file), new vscode.Position(0, 0));

        const local = this.resolveLocal(document, position);
        if (local) {
            return local.definitions.map(definition =>
                new vscode.Location(vscode.Uri.file(document.uri.fsPath), new vscode.Position(definition.line, definition.character)));
        }

        const variable = this.resolveVariable(document, position);
        if (!variable) return undefined;

        return variable.definitions.map(definition =>
            new vscode.Location(vscode.Uri.file(definition.file), new vscode.Position(definition.line, definition.character)));
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const fn = this.resolveFunction(document, position);
        if (fn) {
            const markdown = new vscode.MarkdownString();
            markdown.appendCodeblock(fn.variable, "sqf");
            markdown.appendMarkdown(formatDocumentation(fn.file, this.fileLines(fn.file)));
            return new vscode.Hover(markdown, fn.range);
        }

        const local = this.resolveLocal(document, position);
        if (local) {
            const markdown = new vscode.MarkdownString();
            markdown.supportHtml = true;
            markdown.appendMarkdown(this.formatLocalDefinitions(local.lines, local.definitions));
            return new vscode.Hover(markdown, local.range);
        }

        const variable = this.resolveVariable(document, position);
        if (!variable) return undefined;

        const markdown = new vscode.MarkdownString();
        markdown.supportHtml = true;
        markdown.appendMarkdown(this.formatVariableDefinitions(variable.definitions));
        return new vscode.Hover(markdown, variable.range);
    }

    /**
     * Call sites of the function variable under the cursor. When the cursor is not on a
     * `TAG_fnc_name` but the file is itself a `fn_*.sqf`, the file's own function variable is
     * used, so Shift+F12 / "Find All References" also works while editing the definition (which
     * is what the Explorer's "See references" does).
     */
    provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): vscode.Location[] | undefined {
        if (!functionLinksEnabled() || document.uri.scheme !== "file") return undefined;

        const found = functionVariableAt(document, position);
        const variable = found?.variable ?? functionVariableForFile(document.uri.fsPath);
        if (!variable) return undefined;

        const locations = this.referencesForVariable(variable, token);
        if (context.includeDeclaration || !found) return locations;
        return locations.filter(location => !isSamePosition(location, found.range.start, document.uri));
    }

    /**
     * Every place `TAG_fnc_name` is used in the workspace's `.sqf` files. Strings and comments are
     * skipped, so a name mentioned in a comment is not reported as a call site.
     */
    referencesForVariable(variable: string, token?: vscode.CancellationToken): vscode.Location[] {
        const needle = variable.toLowerCase();
        const pattern = new RegExp(`\\b${escapeRegExpCharacters(variable)}\\b`, "gi");
        const locations: vscode.Location[] = [];

        for (const file of this.sqfFiles()) {
            if (token?.isCancellationRequested) break;

            const lines = this.fileLines(file);
            const state = { inBlockComment: false };
            for (let line = 0; line < lines.length; line++) {
                if (!lines[line].toLowerCase().includes(needle)) {
                    // Still advance the block-comment state so a `/* */` spanning lines is tracked.
                    scanLine(lines[line], state);
                    continue;
                }

                const { code } = scanLine(lines[line], state);
                pattern.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = pattern.exec(code)) !== null) {
                    locations.push(new vscode.Location(
                        vscode.Uri.file(file),
                        new vscode.Range(line, match.index, line, match.index + match[0].length)
                    ));
                    if (locations.length >= MAX_REFERENCES) return locations;
                }
            }
        }

        return locations;
    }

    // --- functions ---------------------------------------------------------

    /** Function variable under the cursor, its target file and the word range. */
    private resolveFunction(document: vscode.TextDocument, position: vscode.Position): { variable: string; file: string; range: vscode.Range } | undefined {
        if (!functionLinksEnabled() || document.uri.scheme !== "file") return undefined;

        const wordRange = document.getWordRangeAtPosition(position, new RegExp(FUNCTION_VARIABLE_SOURCE));
        if (!wordRange) return undefined;

        const variable = document.getText(wordRange);
        if (variable.indexOf("_fnc_") < 0) return undefined;

        const target = this.functionIndex().get(variable.toLowerCase());
        if (!target || path.resolve(target).toLowerCase() === path.resolve(document.uri.fsPath).toLowerCase()) return undefined;

        return { variable, file: target, range: wordRange };
    }

    private functionIndex(): Map<string, string> {
        if (this.functions) return this.functions;

        const index = new Map<string, string>();
        let visited = 0;

        const collect = (directory: string, resolveVariable: (file: string) => string | undefined): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    logError(`could not index SQF functions in ${directory}`, error);
                }
                return;
            }

            for (const entry of entries) {
                if (visited >= MAX_FILES) return;
                if (entry.name.startsWith(".") || entry.name.toLowerCase() === "node_modules") continue;

                visited++;
                const child = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    collect(child, resolveVariable);
                    continue;
                }

                if (!entry.isFile() || !FUNCTION_FILE.test(entry.name)) continue;

                const variable = resolveVariable(child);
                if (variable && !index.has(variable.toLowerCase())) {
                    index.set(variable.toLowerCase(), child);
                }
            }
        };

        try {
            for (const addon of workspaceAddons()) {
                collect(addon.localDirectory, file => {
                    const owner = findAddonForFile(file);
                    return owner ? toFunctionVariable(owner, file) : undefined;
                });
            }

            const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
            for (const mission of findMissions(roots)) {
                const tag = readFunctionTag(mission.directory);
                if (!tag) continue;
                collect(mission.directory, file => {
                    const name = path.basename(file);
                    return FUNCTION_FILE.test(name) ? `${tag}_fnc_${name.slice(3, -4)}` : undefined;
                });
            }
        } catch (error) {
            logError("could not build the SQF function lookup index", error);
        }

        this.functions = index;
        log(`SQF function lookup: ${index.size} function(s) indexed.`);
        return index;
    }

    // --- local variables ---------------------------------------------------

    /**
     * File-local variable under the cursor and the definitions that can be its value.
     *
     * Scope matters: every `{ ... }` block is its own scope, so the `private _clientId = _x;`
     * inside one `forEach` block is not a definition for the same name in a sibling block. The
     * nearest enclosing scope that declares the name wins (shadowing), and only declarations
     * above the usage count, because SQF runs top to bottom.
     *
     * Locals are only ever resolved inside the file being edited: the index is built on demand
     * from the open document (unsaved text included) and kept per document version, so nothing is
     * scanned before a file is open and no cross-file value is ever assumed.
     */
    private resolveLocal(document: vscode.TextDocument, position: vscode.Position): { range: vscode.Range; definitions: VariableDefinition[]; lines: string[] } | undefined {
        if (!localVariableLinksEnabled(document.uri) || document.uri.scheme !== "file") return undefined;

        const wordRange = document.getWordRangeAtPosition(position, IDENTIFIER);
        if (!wordRange) return undefined;

        const name = document.getText(wordRange);
        if (!LOCAL_VARIABLE.test(name)) return undefined;

        const locals = this.localIndex(document);
        const candidates = locals.index.get(name.toLowerCase()) ?? [];
        if (candidates.length === 0) return undefined;

        const beforeCursor = (definition: VariableDefinition): boolean =>
            definition.line < wordRange.start.line
            || (definition.line === wordRange.start.line && definition.character < wordRange.start.character);

        // Walk from the innermost scope outwards; the first scope with a visible declaration wins.
        let scopeId: number | undefined = locals.scopeAt[this.offsetOf(document, wordRange.start)];
        let definitions: VariableDefinition[] = [];

        while (scopeId !== undefined) {
            definitions = candidates.filter(definition => definition.scopeId === scopeId && beforeCursor(definition));
            if (definitions.length > 0) break;
            scopeId = locals.parent.get(scopeId);
        }

        if (definitions.length === 0) return undefined;
        return { range: wordRange, definitions, lines: document.getText().split(/\r?\n/) };
    }

    /** Character offset of a position in the document text. */
    private offsetOf(document: vscode.TextDocument, position: vscode.Position): number {
        return document.offsetAt(position);
    }

    /**
     * Definitions of the file-local names, from the open document text, tagged with the scope
     * (`{ ... }` block) they belong to.
     */
    private localIndex(document: vscode.TextDocument): LocalIndex {
        const key = this.cacheKey(document.uri.fsPath);
        const cached = this.localCache.get(key);
        if (cached && cached.version === document.version) return cached;

        const index = new Map<string, ScopedDefinition[]>();
        const file = document.uri.fsPath;
        const text = document.getText();
        const scopes = buildScopes(text);
        const lineStarts = lineStartOffsets(text);
        const state = { inBlockComment: false };

        const add = (name: string, offset: number): void => {
            const position = offsetToPosition(lineStarts, offset);
            const definitions = index.get(name.toLowerCase()) ?? [];
            const scopeId = scopes.scopeAt[offset] ?? 0;

            if (definitions.some(item => item.line === position.line
                && item.character === position.character
                && item.scopeId === scopeId)) return;

            definitions.push({ file, line: position.line, character: position.character, scopeId });
            index.set(name.toLowerCase(), definitions);
        };

        // `private _test = true;`, `_test2 = true;`, `private _one = param [0, 1];`
        // `private ["_a", "_b"];` and `private "_c";` declare without a value.
        //
        // Assignments are matched against the string-blanked line (a `_x =` inside "..." or a
        // comment is not an assignment), while declaration lists need the strings intact, so they
        // use the line with only comments blanked.
        const lines = text.split(/\r?\n/);
        const commentFreeLines = blankComments(text).split(/\r?\n/);
        for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            // Derive the offset from the real line starts: adding up line lengths would drift by
            // one character per line on CRLF files, because split() drops the \r.
            const lineOffset = lineStarts[lineNumber] ?? text.length;
            const { code } = scanLine(lines[lineNumber], state);

            const assignment = /(?:^|[^A-Za-z0-9_])(_[A-Za-z0-9_]+)\s*=(?!=)/g;
            let match: RegExpExecArray | null;
            while ((match = assignment.exec(code)) !== null) {
                add(match[1], lineOffset + match.index + match[0].indexOf(match[1]));
            }

            const declarationSource = commentFreeLines[lineNumber] ?? "";
            const declaration = /\bprivate\s+(?:\[([^\]]*)\]|"(_[A-Za-z0-9_]+)")/gi;
            while ((match = declaration.exec(declarationSource)) !== null) {
                if (match[2]) {
                    add(match[2], lineOffset + match.index + match[0].lastIndexOf(match[2]));
                    continue;
                }

                const bracket = match[0].indexOf("[");
                const listStart = lineOffset + match.index + bracket + 1;
                for (const name of (match[1] ?? "").matchAll(/"(_[A-Za-z0-9_]+)"/g)) {
                    add(name[1], listStart + (name.index ?? 0) + 1);
                }
            }
        }

        // `params ["_myValue"]` / `params [["_myValue", 1, [1]]]`, at any block depth: `params`
        // inside `{ ... }` declares variables for that block only.
        const paramsPattern = /\bparams\s*\[/gi;
        let paramsMatch: RegExpExecArray | null;
        while ((paramsMatch = paramsPattern.exec(blankComments(text))) !== null) {
            const open = text.indexOf("[", paramsMatch.index);
            const close = matchingBracket(text, open);
            if (close <= open) continue;

            const bodyStart = open + 1;
            // Comments are blanked (same length) so `// "_x"` cannot swallow the entry after it.
            const body = blankComments(text.slice(bodyStart, close));
            for (const entry of splitTopLevelWithOffsets(body)) {
                const parsed = parseParameterEntry(entry.text);
                if (!parsed) continue;

                const nameIndex = entry.text.indexOf(`"${parsed.name}"`);
                add(parsed.name, bodyStart + entry.start + (nameIndex >= 0 ? nameIndex + 1 : 0));
            }
        }

        const result: LocalIndex = { version: document.version, index, ...scopes };
        this.localCache.set(key, result);
        return result;
    }

    /** Line only, then the defining code, so the hover stays compact. */
    private formatLocalDefinitions(lines: string[], definitions: VariableDefinition[]): string {
        const heading = definitions.length === 1 ? "Defined on line:" : `Defined on ${definitions.length} lines:`;
        const rows = definitions.map(definition => {
            const preview = previewCode(lines[definition.line] ?? "");
            const line = `<small>${codeSpan(`line ${definition.line + 1}`)}</small>`;
            return preview ? `${line}\n\n\`\`\`sqf\n${preview}\n\`\`\`` : line;
        });

        return `${heading}\n\n${rows.join("\n\n")}`;
    }

    // --- global variables --------------------------------------------------

    /** Global variable under the cursor and every place it is defined. */
    private resolveVariable(document: vscode.TextDocument, position: vscode.Position): { name: string; range: vscode.Range; definitions: VariableDefinition[] } | undefined {
        if (!globalVariableLinksEnabled(document.uri) || document.uri.scheme !== "file") return undefined;

        const found = variableNameAt(document, position);
        if (!found) return undefined;

        const currentFile = this.cacheKey(document.uri.fsPath);
        const definitions = (this.variableIndex().get(found.name.toLowerCase()) ?? [])
            .filter(definition => !(this.cacheKey(definition.file) === currentFile
                && definition.line === position.line
                && definition.character === found.range.start.character));

        if (definitions.length === 0) return undefined;
        return { name: found.name, range: found.range, definitions };
    }

    private variableIndex(): Map<string, VariableDefinition[]> {
        if (this.variables) return this.variables;

        const index = new Map<string, VariableDefinition[]>();
        const files = this.sqfFiles();

        for (const file of files) this.indexFileVariables(file, index);

        this.variables = index;
        log(`SQF variable lookup: ${index.size} variable(s) indexed from ${files.length} file(s).`);
        return index;
    }

    /** Re-indexes one saved file so the index does not have to be rebuilt after every save. */
    private refreshVariableFile(file: string, deleted = false): void {
        this.docCache.delete(this.cacheKey(file));
        if (!this.variables) return;

        const key = this.cacheKey(file);
        for (const [name, definitions] of this.variables) {
            const remaining = definitions.filter(definition => this.cacheKey(definition.file) !== key);
            if (remaining.length === definitions.length) continue;
            if (remaining.length === 0) this.variables.delete(name);
            else this.variables.set(name, remaining);
        }

        if (!deleted && /\.sqf$/i.test(file)) this.indexFileVariables(file, this.variables);
    }

    private indexFileVariables(file: string, index: Map<string, VariableDefinition[]>): void {
        const lines = this.fileLines(file);
        const state = { inBlockComment: false };

        for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            const { code, strings } = scanLine(lines[lineNumber], state);

            // TAG_name = value;  (the left side of an assignment defines the variable)
            const assignment = /(?:^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\s*=(?!=)/g;
            let match: RegExpExecArray | null;
            while ((match = assignment.exec(code)) !== null) {
                const name = match[1];
                if (!GLOBAL_VARIABLE.test(name)) continue;
                addDefinition(index, name, { file, line: lineNumber, character: match.index + match[0].indexOf(name) });
            }

            // missionNamespace setVariable ["TAG_name", value]; (mission namespace only)
            if (!/setVariable/i.test(code)) continue;
            for (const literal of strings) {
                if (!GLOBAL_VARIABLE.test(literal.value)) continue;
                if (!/setVariable/i.test(code.slice(0, literal.start))) continue;
                addDefinition(index, literal.value, { file, line: lineNumber, character: literal.start + 1 });
            }
        }
    }

    /** Every `.sqf` file in the workspace folders (hidden folders and node_modules excluded). */
    private sqfFiles(): string[] {
        const files: string[] = [];
        const visit = (directory: string): void => {
            if (files.length >= MAX_FILES) return;

            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    logError(`could not scan ${directory} for SQF variables`, error);
                }
                return;
            }

            for (const entry of entries) {
                if (files.length >= MAX_FILES) return;
                if (entry.name.startsWith(".") || entry.name.toLowerCase() === "node_modules") continue;

                const child = path.join(directory, entry.name);
                if (entry.isDirectory()) visit(child);
                else if (entry.isFile() && /\.sqf$/i.test(entry.name)) files.push(child);
            }
        };

        for (const folder of vscode.workspace.workspaceFolders ?? []) visit(folder.uri.fsPath);
        return files;
    }

    /**
     * Compact hover: the file path uses `<small>` (the smallest text VS Code allows there; the
     * sanitizer rejects `font-size`), while the defining code stays a fenced SQF block so it keeps
     * syntax highlighting. Rows are separated by blank lines — a fence only closes when it is the
     * last thing on its line, so `<br>` must not follow it.
     */
    private formatVariableDefinitions(definitions: VariableDefinition[]): string {
        const heading = definitions.length === 1 ? "Defined in 1 place:" : `Defined in ${definitions.length} places:`;
        const rows = definitions.map(definition => {
            const location = this.displayPath(definition.file) + ":" + (definition.line + 1);
            const preview = previewCode(this.fileLines(definition.file)[definition.line] ?? "");
            const path = `<small>${codeSpan(location)}</small>`;
            return preview ? `${path}\n\n\`\`\`sqf\n${preview}\n\`\`\`` : path;
        });

        return `${heading}\n\n${rows.join("\n\n")}`;
    }

    /**
     * Shortest useful path for the hover: mission functions show only their path inside the
     * mission folder (`ExampleMission.Altis/TEST/fn_x.sqf` -> `TEST/fn_x.sqf`), mod files drop the
     * mod folder and its `addons` segment (`@Mod/addons/functions/fn_x.sqf` -> `functions/fn_x.sqf`).
     */
    private displayPath(file: string): string {
        const resolved = path.resolve(file);

        for (const mission of this.missionDirectories()) {
            const relative = path.relative(mission, resolved);
            if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
                return relative.split(path.sep).join("/");
            }
        }

        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const relative = path.relative(folder.uri.fsPath, resolved);
            if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;

            let segments = relative.split(path.sep);
            // Drop the mod folder (@Mod) and the addons container that follows it.
            if (segments[0].startsWith("@")) segments = segments.slice(1);
            if (segments.length > 1 && segments[0].toLowerCase() === "addons") segments = segments.slice(1);

            if (segments.length === 1) {
                // Still useful, but keep a little context from the full relative path.
                const full = relative.split(path.sep);
                segments = full.slice(Math.max(0, full.length - 2));
            }

            return segments.join("/");
        }

        return file;
    }

    /** Mission folders of the workspace, cached until the workspace folders change. */
    private missionDirectories(): string[] {
        if (this.missionDirs) return this.missionDirs;

        const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
        this.missionDirs = findMissions(roots).map(mission => mission.directory);
        return this.missionDirs;
    }

    private cacheKey(file: string): string {
        return path.resolve(file).toLowerCase();
    }

    private fileLines(file: string): string[] {
        const key = this.cacheKey(file);
        const cached = this.docCache.get(key);
        if (cached) return cached;

        let lines: string[] = [];
        try {
            lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                logError(`could not read ${file} for hover documentation`, error);
            }
        }

        this.docCache.set(key, lines);
        return lines;
    }
}

/** Identifier or quoted variable name under the cursor. */
function variableNameAt(document: vscode.TextDocument, position: vscode.Position): { name: string; range: vscode.Range } | undefined {
    const wordRange = document.getWordRangeAtPosition(position, IDENTIFIER);
    if (wordRange) {
        const word = document.getText(wordRange);
        if (GLOBAL_VARIABLE.test(word)) return { name: word, range: wordRange };
    }

    // Cursor on the quotes of getVariable ["TAG_name", default] / setVariable "TAG_name".
    const line = document.lineAt(position.line).text;
    const literal = stringLiteralAt(line, position.character);
    if (!literal || !GLOBAL_VARIABLE.test(literal.value)) return undefined;
    if (!/(?:get|set)Variable|isNil/i.test(line)) return undefined;

    return {
        name: literal.value,
        range: new vscode.Range(position.line, literal.start + 1, position.line, literal.start + 1 + literal.value.length)
    };
}

function stringLiteralAt(line: string, character: number): { value: string; start: number } | undefined {
    let index = 0;
    while (index < line.length) {
        if (line[index] !== "\"") {
            if (line[index] === "/" && line[index + 1] === "/") return undefined;
            index++;
            continue;
        }

        const start = index;
        let value = "";
        index++;
        while (index < line.length) {
            if (line[index] === "\"" && line[index + 1] === "\"") {
                value += "\"";
                index += 2;
                continue;
            }
            if (line[index] === "\"") {
                index++;
                break;
            }
            value += line[index];
            index++;
        }

        if (character > start && character <= index) return { value, start };
    }

    return undefined;
}

interface StringLiteral {
    value: string;
    start: number;
}

/**
 * Replaces `//` and block comments with spaces (newlines kept) so the text keeps its exact
 * length while comments no longer affect bracket or comma parsing. Strings are left intact.
 */
function blankComments(text: string): string {
    let result = "";
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const next = text[index + 1];

        if (inLineComment) {
            if (char === "\n") {
                inLineComment = false;
                result += char;
            } else {
                result += " ";
            }
            continue;
        }

        if (inBlockComment) {
            if (char === "*" && next === "/") {
                inBlockComment = false;
                result += "  ";
                index++;
            } else {
                result += char === "\n" ? char : " ";
            }
            continue;
        }

        if (inString) {
            result += char;
            if (char === "\"" && next === "\"") {
                result += next;
                index++;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "/" && next === "/") {
            inLineComment = true;
            result += "  ";
            index++;
            continue;
        }

        if (char === "/" && next === "*") {
            inBlockComment = true;
            result += "  ";
            index++;
            continue;
        }

        if (char === "\"") inString = true;
        result += char;
    }

    return result;
}

/**
 * Splits one line into code with strings and comments blanked out (character positions are
 * preserved) and the string literals it contains.
 */
function scanLine(line: string, state: { inBlockComment: boolean }): { code: string; strings: StringLiteral[] } {
    let code = "";
    const strings: StringLiteral[] = [];
    let index = 0;

    while (index < line.length) {
        const char = line[index];
        const next = line[index + 1];

        if (state.inBlockComment) {
            if (char === "*" && next === "/") {
                state.inBlockComment = false;
                code += "  ";
                index += 2;
                continue;
            }
            code += " ";
            index++;
            continue;
        }

        if (char === "/" && next === "/") {
            code += " ".repeat(line.length - index);
            break;
        }

        if (char === "/" && next === "*") {
            state.inBlockComment = true;
            code += "  ";
            index += 2;
            continue;
        }

        if (char !== "\"") {
            code += char;
            index++;
            continue;
        }

        const start = index;
        let value = "";
        code += " ";
        index++;
        while (index < line.length) {
            if (line[index] === "\"" && line[index + 1] === "\"") {
                value += "\"";
                code += "  ";
                index += 2;
                continue;
            }
            if (line[index] === "\"") {
                code += " ";
                index++;
                break;
            }
            value += line[index];
            code += " ";
            index++;
        }

        strings.push({ value, start });
    }

    return { code, strings };
}

/**
 * Markdown code span with a fence long enough for the text, so the content is rendered verbatim:
 * SQF names like `EOEX_var_test` contain `_`, which markdown would otherwise turn into emphasis.
 */
export function codeSpan(text: string): string {
    let fence = "`";
    while (text.includes(fence)) fence += "`";
    return `${fence}${text}${fence}`;
}

/**
 * One source line shortened for a hover: everything after the first `;` (and any trailing `//`
 * comment) is dropped, so `uiNamespace setVariable ["X", createHashMap]; // note` previews as
 * `uiNamespace setVariable ["X", createHashMap];`. The result is collapsed onto one line and cut
 * with `...` when it is still too long for the hover.
 */
export function previewCode(line: string, maxLength = MAX_PREVIEW_LENGTH): string {
    const statement = stripLineComment(line);
    const end = statementEnd(statement);
    const preview = statement.slice(0, end).trim().replace(/\s+/g, " ").replace(/`/g, "'");
    if (preview.length <= maxLength) return preview;
    return `${preview.slice(0, maxLength - 3).trimEnd()}...`;
}

/** Index just past the first `;` outside a string literal, or the line length. */
function statementEnd(line: string): number {
    let inString = false;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];

        if (inString) {
            if (char === "\"" && line[index + 1] === "\"") index++;
            else if (char === "\"") inString = false;
            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char === ";") return index + 1;
    }

    return line.length;
}

/** Removes a trailing `//` comment, ignoring `//` that appears inside a string literal. */
function stripLineComment(line: string): string {
    let inString = false;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];

        if (inString) {
            if (char === "\"" && line[index + 1] === "\"") index++;
            else if (char === "\"") inString = false;
            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char === "/" && line[index + 1] === "/") return line.slice(0, index);
    }

    return line;
}

/** `-` escaped for use inside a regular expression. */
function escapeRegExpCharacters(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSamePosition(location: vscode.Location, position: vscode.Position, uri: vscode.Uri): boolean {
    return location.uri.toString() === uri.toString() && location.range.start.line === position.line;
}

function addDefinition(index: Map<string, VariableDefinition[]>, name: string, definition: VariableDefinition): void {
    const key = name.toLowerCase();
    const existing = index.get(key);

    if (!existing) {
        index.set(key, [definition]);
        return;
    }

    if (existing.some(item => item.file === definition.file && item.line === definition.line && item.character === definition.character)) return;
    if (existing.length >= MAX_DEFINITIONS) return;
    existing.push(definition);
}

interface HeaderDocumentation {
    description: string[];
    parameters: string[];
    returns: string[];
}

/**
 * Header block labels SQF functions use, e.g. `Description:`, `Parameter(s):`, `Returns:`.
 * Anything else that looks like a label ends the current section.
 */
const HEADER_LABELS: Record<string, keyof HeaderDocumentation> = {
    description: "description",
    "parameter(s)": "parameters",
    parameters: "parameters",
    parameter: "parameters",
    params: "parameters",
    "argument(s)": "parameters",
    arguments: "parameters",
    returns: "returns",
    return: "returns",
    "return value": "returns",
    "return value(s)": "returns",
    "return values": "returns"
};

/** Labels that carry no information for the hover but must stop the previous section. */
const IGNORED_LABELS = new Set([
    "file", "author", "date", "license", "example", "examples", "link", "version", "scope",
    "dependencies", "see also", "notes", "note", "type", "usage", "syntax"
]);

const HEADER_LABEL_LINE = /^\s*([A-Za-z][A-Za-z()\s]{1,24}?)\s*:\s*(.*)$/;

/** Markdown for the hover, built from the header block or the params/_this select fallback. */
export function formatDocumentation(file: string, lines?: string[]): string {
    const content = lines ?? readLines(file);
    const header = parseHeader(content);
    const parts: string[] = [];
    const isEmpty = (section: string[]): boolean => section.length === 0 || section.every(line => line.trim() === "-");

    if (!isEmpty(header.description)) parts.push(header.description.join("\n"));

    if (!isEmpty(header.parameters)) {
        parts.push("**Parameter(s)**\n\n" + header.parameters.map(line => (/^(?:\d+\s*:|_this\b|-)/i.test(line) ? `- ${line}` : `  ${line}`)).join("\n"));
    }

    if (!isEmpty(header.returns)) {
        parts.push("**Returns**\n\n" + header.returns.join(" "));
    }

    if (parts.length === 0) {
        const fallback = describeParameters(content);
        parts.push(fallback.length > 0 ? fallback.join("\n\n") : "_No header documentation or parameter statement found._");
    }

    parts.push(`---\n\`${path.basename(file)}\``);
    return parts.join("\n\n");
}

function readLines(file: string): string[] {
    try {
        return fs.readFileSync(file, "utf8").split(/\r?\n/);
    } catch {
        return [];
    }
}

/**
 * Reads the header comment block: the first block comment before any code. Blank lines and
 * preprocessor lines (`#include`, `#define`) may precede it; the first real statement ends the
 * search, so a comment further down the file is never treated as the header.
 */
export function parseHeader(lines: string[]): HeaderDocumentation {
    const result: HeaderDocumentation = { description: [], parameters: [], returns: [] };
    let start = -1;

    for (let index = 0; index < lines.length; index++) {
        const trimmed = lines[index].trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("/*")) start = index;
        break;
    }

    if (start < 0) return result;

    const block: string[] = [];
    for (let index = start; index < lines.length; index++) {
        const line = index === start ? lines[index].slice(lines[index].indexOf("/*") + 2) : lines[index];
        const endIndex = line.indexOf("*/");
        if (endIndex >= 0) {
            block.push(line.slice(0, endIndex));
            break;
        }
        block.push(line);
    }

    let section: keyof HeaderDocumentation | undefined;
    for (const raw of block) {
        const line = raw.replace(/\s+$/, "");
        const match = HEADER_LABEL_LINE.exec(line);
        const label = match ? match[1].trim().toLowerCase() : "";

        // "0: STRING - ..." inside Parameter(s) is content, but "Return value:" style labels are
        // header sections even though they contain digits or brackets.
        const isHeaderLabel = !!match && (label in HEADER_LABELS || IGNORED_LABELS.has(label));

        if (isHeaderLabel) {
            section = HEADER_LABELS[label];
            const rest = match![2].trim();
            if (section && rest) result[section].push(rest);
            continue;
        }

        if (!line.trim()) continue;

        if (section === "parameters" && /^\s*(?:\d+\s*:|_this\b|-)/.test(line)) {
            result.parameters.push(line.trim());
            continue;
        }

        if (section) result[section].push(line.trim());
    }

    return result;
}

/**
 * Fallback when a file has no header: `params [...]`, `_x = _this select N` and
 * `_x = _this # N` describe the same interface.
 *
 * Only top-level statements count: an event handler's `params [...]` inside `{ ... }` belongs to
 * the handler, not to the function being documented.
 */
export function describeParameters(lines: string[]): string[] {
    const parts: string[] = [];
    const text = lines.join("\n");
    const scope = analyzeScope(text);

    const paramsStart = findTopLevel(text, /\bparams\s*\[/i, scope);
    if (paramsStart) {
        const open = text.indexOf("[", paramsStart.index);
        const close = matchingBracket(text, open);
        const body = close > open ? text.slice(open + 1, close) : "";
        const entries = splitTopLevel(body).map(parseParameterEntry).filter((entry): entry is ParsedParameter => !!entry);

        if (entries.length > 0) {
            parts.push("**Params**\n\n" + formatParameterList(entries));
        }
    }

    const selections = new Map<string, string>();
    const selectionPattern = /^\s*(?:private\s+)?(_[A-Za-z0-9]+)\s*=\s*_this\s+(?:select|#)\s*(\d+)/gim;
    let match: RegExpExecArray | null;
    while ((match = selectionPattern.exec(text)) !== null) {
        if (scope.depthAt[match.index] !== 0) continue;
        selections.set(match[1], match[2]);
    }

    if (selections.size > 0) {
        parts.push("**_this select/#**\n\n" + [...selections].map(([name, index]) => `- ${index}: \`${name}\``).join("\n"));
    }

    return parts;
}

interface Scope {
    /** `{` depth at each character, or -1 inside a string/comment where code cannot start. */
    depthAt: number[];
}

/**
 * Tracks curly-brace depth while skipping strings (`"a""b"`) and line/block comments, so a
 * `params` inside an event handler body is not mistaken for the function's own parameters.
 */
function analyzeScope(text: string): Scope {
    const depthAt = new Array<number>(text.length).fill(0);
    let depth = 0;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const next = text[index + 1];

        if (inLineComment) {
            depthAt[index] = -1;
            if (char === "\n") inLineComment = false;
            continue;
        }

        if (inBlockComment) {
            depthAt[index] = -1;
            if (char === "*" && next === "/") {
                depthAt[index + 1] = -1;
                inBlockComment = false;
                index++;
            }
            continue;
        }

        if (inString) {
            // SQF escapes a quote by doubling it.
            if (char === "\"" && next === "\"") {
                depthAt[index] = -1;
                depthAt[index + 1] = -1;
                index++;
                continue;
            }
            if (char === "\"") inString = false;
            depthAt[index] = -1;
            continue;
        }

        if (char === "/" && next === "/") {
            depthAt[index] = -1;
            inLineComment = true;
            index++;
            depthAt[index] = -1;
            continue;
        }

        if (char === "/" && next === "*") {
            depthAt[index] = -1;
            inBlockComment = true;
            index++;
            depthAt[index] = -1;
            continue;
        }

        if (char === "\"") {
            inString = true;
            depthAt[index] = -1;
            continue;
        }

        depthAt[index] = depth;
        if (char === "{") depth++;
        else if (char === "}") depth = Math.max(0, depth - 1);
    }

    return { depthAt };
}

function findTopLevel(text: string, pattern: RegExp, scope: Scope): RegExpExecArray | undefined {
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    const regex = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        if (scope.depthAt[match.index] === 0) return match;
    }
    return undefined;
}

/** Index of the `]` that closes the `[` at {@link open}, ignoring brackets in strings. */
function matchingBracket(text: string, open: number): number {
    let depth = 0;
    let inString = false;
    for (let index = open; index < text.length; index++) {
        const char = text[index];

        if (inString) {
            if (char === "\"" && text[index + 1] === "\"") index++;
            else if (char === "\"") inString = false;
            continue;
        }

        if (char === "\"") inString = true;
        else if (char === "[") depth++;
        else if (char === "]") {
            depth--;
            if (depth === 0) return index;
        }
    }
    return -1;
}

/** Splits an array body at commas that are not nested inside brackets or strings. */
function splitTopLevel(body: string): string[] {
    return splitTopLevelWithOffsets(body).map(part => part.text);
}

interface OffsetPart {
    text: string;
    /** Offset of this part inside the body. */
    start: number;
}

/** {@link splitTopLevel} that also reports where each part starts, for building positions. */
function splitTopLevelWithOffsets(body: string): OffsetPart[] {
    const parts: OffsetPart[] = [];
    let depth = 0;
    let inString = false;
    let start = 0;

    for (let index = 0; index < body.length; index++) {
        const char = body[index];

        if (inString) {
            if (char === "\"" && body[index + 1] === "\"") index++;
            else if (char === "\"") inString = false;
            continue;
        }

        if (char === "\"") inString = true;
        else if (char === "[" || char === "{" || char === "(") depth++;
        else if (char === "]" || char === "}" || char === ")") depth--;
        else if (char === "," && depth === 0) {
            parts.push({ text: body.slice(start, index), start });
            start = index + 1;
        }
    }

    parts.push({ text: body.slice(start), start });
    return parts.filter(part => part.text.trim().length > 0);
}

/** Offset of the first character of every line, used to turn an offset into a line/character. */
function lineStartOffsets(text: string): number[] {
    const starts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === "\n") starts.push(index + 1);
    }
    return starts;
}

/**
 * Assigns every character a scope id: the innermost `{ ... }` block it belongs to, with the file
 * scope as 0. Strings and comments are skipped, so a brace inside `"..."` or a comment does not
 * open a scope.
 */
function buildScopes(text: string): { scopeAt: number[]; parent: Map<number, number> } {
    const scopeAt = new Array<number>(text.length + 1).fill(0);
    const parent = new Map<number, number>();
    const stack = [0];
    let nextId = 1;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const next = text[index + 1];
        scopeAt[index] = stack[stack.length - 1];

        if (inLineComment) {
            if (char === "\n") inLineComment = false;
            continue;
        }

        if (inBlockComment) {
            if (char === "*" && next === "/" && index + 1 < text.length) {
                inBlockComment = false;
                index++;
                scopeAt[index] = stack[stack.length - 1];
            }
            continue;
        }

        if (inString) {
            if (char === "\"" && next === "\"" && index + 1 < text.length) {
                index++;
                scopeAt[index] = stack[stack.length - 1];
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "/" && next === "/") {
            inLineComment = true;
            continue;
        }

        if (char === "/" && next === "*") {
            inBlockComment = true;
            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char === "{") {
            const id = nextId++;
            parent.set(id, stack[stack.length - 1]);
            stack.push(id);
            continue;
        }

        if (char === "}" && stack.length > 1) stack.pop();
    }

    scopeAt[text.length] = stack[stack.length - 1];
    return { scopeAt, parent };
}

function offsetToPosition(lineStarts: number[], offset: number): { line: number; character: number } {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (lineStarts[middle] <= offset) low = middle;
        else high = middle - 1;
    }

    return { line: low, character: offset - lineStarts[low] };
}

/**
 * Representative SQF values used in a `params` type array, mapped to their `typeName` result.
 * `[[], objNull]` therefore means "ARRAY or OBJECT".
 */
const TYPE_VALUES: Array<[RegExp, string]> = [
    [/^objNull$/i, "OBJECT"],
    [/^grpNull$/i, "GROUP"],
    [/^controlNull$/i, "CONTROL"],
    [/^displayNull$/i, "DISPLAY"],
    [/^taskNull$/i, "TASK"],
    [/^locationNull$/i, "LOCATION"],
    [/^sideUnknown$/i, "SIDE"],
    [/^scriptNull$/i, "SCRIPT"],
    [/^teamMemberNull$/i, "TEAM_MEMBER"],
    [/^diaryRecordNull$/i, "DIARY_RECORD"],
    [/^netObjNull$/i, "NETOBJECT"],
    [/^(configNull|configFile)$/i, "CONFIG"],
    [/^missionNamespace$/i, "NAMESPACE"],
    [/^createHashMap$/i, "HASHMAP"],
    [/^text\s*""$/i, "TEXT"],
    [/^\[[\s\S]*\]$/, "ARRAY"],
    [/^\{[\s\S]*\}$/, "CODE"],
    [/^"/, "STRING"],
    [/^(true|false)$/i, "BOOL"],
    // `1e39` is the conventional NaN representative in a params type array.
    [/^1e\d+$/i, "NAN"],
    [/^-?\d+(\.\d+)?$/i, "SCALAR"]
];

/** `typeName` of a literal such as `[]`, `objNull` or `""`, when it can be told apart. */
function valueType(value: string): string | undefined {
    const trimmed = value.trim();
    for (const [pattern, name] of TYPE_VALUES) {
        if (pattern.test(trimmed)) return name;
    }
    return undefined;
}

/** Types declared in a `params` type array, e.g. `[[], objNull]` -> ["ARRAY", "OBJECT"]. */
function declaredTypes(field: string | undefined): string[] {
    if (!field) return [];

    const trimmed = field.trim();
    const close = trimmed.lastIndexOf("]");
    if (!trimmed.startsWith("[") || close <= 0) return [];

    const types = splitTopLevel(trimmed.slice(1, close))
        .map(valueType)
        .filter((name): name is string => !!name);

    return [...new Set(types)];
}

interface ParsedParameter {
    name: string;
    defaultValue?: string;
    types: string[];
}

/**
 * `["_name", default, [types]]` or the shorthand `"_name"` from a `params` statement.
 * The default is the text between the name and the optional type array; the third element
 * declares the accepted types.
 */
function parseParameterEntry(entry: string): ParsedParameter | undefined {
    const trimmed = entry.trim();

    const shorthand = /^"(_[A-Za-z0-9]+)"$/.exec(trimmed);
    if (shorthand) return { name: shorthand[1], types: [] };

    if (!trimmed.startsWith("[")) return undefined;

    const inner = trimmed.slice(1, trimmed.lastIndexOf("]"));
    const fields = splitTopLevel(inner);
    const named = /^\s*"(_[A-Za-z0-9]+)"\s*$/.exec(fields[0] ?? "");
    if (!named) return undefined;

    const defaultValue = fields.length > 1 ? fields[1].trim() : undefined;
    return {
        name: named[1],
        defaultValue: defaultValue === "" ? undefined : defaultValue,
        types: declaredTypes(fields[2])
    };
}

/**
 * `params` list for a hover, rendered inside a fenced SQF block so the names, defaults and types
 * get SQF syntax coloring. Columns are `#`, Name, Default and Type, left-aligned and separated by
 * a fixed gap (a markdown table auto-sizes its columns, which pushed Type to the right edge).
 * The Default and Type columns are left out when no entry has one.
 */
export function formatParameterList(entries: ParsedParameter[]): string {
    const rows = entries.map((entry, index) => ({
        index: String(index),
        name: entry.name,
        value: entry.defaultValue ?? "",
        type: entry.types.join(" or ")
    }));

    const showDefault = rows.some(row => row.value.length > 0);
    const showType = rows.some(row => row.type.length > 0);

    const indexWidth = Math.max(...rows.map(row => row.index.length));
    // Include the header label so `Default`/`Type` never overflow their column.
    const nameWidth = Math.max("Name".length, ...rows.map(row => row.name.length));
    const valueWidth = showDefault ? Math.max("Default".length, ...rows.map(row => row.value.length)) : 0;

    // A fixed gap keeps the columns visibly apart (`_target` and `[0, 0, 0]` were touching).
    const gap = "    ";

    const line = (index: string, name: string, value: string, type: string): string => {
        const cells = [index.padEnd(indexWidth), name.padEnd(nameWidth)];
        if (showDefault) cells.push(value.padEnd(valueWidth));
        if (showType) cells.push(type);
        return cells.join(gap).trimEnd();
    };

    const header = line("", "Name", "Default", "Type");
    const body = rows.map(row => line(row.index, row.name, row.value, row.type));

    return ["```sqf", `// ${header}`, ...body, "```"].join("\n");
}
