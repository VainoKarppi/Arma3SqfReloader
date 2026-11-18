// Minimal stand-in for the "vscode" module so extension modules can be loaded by plain
// Node scripts (used by scripts/verify-extension.js). Only what the tested code touches.
"use strict";

// UI calls recorded so scripts can assert what the extension opened (see verify-template.js).
const calls = { showTextDocument: [], executeCommand: [] };

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class Range {
    constructor(start, end) {
        // Both VS Code forms: (start, end) positions, or (startLine, startChar, endLine, endChar).
        if (typeof start === "number") {
            this.start = new Position(start, end);
            this.end = new Position(arguments[2], arguments[3]);
        } else {
            this.start = start;
            this.end = end;
        }
    }
}

/** Records the edits a provider produces, so a script can assert what would be replaced. */
class WorkspaceEdit {
    constructor() {
        this.edits = [];
    }

    replace(uri, range, text) {
        this.edits.push({ uri, range, text });
    }

    insert(uri, position, text) {
        this.edits.push({ uri, range: new Range(position, position), text });
    }
}

module.exports = {
    calls,
    version: "0.0.0-stub",
    Position,
    Range,
    WorkspaceEdit,
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            dispose: () => undefined
        }),
        showWarningMessage: () => Promise.resolve(undefined),
        showErrorMessage: () => Promise.resolve(undefined),
        showInformationMessage: () => Promise.resolve(undefined),
        showOpenDialog: () => Promise.resolve(undefined),
        showTextDocument: (document, options) => {
            calls.showTextDocument.push({ document, options });
            return Promise.resolve({});
        },
        activeTextEditor: undefined,
        createStatusBarItem: () => ({
            show: () => undefined,
            dispose: () => undefined
        })
    },
    workspace: {
        getConfiguration: () => ({
            get: (_key, fallback) => fallback,
            update: () => Promise.resolve(undefined)
        }),
        workspaceFolders: [],
        isTrusted: true,
        openTextDocument: () => Promise.resolve({}),
        createFileSystemWatcher: () => ({
            onDidChange: () => ({ dispose: () => undefined }),
            onDidCreate: () => ({ dispose: () => undefined }),
            onDidDelete: () => ({ dispose: () => undefined }),
            dispose: () => undefined
        }),
        onDidSaveTextDocument: () => ({ dispose: () => undefined }),
        onDidChangeTextDocument: () => ({ dispose: () => undefined }),
        onDidCloseTextDocument: () => ({ dispose: () => undefined }),
        onDidOpenTextDocument: () => ({ dispose: () => undefined }),
        onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
        onDidChangeConfiguration: () => ({ dispose: () => undefined })
    },
    commands: {
        registerCommand: () => ({ dispose: () => undefined }),
        executeCommand: (command, ...args) => {
            calls.executeCommand.push({ command, args });
            return Promise.resolve(undefined);
        }
    },
    Uri: {
        file: fsPath => ({ fsPath })
    },
    env: {
        openExternal: () => Promise.resolve(true),
        appName: "Visual Studio Code",
        language: "en",
        remoteName: undefined,
        clipboard: { writeText: () => Promise.resolve(undefined) }
    },
    ProgressLocation: {
        Notification: 15
    },
    StatusBarAlignment: {
        Left: 1
    },
    ThemeColor: class {
        constructor(id) {
            this.id = id;
        }
    },
    ConfigurationTarget: {
        Global: 1
    }
};
