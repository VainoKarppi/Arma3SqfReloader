// Minimal stand-in for the "vscode" module so extension modules can be loaded by plain
// Node scripts (used by scripts/verify-extension.js). Only what the tested code touches.
"use strict";

// UI calls recorded so scripts can assert what the extension opened (see verify-template.js).
const calls = { showTextDocument: [], executeCommand: [] };

module.exports = {
    calls,
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
        openTextDocument: () => Promise.resolve({}),
        createFileSystemWatcher: () => ({
            onDidChange: () => ({ dispose: () => undefined }),
            onDidCreate: () => ({ dispose: () => undefined }),
            onDidDelete: () => ({ dispose: () => undefined }),
            dispose: () => undefined
        }),
        onDidSaveTextDocument: () => ({ dispose: () => undefined }),
        onDidChangeTextDocument: () => ({ dispose: () => undefined }),
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
        openExternal: () => Promise.resolve(true)
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
