// Minimal stand-in for the "vscode" module so extension modules can be loaded by plain
// Node scripts (used by scripts/verify-extension.js). Only what the tested code touches.
"use strict";

module.exports = {
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
        activeTextEditor: undefined,
        createStatusBarItem: () => ({
            show: () => undefined,
            dispose: () => undefined
        })
    },
    workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        workspaceFolders: [],
        onDidSaveTextDocument: () => ({ dispose: () => undefined }),
        onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
        onDidChangeConfiguration: () => ({ dispose: () => undefined })
    },
    commands: {
        registerCommand: () => ({ dispose: () => undefined }),
        executeCommand: () => Promise.resolve(undefined)
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
