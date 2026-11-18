import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { getStatus } from "./api";
import { findMissions } from "./arma";
import { findArmaDirectory } from "./armaDetect";
import { hasAuthenticodeSignature, readSmartAppControlState } from "./dllIntegrity";
import { refreshDedicatedServerStatus, refreshRunningStatus, trackedArmaPid } from "./launcher";
import { modTypeForDirectory } from "./modTypes";
import { isPortFree, parseApiUrl } from "./ports";
import { selectArmaProfile, ArmaProfileSelection } from "./profile";
import { projectSettingsPath, readProjectSettings } from "./projectSettings";
import { armaLogDirectory, findLatestRptPath, readRptTail } from "./rpt";
import { currentApiPort, runtimeDirectory, verifyWorkspaceAddons, workspaceAddons, workspaceMods } from "./runtime";
import { log, recentLogLines, readSettings, Settings } from "./settings";

/*
 * "SqfReloader: Create diagnostic report" writes one plain-text file that a bug report can be
 * attached to: extension/VS Code/OS versions, the detected Arma installation, the deployed
 * SqfReloader DLL (hash + code-integrity state), the API, the workspace links and the recent
 * Arma/extension errors.
 *
 * Everything personally identifying is replaced before the file is written: the user name,
 * the computer name, the Arma profile name and every `C:\Users\<name>` folder. A report can
 * therefore be pasted into a public issue without editing.
 */

/** Where the report and the DLL's config.json live (both under %LOCALAPPDATA%). */
export function diagnosticDirectory(): string {
    const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(safeHome() ?? ".", "AppData", "Local");
    return path.join(localAppData, "SqfReloader");
}

export function diagnosticReportPath(): string {
    return path.join(diagnosticDirectory(), "diagnostic.txt");
}

export interface PathRedaction {
    value: string;
    label: string;
}

export interface WordRedaction {
    value: string;
    label: string;
}

export interface RedactionTargets {
    /** Folder paths replaced by an environment-variable token; the longest path is applied first. */
    paths: PathRedaction[];
    /** Whole words replaced by a placeholder: user name, computer name, Arma profile. */
    words: WordRedaction[];
}

export interface DiagnosticSection {
    title: string;
    lines: string[];
}

/**
 * Machine-specific strings for {@link redactPersonalInfo}. `extraWords` carries names that only
 * the caller knows (the configured Arma profile), because they appear in profile paths and logs.
 */
export function defaultRedactionTargets(extraWords: string[] = []): RedactionTargets {
    const home = safeHome();
    const localAppData = firstNonEmpty(process.env.LOCALAPPDATA, home ? path.join(home, "AppData", "Local") : undefined);
    const appData = process.env.APPDATA?.trim();
    const temp = firstNonEmpty(process.env.TEMP, process.env.TMP);

    const paths: PathRedaction[] = [];
    const addPath = (value: string | undefined, label: string): void => {
        const trimmed = value?.trim().replace(/[\\/]+$/, "");
        // A root such as "C:\" would replace every drive letter in the report.
        if (trimmed && trimmed.length > 3) paths.push({ value: trimmed, label });
    };

    addPath(localAppData, "%LOCALAPPDATA%");
    addPath(appData, "%APPDATA%");
    addPath(temp, "%TEMP%");
    addPath(home ? path.join(home, "Documents") : undefined, "%USERPROFILE%\\Documents");
    addPath(home, "%USERPROFILE%");

    const words: WordRedaction[] = [];
    const addWord = (value: string | undefined, label: string): void => {
        const trimmed = value?.trim();
        // One- and two-letter names ("a", "me") would mangle ordinary words in the report.
        if (trimmed && trimmed.length >= 3) words.push({ value: trimmed, label });
    };

    addWord(process.env.COMPUTERNAME, "<computer>");
    addWord(os.hostname(), "<computer>");
    addWord(process.env.USERNAME, "<user>");
    addWord(safeUserName(), "<user>");
    for (const word of extraWords) addWord(word, "<profile>");

    return {
        paths: uniqueBy(paths, entry => entry.value.toLowerCase()).sort((left, right) => right.value.length - left.value.length),
        words: uniqueBy(words, entry => entry.value.toLowerCase()).sort((left, right) => right.value.length - left.value.length)
    };
}

/**
 * Removes personal data from a report fragment.
 *
 * Paths are replaced before words so a home folder becomes `%USERPROFILE%` instead of
 * `C:\Users\<user>`, and any *other* account's folder (`C:\Users\someone\...`) is normalised to
 * the same placeholder. Non-loopback IPv4 addresses are dropped as well: a local API never needs
 * them.
 */
export function redactPersonalInfo(text: string, targets: RedactionTargets = defaultRedactionTargets()): string {
    let result = text;

    // Longest path first: %LOCALAPPDATA% has to win over the %USERPROFILE% prefix above it.
    for (const entry of [...targets.paths].sort((left, right) => right.value.length - left.value.length)) {
        result = replacePath(result, entry.value, entry.label);
    }

    // Any remaining user folder, on any drive and with either separator. A JSON-embedded path
    // arrives with doubled separators ("C:\\Users\\name"), which the "+" covers.
    result = result.replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"',;]+/gi, match => `${match.slice(0, 2)}\\Users\\<user>`);

    result = result.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, match => (match.startsWith("127.") || match === "0.0.0.0" ? match : "<ip>"));

    for (const entry of [...targets.words].sort((left, right) => right.value.length - left.value.length)) {
        result = result.replace(new RegExp(`\\b${escapeRegExp(entry.value)}\\b`, "gi"), entry.label);
    }

    return result;
}

/** Joins header and sections, then redacts the whole report in one pass. */
export function formatDiagnosticReport(header: string[], sections: DiagnosticSection[], targets: RedactionTargets): string {
    const lines: string[] = [
        "============================================================",
        "SqfReloader diagnostic report",
        ...header,
        "============================================================",
        ""
    ];

    for (const section of sections) {
        lines.push(`=== ${section.title} ===`, ...section.lines, "");
    }

    lines.push("=== End of report ===");
    return redactPersonalInfo(`${lines.join(os.EOL)}${os.EOL}`, targets);
}

/** Writes the report (already redacted) and returns its path. A BOM keeps old Windows tools
 *  (Notepad, Windows PowerShell's Get-Content) from misreading the UTF-8 text. */
export function writeDiagnosticReportFile(report: string): string {
    const file = diagnosticReportPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `\ufeff${report}`, "utf8");
    return file;
}

/** Command handler: confirm, collect, write, and open the folder so the file can be attached. */
export async function createDiagnosticReport(context: vscode.ExtensionContext): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
        "Create a diagnostic report for troubleshooting? It is written to %LOCALAPPDATA%\\SqfReloader\\diagnostic.txt. "
        + "Your user name, computer name and personal folder paths are replaced before the file is written.",
        "Create report",
        "Cancel"
    );

    if (choice !== "Create report") {
        return;
    }

    const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Collecting SqfReloader diagnostics..." },
        () => collectDiagnosticReport(context)
    );

    const file = writeDiagnosticReportFile(report);
    log(`Diagnostic report written to ${file}.`);

    await vscode.env.openExternal(vscode.Uri.file(diagnosticDirectory()));

    const action = await vscode.window.showInformationMessage(
        `SqfReloader diagnostic report saved to %LOCALAPPDATA%\\SqfReloader\\${path.basename(file)}.`,
        "Open report",
        "Copy path"
    );

    if (action === "Open report") {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(document);
    } else if (action === "Copy path") {
        await vscode.env.clipboard.writeText(file);
    }
}

/** Collects every section and returns the redacted report text. A failing probe is reported as
 *  text in its section instead of aborting the report. */
export async function collectDiagnosticReport(context: vscode.ExtensionContext): Promise<string> {
    const settings = readSettings();
    const configuredDirectory = settings.armaDirectory;
    const armaDirectory = await findArmaDirectory(settings);
    const armaExecutable = armaDirectory ? path.join(armaDirectory, "arma3_x64.exe") : undefined;
    const armaProfile = armaDirectory
        ? safeProfile(armaDirectory, settings)
        : undefined;

    const [machine, clientRunning, serverRunning, apiLines, rptLines] = await Promise.all([
        readMachineFacts(armaExecutable),
        refreshRunningStatus().catch(() => false),
        refreshDedicatedServerStatus().catch(() => false),
        readApiFacts(settings),
        readRptFacts()
    ]);

    const sections: DiagnosticSection[] = [
        { title: "System", lines: systemLines(machine) },
        { title: "VS Code", lines: vsCodeLines(context) },
        { title: "Arma 3 installation", lines: armaLines(settings, armaDirectory, configuredDirectory, armaProfile, machine) },
        { title: "SqfReloader runtime", lines: await runtimeLines(context, armaDirectory) },
        { title: "SqfReloader API", lines: apiLines },
        { title: "Processes", lines: processLines(clientRunning, serverRunning) },
        { title: "Workspace", lines: workspaceLines(armaDirectory) },
        { title: "Arma 3 logs", lines: rptLines },
        { title: "Visual C++ redistributables", lines: machine.vcpp.length > 0 ? machine.vcpp : [machine.error ? `Unavailable: ${machine.error}` : "None found."] },
        {
            title: "Recent Windows application errors",
            lines: machine.applicationErrors.length > 0
                ? machine.applicationErrors
                : [machine.error ? `Unavailable: ${machine.error}` : "No error events found."]
        },
        { title: "Extension log", lines: extensionLogLines() }
    ];

    const targets = defaultRedactionTargets([settings.armaProfile, armaProfile?.launchName ?? ""].filter(Boolean));
    return formatDiagnosticReport(reportHeader(context), sections, targets);
}

function reportHeader(context: vscode.ExtensionContext): string[] {
    const version = (context.extension.packageJSON as { version?: string }).version ?? "unknown";
    const env = vscode.env;
    const remote = env.remoteName ? `, remote: ${env.remoteName}` : "";

    return [
        `Generated: ${formatDate(new Date())}`,
        `Extension: Arma 3 SQF Reloader ${version}`,
        `VS Code: ${vscode.version} (${env.appName}, ${env.language}${remote})`,
        `Platform: ${process.platform} ${process.arch} · ${os.version()}`,
        `Report file: ${diagnosticReportPath()}`,
        "",
        "Personal information (user name, computer name, other user folders) is replaced with <user>,",
        "<computer> and %USERPROFILE% before this file is written."
    ];
}

function systemLines(machine: MachineFacts): string[] {
    const cpus = os.cpus();
    const lines = [
        `OS: ${os.type()} ${os.release()} (${os.version()})`,
        `Architecture: ${process.arch} (${os.arch()})`,
        `Node.js: ${process.versions.node} · Electron: ${process.versions.electron ?? "n/a"}`,
        `CPU: ${cpus[0]?.model ?? "unknown"} (${cpus.length} logical processors)`,
        `Memory: ${formatBytes(os.totalmem())}`,
        `Locale: ${Intl.DateTimeFormat().resolvedOptions().locale}`
    ];

    if (machine.error) {
        lines.push(`Windows details unavailable: ${machine.error}`);
        return lines;
    }

    if (machine.osCaption) lines.push(`Windows: ${machine.osCaption} ${machine.osVersion ?? ""} (build ${machine.osBuild ?? "?"})`);
    if (machine.osArchitecture) lines.push(`Windows architecture: ${machine.osArchitecture}`);
    if (machine.systemType) lines.push(`System type: ${machine.systemType}`);
    if (machine.manufacturer || machine.model) lines.push(`Model: ${[machine.manufacturer, machine.model].filter(Boolean).join(" ")}`);
    if (machine.ramGb !== undefined) lines.push(`Physical memory: ${machine.ramGb} GB`);
    if (machine.cpu && !cpus[0]) lines.push(`CPU: ${machine.cpu}`);
    if (machine.physicalCores !== undefined) lines.push(`CPU cores: ${machine.physicalCores} physical / ${machine.logicalCores ?? "?"} logical`);

    return lines;
}

function vsCodeLines(context: vscode.ExtensionContext): string[] {
    const env = vscode.env;
    return [
        `Version: ${vscode.version}`,
        `Application: ${env.appName}`,
        `Language: ${env.language}`,
        `Remote: ${env.remoteName ?? "none"}`,
        `Extension folder: ${context.extensionPath}`,
        `Extension host process: ${process.execPath}`
    ];
}

function armaLines(
    settings: Settings,
    armaDirectory: string | undefined,
    configuredDirectory: string,
    profile: ArmaProfileSelection | undefined,
    machine: MachineFacts
): string[] {
    if (!armaDirectory) {
        return [
            "Arma 3 folder: NOT FOUND",
            configuredDirectory
                ? `Configured armaDirectory: ${configuredDirectory} (no arma3_x64.exe there)`
                : "Configured armaDirectory: empty (automatic registry/Steam detection)",
            "Set armaDirectory in .vscode/sqfReloader-settings.json if detection failed."
        ];
    }

    const configured = configuredDirectory && path.resolve(configuredDirectory).toLowerCase() === path.resolve(armaDirectory).toLowerCase();
    const executable = path.join(armaDirectory, "arma3_x64.exe");
    const serverExecutable = path.join(armaDirectory, "arma3server_x64.exe");
    const lines = [
        `Arma 3 folder: ${armaDirectory}`,
        `Found by: ${configured ? "armaDirectory project setting" : "automatic detection (registry / Steam libraries)"}`,
        `arma3_x64.exe: ${describeFile(executable)}`,
        `arma3server_x64.exe: ${exists(serverExecutable) ? "found" : "missing"}`
    ];

    if (machine.armaProductVersion) lines.push(`Arma 3 version: ${machine.armaProductVersion}`);
    else if (machine.armaFileVersion) lines.push(`Arma 3 version: ${machine.armaFileVersion}`);
    else lines.push("Arma 3 version: unavailable");

    lines.push(`extraLaunchArguments: ${settings.extraLaunchArguments || "(none)"}`);
    lines.push(`Profile folder: ${profile?.directory ?? "unknown"} (${profile?.reason ?? "unknown"})`);
    lines.push(`Profile name passed to Arma: ${profile?.launchName ?? "(default profile)"}`);

    const missions = findMissions((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath));
    lines.push(`Mission folders in the workspace: ${missions.length}`);
    return lines;
}

async function runtimeLines(context: vscode.ExtensionContext, armaDirectory: string | undefined): Promise<string[]> {
    const bundledMod = path.join(runtimeDirectory(context), "mod", "@SqfReloader");
    const bundledDll = path.join(bundledMod, "SqfReloader_x64.dll");
    const lines = [
        `Bundled mod folder: ${bundledMod}`,
        `scripts.pbo: ${describeFile(path.join(bundledMod, "addons", "scripts.pbo"))}`,
        ...await dllLines("Bundled DLL", bundledDll)
    ];

    lines.push(`Smart App Control: ${await readSmartAppControlState()}`);

    const deployedDll = armaDirectory ? path.join(armaDirectory, "@SqfReloader", "SqfReloader_x64.dll") : "";
    if (deployedDll) {
        lines.push(...await dllLines("DLL in the Arma folder", deployedDll));

        const bundledHash = sha256(bundledDll);
        const deployedHash = sha256(deployedDll);
        if (bundledHash && deployedHash) {
            lines.push(`Deployed copy matches the bundled DLL: ${bundledHash === deployedHash ? "yes" : "no (run Play to redeploy the bundled build)"}`);
        } else {
            lines.push("Deployed copy matches the bundled DLL: cannot compare (a file is missing)");
        }
    } else {
        lines.push("DLL in the Arma folder: not checked (Arma 3 was not found)");
    }

    lines.push(`API config: ${path.join(diagnosticDirectory(), "config.json")}`);
    lines.push(...configLines());
    return lines;
}

function configLines(): string[] {
    const file = path.join(diagnosticDirectory(), "config.json");
    if (!exists(file)) return ["Config values: missing (written when Play or setup runs)"];

    let values: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ["Config values: not a JSON object"];
        values = parsed as Record<string, unknown>;
    } catch (error) {
        return [`Config values: could not be parsed (${describe(error)})`];
    }

    // workspaceFunctions lists every function of every addon; only its size matters here.
    const lines = ["Config values:"];
    for (const [key, value] of Object.entries(values)) {
        if (key === "workspaceFunctions") {
            const count = Array.isArray(value) ? value.length : 0;
            lines.push(`  ${key}: ${count} ${count === 1 ? "entry" : "entries"}`);
            continue;
        }

        lines.push(`  ${key}: ${typeof value === "string" ? value || "(empty)" : JSON.stringify(value)}`);
    }

    return lines;
}

async function dllLines(label: string, file: string): Promise<string[]> {
    if (!exists(file)) return [`${label}: missing (${file})`];

    let stats: fs.Stats;
    try {
        stats = fs.statSync(file);
    } catch (error) {
        return [`${label}: could not be read (${describe(error)})`];
    }

    return [
        `${label}: ${file}`,
        `  Size: ${formatBytes(stats.size)} · Modified: ${formatDate(stats.mtime)}`,
        `  SHA-256: ${sha256(file) ?? "could not be computed"}`,
        `  Authenticode signature: ${hasAuthenticodeSignature(file) ? "present" : "none"}`
    ];
}

async function readApiFacts(settings: Settings): Promise<string[]> {
    const { host, port } = parseApiUrl(settings.apiUrl);
    const lines = [
        `Configured URL: ${settings.apiUrl}`,
        `Port written to config.json this session: ${currentApiPort() ?? "none yet"}`,
        `requestTimeout: ${settings.requestTimeout} ms · runTimeout: ${settings.runTimeout} s`
    ];

    try {
        const free = await isPortFree(port, host);
        lines.push(`${host}:${port}: ${free ? "not listening (nothing answers)" : "listening"}`);
    } catch (error) {
        lines.push(`${host}:${port}: probe failed (${describe(error)})`);
    }

    try {
        const status = await getStatus({ ...settings, requestTimeout: 1500 });
        lines.push("Status response:", ...indent(JSON.stringify(status, null, 2)));
    } catch (error) {
        lines.push(`Status request failed: ${describe(error)}`);
    }

    return lines;
}

function processLines(clientRunning: boolean, serverRunning: boolean): string[] {
    return [
        `arma3_x64.exe: ${clientRunning ? "running" : "not running"}`,
        `arma3server_x64.exe: ${serverRunning ? "running" : "not running"}`,
        `Arma 3 PID started by this window: ${trackedArmaPid() ?? "none"}`
    ];
}

function workspaceLines(armaDirectory: string | undefined): string[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const lines = [
        `Workspace folders: ${folders.length}`,
        ...folders.map(folder => `  ${folder.uri.fsPath}`),
        `Workspace trusted: ${vscode.workspace.isTrusted ? "yes" : "no"}`
    ];

    const settingsFile = projectSettingsPath();
    lines.push(`Project settings: ${settingsFile ? `${settingsFile} (${exists(settingsFile) ? "present" : "missing"})` : "no workspace folder"}`);
    lines.push("Project settings values:", ...indent(JSON.stringify(readProjectSettings(), null, 2)));

    const mods = workspaceMods();
    lines.push(`Workspace mods: ${mods.length}`);
    for (const mod of mods) {
        const role = modTypeForDirectory(mod.directory) ?? "unclassified (launched as client)";
        lines.push(`  ${mod.name} [${role}] ${mod.directory}`);
        for (const addon of mod.addons) lines.push(`    addon ${addon.prefix}`);
    }

    if (armaDirectory) {
        const warnings = verifyWorkspaceAddons(armaDirectory, workspaceAddons());
        lines.push(warnings.length === 0 ? "Addon links: ok" : "Addon link problems:");
        for (const warning of warnings) lines.push(`  ${warning}`);
    } else {
        lines.push("Addon links: not checked (Arma 3 was not found)");
    }

    return lines;
}

async function readRptFacts(): Promise<string[]> {
    const lines = [`Arma log folder: ${armaLogDirectory()}`];

    try {
        const file = await findLatestRptPath();
        if (!file) return [...lines, "Newest .rpt: none found"];

        const stats = await fs.promises.stat(file);
        lines.push(`Newest .rpt: ${file}`, `  Size: ${formatBytes(stats.size)} · Modified: ${formatDate(stats.mtime)}`);

        const tail = await readRptTail(file);
        const relevant = tail.split(/\r?\n/).filter(line => /error|sqfreloader/i.test(line)).slice(-40);
        lines.push(`Recent error/SqfReloader lines: ${relevant.length}`);
        lines.push(...(relevant.length > 0 ? relevant.map(line => `  ${line}`) : ["  (none)"]));
    } catch (error) {
        lines.push(`Could not read the Arma log: ${describe(error)}`);
    }

    return lines;
}

function extensionLogLines(): string[] {
    const recent = recentLogLines();
    return recent.length > 0 ? recent : ["(no log lines recorded in this session)"];
}

interface MachineFacts {
    osCaption?: string;
    osVersion?: string;
    osBuild?: string;
    osArchitecture?: string;
    systemType?: string;
    manufacturer?: string;
    model?: string;
    ramGb?: number;
    cpu?: string;
    physicalCores?: number;
    logicalCores?: number;
    armaProductVersion?: string;
    armaFileVersion?: string;
    vcpp: string[];
    applicationErrors: string[];
    /** Why the Windows-only details are missing; the Node facts are always reported. */
    error?: string;
}

/**
 * One PowerShell call for everything Node cannot read: the Windows edition/build, the machine
 * model, the Visual C++ runtimes (Arma needs them) and the last Application-log errors.
 * Non-ASCII output is escaped by ConvertTo-Json, so no encoding guess is needed.
 */
async function readMachineFacts(armaExecutable: string | undefined): Promise<MachineFacts> {
    if (process.platform !== "win32") {
        return { vcpp: [], applicationErrors: [], error: "Windows only." };
    }

    try {
        const output = await execPowerShell(machineInfoScript(), { ...process.env, ARMA_EXE: armaExecutable ?? "" });
        const parsed: unknown = JSON.parse(output.trim());
        const values = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
        return {
            osCaption: text(values.osCaption),
            osVersion: text(values.osVersion),
            osBuild: text(values.osBuild),
            osArchitecture: text(values.osArchitecture),
            systemType: text(values.systemType),
            manufacturer: text(values.manufacturer),
            model: text(values.model),
            ramGb: number(values.ramGb),
            cpu: text(values.cpu),
            physicalCores: number(values.physicalCores),
            logicalCores: number(values.logicalCores),
            armaProductVersion: text(values.armaProductVersion),
            armaFileVersion: text(values.armaFileVersion),
            vcpp: textList(values.vcpp),
            applicationErrors: textList(values.applicationErrors)
        };
    } catch (error) {
        return { vcpp: [], applicationErrors: [], error: describe(error) };
    }
}

function machineInfoScript(): string {
    return [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "$os = Get-CimInstance Win32_OperatingSystem",
        "$cs = Get-CimInstance Win32_ComputerSystem",
        "$cpu = @(Get-CimInstance Win32_Processor)[0]",
        "$ram = 0",
        "if ($cs.TotalPhysicalMemory) { $ram = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) }",
        "$vcpp = @()",
        "foreach ($root in @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {",
        "  $vcpp += @(Get-ItemProperty (Join-Path $root '*') |",
        "    Where-Object { $_.DisplayName -like '*Visual C++*' } |",
        "    ForEach-Object { ('{0} {1}' -f $_.DisplayName, $_.DisplayVersion).Trim() })",
        "}",
        "$errors = @()",
        "try {",
        "  $errors = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 2 } -MaxEvents 10 | ForEach-Object {",
        "    $parts = $_.Message.Split([char[]](13, 10), [System.StringSplitOptions]::RemoveEmptyEntries)",
        "    $summary = [string]::Join(' | ', @($parts | Select-Object -First 4))",
        "    '{0} | {1} | event {2} | {3}' -f $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'), $_.ProviderName, $_.Id, $summary",
        "  })",
        "} catch { }",
        "$armaProduct = ''",
        "$armaFile = ''",
        "if ($env:ARMA_EXE -and (Test-Path -LiteralPath $env:ARMA_EXE)) {",
        "  $info = (Get-Item -LiteralPath $env:ARMA_EXE).VersionInfo",
        "  $armaProduct = [string]$info.ProductVersion",
        "  $armaFile = [string]$info.FileVersion",
        "}",
        "[ordered]@{",
        "  osCaption = [string]$os.Caption",
        "  osVersion = [string]$os.Version",
        "  osBuild = [string]$os.BuildNumber",
        "  osArchitecture = [string]$os.OSArchitecture",
        "  systemType = [string]$cs.SystemType",
        "  manufacturer = [string]$cs.Manufacturer",
        "  model = [string]$cs.Model",
        "  ramGb = $ram",
        "  cpu = [string]$cpu.Name",
        "  physicalCores = [int]$cpu.NumberOfCores",
        "  logicalCores = [int]$cpu.NumberOfLogicalProcessors",
        "  armaProductVersion = $armaProduct",
        "  armaFileVersion = $armaFile",
        "  vcpp = @($vcpp | Sort-Object -Unique)",
        "  applicationErrors = @($errors)",
        "} | ConvertTo-Json -Depth 4 -Compress"
    ].join("\n");
}

function execPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
            encoding: "utf8",
            timeout: 20_000,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
            env
        }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error([error.message, stderr?.trim()].filter(Boolean).join(": ")));
                return;
            }

            resolve(stdout);
        });
    });
}

function safeProfile(armaDirectory: string, settings: Settings): ArmaProfileSelection | undefined {
    try {
        return selectArmaProfile(armaDirectory, settings.extraLaunchArguments, settings.armaProfile);
    } catch {
        return undefined;
    }
}

function safeHome(): string | undefined {
    try {
        return os.homedir();
    } catch {
        return undefined;
    }
}

function safeUserName(): string | undefined {
    try {
        return os.userInfo().username;
    } catch {
        return undefined;
    }
}

function sha256(file: string): string | undefined {
    try {
        return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } catch {
        return undefined;
    }
}

function exists(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function describeFile(file: string): string {
    try {
        const stats = fs.statSync(file);
        return `found (${formatBytes(stats.size)}, modified ${formatDate(stats.mtime)})`;
    } catch {
        return "missing";
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

function formatDate(value: Date): string {
    const pad = (number: number): string => String(number).padStart(2, "0");
    const offset = -value.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} `
        + `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())} UTC${zone}`;
}

function indent(text: string): string[] {
    return text.split(/\r?\n/).map(line => `  ${line}`);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
    return values.find((value): value is string => !!value && !!value.trim());
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
    const seen = new Set<string>();
    return values.filter(value => {
        const identity = key(value);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
}

function replacePath(text: string, target: string, label: string): string {
    // Both separators can appear in the same report (Node and Arma spell paths differently), and
    // a path copied out of JSON has them doubled.
    const pattern = escapeRegExp(target).replace(/\\\\/g, "[\\\\/]+");
    return text.replace(new RegExp(pattern, "gi"), label);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
