// Verifies the diagnostic report (src/diagnostics.ts): the personal-information redaction that
// makes the file safe to attach to a public issue, the %LOCALAPPDATA%\SqfReloader\diagnostic.txt
// path, and - on Windows - one real collection run that must not contain the user name, the
// computer name or a personal folder path.
// Run from the repository root:  node scripts/verify-diagnostics.js
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
const diagnostics = require(path.join(repoRoot, "out", "diagnostics.js"));

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` (${detail})`}`);
}

// Deliberately unsorted: the redaction must apply the longest path first on its own.
const targets = {
    paths: [
        { value: "C:\\Users\\tester", label: "%USERPROFILE%" },
        { value: "C:\\Users\\tester\\AppData\\Local", label: "%LOCALAPPDATA%" }
    ],
    words: [
        { value: "tester", label: "<user>" },
        { value: "John Smith", label: "<profile>" },
        { value: "DESKTOP-ABC123", label: "<computer>" }
    ]
};

const redact = text => diagnostics.redactPersonalInfo(text, targets);

async function main() {
    console.log("Redaction");
    check(
        "home folder becomes %USERPROFILE%",
        redact("C:\\Users\\tester\\WORK\\Arma3SqfReloader") === "%USERPROFILE%\\WORK\\Arma3SqfReloader",
        redact("C:\\Users\\tester\\WORK\\Arma3SqfReloader"));
    check(
        "%LOCALAPPDATA% wins over %USERPROFILE%",
        redact("C:\\Users\\tester\\AppData\\Local\\SqfReloader\\config.json") === "%LOCALAPPDATA%\\SqfReloader\\config.json",
        redact("C:\\Users\\tester\\AppData\\Local\\SqfReloader\\config.json"));
    check(
        "forward slashes are redacted too",
        redact("C:/Users/tester/WORK") === "%USERPROFILE%/WORK",
        redact("C:/Users/tester/WORK"));
    check(
        "another account keeps only the shape",
        redact("D:\\Users\\someone\\Arma 3") === "D:\\Users\\<user>\\Arma 3",
        redact("D:\\Users\\someone\\Arma 3"));
    check(
        "paths copied from JSON (doubled separators) tokenize fully",
        redact("C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\SqfReloader\\\\logs") === "%LOCALAPPDATA%\\\\SqfReloader\\\\logs",
        redact("C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\SqfReloader\\\\logs"));
    check("computer name", redact("host DESKTOP-ABC123 ready") === "host <computer> ready", redact("host DESKTOP-ABC123 ready"));
    check("user name, case-insensitive", redact("hello Tester") === "hello <user>", redact("hello Tester"));
    check("profile name", redact("profile John Smith") === "profile <profile>", redact("profile John Smith"));
    check("non-loopback IPv4", redact("192.168.1.20") === "<ip>", redact("192.168.1.20"));
    check("loopback is kept", redact("http://127.0.0.1:8764/api") === "http://127.0.0.1:8764/api");
    check("environment tokens survive", redact("%USERPROFILE%\\Documents\\Arma 3") === "%USERPROFILE%\\Documents\\Arma 3");
    check(
        "regex characters in a user name",
        diagnostics.redactPersonalInfo("D:\\Users\\a+b(c)\\x", { paths: [], words: [{ value: "a+b(c)", label: "<user>" }] }) === "D:\\Users\\<user>\\x");

    console.log("Report formatting");
    const report = diagnostics.formatDiagnosticReport(
        ["Extension: 3.8.2", "Folder: C:\\Users\\tester\\WORK"],
        [{ title: "Workspace", lines: ["C:\\Users\\tester\\WORK\\ClientMod", "DESKTOP-ABC123", "login tester"] }],
        targets
    );
    check("section titles are kept", report.includes("=== Workspace ==="));
    check("header is redacted", report.includes("%USERPROFILE%\\WORK") && !report.includes("C:\\Users\\tester"));
    check("body is redacted", !report.includes("DESKTOP-ABC123") && !report.includes("login tester"));
    check("report ends with the marker", report.trimEnd().endsWith("=== End of report ==="));

    console.log("Report file");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-diagnostics-"));
    const previousLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    try {
        check(
            "path is %LOCALAPPDATA%\\SqfReloader\\diagnostic.txt",
            diagnostics.diagnosticReportPath() === path.join(root, "SqfReloader", "diagnostic.txt"),
            diagnostics.diagnosticReportPath());

        const written = diagnostics.writeDiagnosticReportFile("report body");
        const content = fs.readFileSync(written, "utf8");
        check("file starts with a UTF-8 BOM", content.startsWith("\ufeff"));
        check("file is created with the given content", content.replace(/^\ufeff/, "") === "report body");
    } finally {
        if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = previousLocalAppData;
        fs.rmSync(root, { recursive: true, force: true });
    }

    if (process.platform === "win32") {
        console.log("Real report (this machine)");
        const context = { extensionPath: repoRoot, extension: { packageJSON: { version: "verify" } } };
        const collected = await Promise.race([
            diagnostics.collectDiagnosticReport(context),
            new Promise(resolve => setTimeout(() => resolve(""), 90_000))
        ]);

        check("a report was produced", typeof collected === "string" && collected.length > 200);
        for (const title of ["System", "VS Code", "Arma 3 installation", "SqfReloader runtime", "SqfReloader API", "Workspace", "Arma 3 logs", "Extension log"]) {
            check(`section "${title}"`, collected.includes(`=== ${title} ===`));
        }

        const home = os.homedir();
        const userName = process.env.USERNAME || os.userInfo().username;
        const computerName = process.env.COMPUTERNAME || os.hostname();
        const lower = collected.toLowerCase();
        check("no home folder in the report", !lower.includes(home.toLowerCase()) && !lower.includes(home.replace(/\\/g, "/").toLowerCase()));
        check("no user name in the report", userName.length < 3 || !lower.includes(userName.toLowerCase()), userName);
        check("no computer name in the report", computerName.length < 3 || !lower.includes(computerName.toLowerCase()), computerName);
        check("loopback address is still reported", collected.includes("127.0.0.1"));
    }

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.`);
        process.exit(1);
    }

    console.log("\nDiagnostic report checks passed.");
}

void vscode;
main().catch(error => {
    console.error(error);
    process.exit(1);
});
