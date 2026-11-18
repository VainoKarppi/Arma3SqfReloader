// Verifies the code-integrity preflight that explains a "Bad Image" DLL load failure
// (src/dllIntegrity.ts). Pure Node, no VS Code needed: the module must stay vscode-free.
// Run from the repository root:  node scripts/verify-dll-integrity.js
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

const repoRoot = path.resolve(__dirname, "..");
const { parseSmartAppControlState, readSmartAppControlState, hasAuthenticodeSignature, hasMarkOfTheWeb,
    clearMarkOfTheWeb, blockedDllWarning }
    = require(path.join(repoRoot, "out", "dllIntegrity.js"));

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }

    failures++;
    console.error(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqfReloader-integrity-"));

/** Minimal PE32+ image; `signatureSize` > 0 gives it a certificate table. */
function writePe(name, { magic = 0x20b, signatureSize = 0 } = {}) {
    const image = Buffer.alloc(0x400);
    image.write("MZ", 0, "latin1");
    image.writeUInt32LE(0x80, 0x3c);

    const peOffset = 0x80;
    image.write("PE\0\0", peOffset, "latin1");
    const optional = peOffset + 24;
    image.writeUInt16LE(magic, optional);
    image.writeUInt32LE(16, optional + 108);
    image.writeUInt32LE(signatureSize, optional + 112 + 4 * 8 + 4);

    const file = path.join(root, name);
    fs.writeFileSync(file, image);
    return file;
}

// --- Smart App Control state --------------------------------------------------------------
const regOn = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\n"
    + "    VerifiedAndReputablePolicyState    REG_DWORD    0x1\n";
check("state on", parseSmartAppControlState(regOn) === "on", parseSmartAppControlState(regOn));
check("state off", parseSmartAppControlState(regOn.replace("0x1", "0x0")) === "off");
check("state evaluation", parseSmartAppControlState(regOn.replace("0x1", "0x2")) === "evaluation");
check("state unknown value", parseSmartAppControlState(regOn.replace("0x1", "0x9")) === "unknown");
check("state missing value", parseSmartAppControlState("ERROR: The system was unable to find the specified registry key or value.") === "unknown");

(async () => {
    const state = await readSmartAppControlState();
    check("readSmartAppControlState returns a known state", ["off", "on", "evaluation", "unknown"].includes(state), state);

    // --- Authenticode detection -----------------------------------------------------------
    check("unsigned PE32+", hasAuthenticodeSignature(writePe("unsigned.dll")) === false);
    check("signed PE32+", hasAuthenticodeSignature(writePe("signed.dll", { signatureSize: 0x200 })) === true);
    check("PE32 is not a PE32+ image", hasAuthenticodeSignature(writePe("pe32.dll", { magic: 0x10b, signatureSize: 0x200 })) === false);

    const text = path.join(root, "not-a-pe.dll");
    fs.writeFileSync(text, "this is not a PE file");
    check("not a PE file", hasAuthenticodeSignature(text) === false);

    const truncated = path.join(root, "truncated.dll");
    fs.writeFileSync(truncated, "MZ");
    check("truncated file", hasAuthenticodeSignature(truncated) === false);

    check("missing file", hasAuthenticodeSignature(path.join(root, "does-not-exist.dll")) === false);

    // --- Mark-of-the-Web ------------------------------------------------------------------
    // CopyFile (and therefore the deployment copy) preserves alternate data streams, so the mark
    // survives being copied out of a downloaded .vsix into the Arma folder.
    const downloaded = writePe("downloaded.dll");
    const copied = path.join(root, "copied.dll");
    fs.writeFileSync(`${downloaded}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3");
    fs.copyFileSync(downloaded, copied);

    check("mark detected on the source", hasMarkOfTheWeb(downloaded) === true);
    check("copyFile keeps the mark", hasMarkOfTheWeb(copied) === true);
    check("clear removes the mark", clearMarkOfTheWeb(copied) === true && hasMarkOfTheWeb(copied) === false);
    check("clearing twice is a no-op", clearMarkOfTheWeb(copied) === false);
    check("plain file has no mark", hasMarkOfTheWeb(writePe("plain.dll")) === false);
    check("missing file has no mark", hasMarkOfTheWeb(path.join(root, "does-not-exist.dll")) === false);

    // --- Launch warning -------------------------------------------------------------------
    check("no warning for a missing DLL", await blockedDllWarning(path.join(root, "does-not-exist.dll")) === undefined);

    // A signed DLL passes every policy, so it never produces the warning.
    check("no warning for a signed DLL", await blockedDllWarning(path.join(root, "signed.dll"), "on") === undefined);
    check("no warning in evaluation mode", await blockedDllWarning(path.join(root, "unsigned.dll"), "evaluation") === undefined);
    check("no warning when Smart App Control is off", await blockedDllWarning(path.join(root, "unsigned.dll"), "off") === undefined);

    const warning = await blockedDllWarning(path.join(root, "unsigned.dll"), "on");
    check("warning when Smart App Control is on", warning !== undefined);
    if (warning) {
        check("warning names the error status", /0xC0E90002/.test(warning.message), warning.message);
        check("warning explains the fix", warning.detail.some(line => /Smart App Control/.test(line)));
        check("unsigned file without a mark does not blame the mark", !warning.detail.some(line => /Mark-of-the-Web/.test(line)));
    }

    const markedWarning = await blockedDllWarning(downloaded, "on");
    check("marked DLL reports the mark", markedWarning !== undefined && markedWarning.detail.some(line => /Mark-of-the-Web/.test(line)));
    if (markedWarning) {
        check("marked DLL suggests Unblock-File", markedWarning.detail.some(line => /Unblock-File/.test(line)));
    }

    // The machine state is read when no override is given; only that path touches the registry.
    const actual = await blockedDllWarning(path.join(root, "unsigned.dll"));
    check("warning follows the machine state", (state === "on") === (actual !== undefined), `state=${state}`);

    // The DLL that ships in the .vsix must be the one diagnosed; it is never code-signed.
    const shipped = path.join(repoRoot, "vscode-runtime", "mod", "@SqfReloader", "SqfReloader_x64.dll");
    if (fs.existsSync(shipped)) {
        check("shipped DLL is unsigned", hasAuthenticodeSignature(shipped) === false);
    }

    fs.rmSync(root, { recursive: true, force: true });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.`);
        process.exit(1);
    }

    console.log("\nDLL integrity checks passed.");
})();
