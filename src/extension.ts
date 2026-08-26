import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

interface CommandBody {
    type: "recompile";
    method: string;
    code: string;
}

const output = vscode.window.createOutputChannel(
    "Arma 3 SQF Reloader"
);

export function activate(context: vscode.ExtensionContext) {
    const version = context.extension.packageJSON.version;

    log(
        `Extension activated. Version: ${version}`
    );

    const saveDisposable = vscode.workspace.onDidSaveTextDocument(
        async document => {
            log(`File saved: ${document.fileName}`);

            if (!isSqfFile(document)) {
                log("Ignoring file: not an SQF file.");
                return;
            }

            log("File is an SQF file.");

            const config = vscode.workspace.getConfiguration(
                "arma3SqfReloader"
            );

            const enabled = config.get<boolean>(
                "enabled",
                true
            );

            log(`Extension enabled: ${enabled}`);

            if (!enabled) {
                log("Ignoring save: extension is disabled.");
                return;
            }

            try {
                await sendSqfFunction(document);
            } catch (error) {
                const message = error instanceof Error
                    ? error.message
                    : String(error);

                log(`ERROR: ${message}`);

                vscode.window.showErrorMessage(
                    `Arma 3 SQF Reloader: ${message}`
                );
            }
        }
    );

    context.subscriptions.push(saveDisposable);
    context.subscriptions.push(output);

    log("Save event handler registered.");
}

export function deactivate() {
    log("Extension deactivated.");
}

function log(message: string): void {
    const timestamp = new Date().toLocaleTimeString();

    output.appendLine(
        `[${timestamp}] ${message}`
    );
}

function isSqfFile(
    document: vscode.TextDocument
): boolean {
    return document.uri.scheme === "file" &&
        path.extname(document.fileName).toLowerCase() === ".sqf";
}

async function sendSqfFunction(
    document: vscode.TextDocument
): Promise<void> {
    const sqfPath = document.fileName;

    log(`Processing SQF file: ${sqfPath}`);

    const fileName = path.basename(sqfPath);

    log(`File name: ${fileName}`);

    // Only fn_*.sqf files are considered functions.
    if (!fileName.startsWith("fn_")) {
        log(
            `Ignoring file: "${fileName}" does not start with "fn_".`
        );
        return;
    }

    if (!fileName.toLowerCase().endsWith(".sqf")) {
        log(
            `Ignoring file: "${fileName}" does not end with ".sqf".`
        );
        return;
    }

    /*
     * Example:
     *
     * fn_test.sqf
     *
     * becomes:
     *
     * test
     */
    const functionName = fileName.slice(3, -4);

    log(`Function name: ${functionName}`);

    if (!functionName) {
        log("Ignoring file: function name is empty.");
        return;
    }

    /*
     * Find the first $PBOPREFIX$ while walking upwards
     * from the directory containing the SQF file.
     *
     * Example:
     *
     * C:\...\addons\functions\extension\fn_test.sqf
     *                                  ↑
     *                                  start here
     *
     * C:\...\addons\functions\$PBOPREFIX$
     *
     * containing:
     *
     * z\eoex\addons\functions
     *
     * produces:
     *
     * \z\eoex\addons\functions\extension\fn_test.sqf
     */
    const armaFilePath = await createArmaFilePath(
        sqfPath
    );

    log(`Generated Arma file path: ${armaFilePath}`);

    const code = document.getText();

    log(`SQF code length: ${code.length} characters`);

    const body: CommandBody = {
        type: "recompile",
        method: armaFilePath,
        code
    };

    const config = vscode.workspace.getConfiguration(
        "arma3SqfReloader"
    );

    const url = config.get<string>(
        "url",
        "http://127.0.0.1:8765/api/command"
    );

    log(`API URL: ${url}`);

    log(`Sending function file: ${armaFilePath}`);

    try {
        await postCommand(url, body);
        log(`Successfully sent function file: ${armaFilePath}`);
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : String(error);

        log(`ERROR: ${armaFilePath} - ${message}`);
    }
    
}

async function createArmaFilePath(
    filePath: string
): Promise<string> {

    const absoluteFilePath = path.resolve(filePath);

    let currentDirectory = path.dirname(
        absoluteFilePath
    );

    while (true) {
        const pboPrefixPath = path.join(
            currentDirectory,
            "$PBOPREFIX$"
        );

        log(
            `Checking for $PBOPREFIX$: ${pboPrefixPath}`
        );

        try {
            const stat = await fs.stat(
                pboPrefixPath
            );

            if (stat.isFile()) {
                const prefix = (
                    await fs.readFile(
                        pboPrefixPath,
                        "utf8"
                    )
                ).trim();

                if (!prefix) {
                    throw new Error(
                        `$PBOPREFIX$ is empty: ${pboPrefixPath}`
                    );
                }

                log(
                    `Found $PBOPREFIX$: ${prefix}`
                );

                /*
                 * Normalize the prefix:
                 *
                 * z/eoex/addons/functions
                 *
                 * becomes:
                 *
                 * z\eoex\addons\functions
                 */
                const normalizedPrefix = prefix
                    .replace(/\//g, "\\")
                    .replace(/^\\+/, "")
                    .replace(/\\+$/, "");

                /*
                 * Get the path from the directory containing
                 * $PBOPREFIX$ to the SQF file.
                 *
                 * Example:
                 *
                 * $PBOPREFIX$ directory:
                 * C:\...\addons\functions
                 *
                 * SQF:
                 * C:\...\addons\functions\extension\fn_test.sqf
                 *
                 * Result:
                 * extension\fn_test.sqf
                 */
                const relativePath = path.relative(
                    currentDirectory,
                    absoluteFilePath
                );

                const normalizedRelativePath =
                    relativePath
                        .replace(/\//g, "\\")
                        .replace(/^\\+/, "")
                        .replace(/\\+$/, "");

                const armaPath = [
                    normalizedPrefix,
                    normalizedRelativePath
                ]
                    .filter(Boolean)
                    .join("\\");

                return `\\${armaPath}`;
            }
        } catch (error) {
            /*
             * Re-throw actual errors, but continue searching
             * when $PBOPREFIX$ simply does not exist.
             */
            if (
                error instanceof Error &&
                error.message.startsWith(
                    "$PBOPREFIX$ is empty"
                )
            ) {
                throw error;
            }
        }

        const parentDirectory = path.dirname(
            currentDirectory
        );

        if (
            parentDirectory === currentDirectory
        ) {
            /*
             * No $PBOPREFIX$ was found.
             *
             * Default to:
             *
             * \z\<filename>
             */
            const fileName = path.basename(
                absoluteFilePath
            );

            log(
                "No $PBOPREFIX$ found. " +
                `Using fallback prefix: \\z`
            );

            return `\\z\\${fileName}`;
        }

        currentDirectory = parentDirectory;
    }
}

async function postCommand(
    url: string,
    body: CommandBody
): Promise<void> {

    log(`POST ${url}`);

    log(
        `Request method: ${body.method}`
    );

    log(
        `Request code length: ${body.code.length} characters`
    );

    const response = await fetch(
        url,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        }
    );

    log(
        `API response: HTTP ${response.status} ${response.statusText}`
    );

    if (!response.ok) {
        const responseText = await response.text();

        log(
            `API error response: ${responseText}`
        );

        throw new Error(
            `API returned HTTP ${response.status}` +
            (responseText
                ? `: ${responseText}`
                : "")
        );
    }

    log("API request completed successfully.");
}