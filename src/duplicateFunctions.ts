import * as path from "path";
import * as vscode from "vscode";
import { deletedFunctionVariable, findDuplicateFunctionFiles } from "./reload";
import { logError } from "./settings";

/**
 * Marks every `fn_*.sqf` file that resolves to the same Arma function variable as an error in the
 * Problems panel and blocks the reload.
 *
 * Two files can derive the same `TAG_fnc_name` (a copy next to the original, a renamed folder,
 * a leftover from a refactor). SqfReloader would then compile one of them at random, so the
 * conflict is reported instead of silently picking a winner.
 */
export class DuplicateFunctionDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection("sqfReloader-functions");
    /** Lower-cased function variable -> the files currently reported for it. */
    private readonly groups = new Map<string, Map<string, string>>();

    /**
     * Re-checks the given files. Returns the lower-cased function variables that are still in
     * conflict, so a save handler can skip the reload without another filesystem scan.
     */
    async update(filePaths: string[], showWarning: boolean): Promise<Set<string>> {
        const variables = new Map<string, string>();
        for (const filePath of filePaths) {
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

    dispose(): void {
        this.groups.clear();
        this.collection.dispose();
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
