import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { deletedFunctionVariable, findDuplicateFunctionFiles } from "./reload";
import { logError } from "./settings";
import { isExcludedPath } from "./excludedFolders";
import { projectSettingsExists } from "./projectSettings";

/**
 * How often the markers are checked against the file system again. A publish script, a git
 * operation or another editor changes files without a VS Code save/delete event, and a marker
 * that is no longer true keeps blocking the reload for no reason.
 */
const RECHECK_INTERVAL_MS = 15_000;

/** `fn_*.sqf` files that define an Arma function (the only files that can conflict). */
const FUNCTION_FILE = /^fn_[\w-]+\.sqf$/i;

/**
 * Marks every `fn_*.sqf` file that resolves to the same Arma function variable as an error in the
 * Problems panel and blocks the reload.
 *
 * Two files can derive the same `TAG_fnc_name` (a copy next to the original, a renamed folder,
 * a leftover from a refactor). SqfReloader would then compile one of them at random, so the
 * conflict is reported instead of silently picking a winner.
 *
 * The markers are re-validated on create/delete events and on a timer, so a conflict clears
 * itself as soon as one of the two files is gone, without saving anything.
 */
export class DuplicateFunctionDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection("sqfReloader-functions");
    /** Lower-cased function variable -> the files currently reported for it. */
    private readonly groups = new Map<string, Map<string, string>>();
    private readonly disposables: vscode.Disposable[] = [];
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher("**/fn_*.sqf");
        const recheck = (uri: vscode.Uri): void => this.scheduleRecheck([uri.fsPath]);

        // Saves are covered by the save handler; create/delete covers files that other tools add
        // or remove (a publish script copying or cleaning the mod) and never reach a save event.
        this.disposables.push(
            watcher,
            watcher.onDidCreate(recheck),
            watcher.onDidDelete(recheck)
        );

        this.timer = setInterval(() => this.scheduleRecheck([]), RECHECK_INTERVAL_MS);
        this.timer.unref?.();
    }

    /**
     * Re-checks the given files. Returns the lower-cased function variables that are still in
     * conflict, so a save handler can skip the reload without another filesystem scan.
     */
    async update(filePaths: string[], showWarning: boolean): Promise<Set<string>> {
        const variables = new Map<string, string>();
        for (const filePath of filePaths) {
            if (isExcludedPath(filePath)) {
                // A folder that was just excluded keeps its earlier markers until they are cleared.
                this.collection.delete(vscode.Uri.file(filePath));
                continue;
            }

            if (!isConfiguredFile(filePath)) continue;

            const variable = deletedFunctionVariable(filePath);
            if (variable) variables.set(variable.toLowerCase(), filePath);
        }

        const conflicts = new Set<string>();
        for (const [key, filePath] of variables) {
            const previousFiles = this.groups.get(key);
            for (const previousFile of previousFiles?.values() ?? []) {
                this.collection.delete(vscode.Uri.file(previousFile));
            }
            this.groups.delete(key);

            const duplicate = findDuplicateFunctionFiles(filePath);
            if (!duplicate) continue;

            conflicts.add(key);
            const files = new Map(duplicate.files.map(file => [path.resolve(file).toLowerCase(), file]));
            this.groups.set(key, files);
            for (const duplicateFile of duplicate.files) {
                await this.report(duplicate.variable, duplicateFile);
            }

            const changed = !previousFiles || previousFiles.size !== files.size
                || [...files.keys()].some(file => !previousFiles.has(file));
            if (showWarning && changed) {
                void vscode.window.showWarningMessage(
                    `Function variable '${duplicate.variable}' is defined by multiple files. Arma reload is blocked; see the Problems panel.`
                );
            }
        }

        return conflicts;
    }

    /**
     * Re-validates every reported conflict plus `extraFiles` (a file that was just created or
     * deleted) and the open function files, so a conflict appears and disappears on its own.
     */
    async revalidate(extraFiles: string[] = []): Promise<void> {
        const files = new Set<string>(extraFiles);
        for (const group of this.groups.values()) {
            for (const file of group.values()) files.add(file);
        }

        for (const document of vscode.workspace.textDocuments) {
            if (document.uri.scheme === "file" && FUNCTION_FILE.test(path.basename(document.fileName))) {
                files.add(document.fileName);
            }
        }

        if (files.size === 0) return;

        // A file that no longer exists cannot conflict, and no later save touches it, so its
        // marker would stay forever.
        for (const file of files) {
            if (!fs.existsSync(file)) this.collection.delete(vscode.Uri.file(file));
        }

        await this.update([...files], false);
    }

    /**
     * Drops the markers of every file that now lies in an excluded folder, so adding an entry to
     * `excludedFolders` unblocks the reload without waiting for the next save of that file.
     */
    clearExcluded(): void {
        const stale: vscode.Uri[] = [];
        this.collection.forEach(uri => {
            if (isExcludedPath(uri.fsPath)) stale.push(uri);
        });
        for (const uri of stale) this.collection.delete(uri);

        for (const [key, files] of [...this.groups]) {
            if ([...files.values()].every(file => isExcludedPath(file))) this.groups.delete(key);
        }
    }

    dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }

        for (const disposable of this.disposables) disposable.dispose();
        this.disposables.length = 0;

        this.groups.clear();
        this.collection.dispose();
    }

    private scheduleRecheck(filePaths: string[]): void {
        void this.revalidate(filePaths).catch(error => logError("could not re-check duplicate function files", error));
    }

    private async report(variable: string, duplicateFile: string): Promise<void> {
        try {
            const uri = vscode.Uri.file(duplicateFile);
            const resolved = path.resolve(duplicateFile).toLowerCase();
            const document = vscode.workspace.textDocuments.find(open => path.resolve(open.uri.fsPath).toLowerCase() === resolved)
                ?? await vscode.workspace.openTextDocument(uri);
            const lastLine = Math.max(0, document.lineCount - 1);
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, document.lineAt(lastLine).text.length)),
                `Function variable '${variable}' is defined by multiple files. Rename or remove one definition; reload is blocked.`,
                vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = "SqfReloader";
            this.collection.set(uri, [diagnostic]);
        } catch (error) {
            logError(`could not mark duplicate function file ${duplicateFile}`, error);
        }
    }
}

/** Only files inside a workspace folder that has project settings are SqfReloader's business. */
function isConfiguredFile(filePath: string): boolean {
    const resolved = path.resolve(filePath).toLowerCase();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const root = path.resolve(folder.uri.fsPath).toLowerCase();
        if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
        if (projectSettingsExists(folder)) return true;
    }

    return false;
}
