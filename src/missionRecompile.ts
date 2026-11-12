import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./settings";

/**
 * Enables `allowFunctionsRecompile = 1` in a mission's description.ext, which Arma needs before a
 * mission function can be recompiled at runtime.
 */

export async function confirmMissionFunctionRecompile(missionDirectory: string): Promise<boolean> {
    const descriptionPath = path.join(missionDirectory, "description.ext");
    const descriptionUri = vscode.Uri.file(descriptionPath);
    let descriptionDocument: vscode.TextDocument | undefined;

    try {
        if (fs.existsSync(descriptionPath)) {
            descriptionDocument = await vscode.workspace.openTextDocument(descriptionUri);
        }
        const source = descriptionDocument?.getText() ?? "";
        const masked = maskConfigComments(source);
        const setting = /^[ \t]*allowFunctionsRecompile\s*=\s*([^;]+);/im.exec(masked);
        if (setting && Number(setting[1].trim()) === 1) return true;

        const answer = await vscode.window.showWarningMessage(
            `Live function reload requires allowFunctionsRecompile = 1 in ${path.basename(missionDirectory)}\\description.ext. Enable it now?`,
            { modal: true },
            "Yes, enable",
            "No, continue"
        );
        if (answer === "No, continue") return true;
        if (answer !== "Yes, enable") return false;

        let updated: string;
        if (setting) {
            const start = setting.index;
            const originalMatch = /^[ \t]*allowFunctionsRecompile\s*=\s*[^;]+;/im.exec(source.slice(start));
            if (!originalMatch) throw new Error("Could not update allowFunctionsRecompile in description.ext.");
            const leadingSpace = /^[ \t]*/.exec(originalMatch[0])?.[0] ?? "";
            updated = source.slice(0, start) + `${leadingSpace}allowFunctionsRecompile = 1;` + source.slice(start + originalMatch[0].length);
        } else {
            updated = `${source}${source.length > 0 && !/[\r\n]$/.test(source) ? "\r\n" : ""}allowFunctionsRecompile = 1;\r\n`;
        }

        if (descriptionDocument) {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(descriptionUri, new vscode.Range(descriptionDocument.positionAt(0), descriptionDocument.positionAt(descriptionDocument.getText().length)), updated);
            if (!(await vscode.workspace.applyEdit(edit)) || !(await descriptionDocument.save())) {
                throw new Error("VS Code could not save the updated description.ext.");
            }
        } else {
            await vscode.workspace.fs.writeFile(descriptionUri, Buffer.from(updated, "utf8"));
        }

        log(`Enabled allowFunctionsRecompile in ${descriptionPath}.`);
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Could not enable live function reload: ${message}`);
        return false;
    }
}

function maskConfigComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\r\n]/g, " "))
        .replace(/^\s*\/\/.*$/gm, match => match.replace(/[^\r\n]/g, " "));
}
