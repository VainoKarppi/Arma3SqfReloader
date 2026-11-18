import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";

/**
 * Windows Smart App Control ("verified and reputable" code-integrity policy) blocks binaries that
 * have no known reputation unless they are code-signed. The loader then fails with
 * STATUS_SYSTEM_INTEGRITY_POLICY_VIOLATION (0xC0E90002), which Windows reports as
 *
 *   SqfReloader_x64.dll is either not designed to run on Windows or it contains an error.
 *
 * Arma 3 shows that dialog and continues without SqfReloader, so the launch is diagnosed here
 * instead of leaving the game silently without the reloader. There is no per-app exception: either
 * the DLL is signed with a trusted certificate or Smart App Control is turned off.
 *
 * This module deliberately has no `vscode` import so it can be loaded by the verify scripts.
 */
export type SmartAppControlState = "off" | "on" | "evaluation" | "unknown";

export interface DllPolicyWarning {
    /** One line for the notification and the launch warning list. */
    message: string;
    /** Explanation, logged to the output channel. */
    detail: string[];
}

const CI_POLICY_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy";
const CI_POLICY_VALUE = "VerifiedAndReputablePolicyState";

/** Reads the state from a `reg query` result: 0 = off, 1 = on, 2 = evaluation (blocklist only). */
export function parseSmartAppControlState(registryOutput: string): SmartAppControlState {
    const match = new RegExp(`${CI_POLICY_VALUE}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, "i").exec(registryOutput);
    if (!match) return "unknown";

    switch (parseInt(match[1], 16)) {
        case 0:
            return "off";
        case 1:
            return "on";
        case 2:
            return "evaluation";
        default:
            return "unknown";
    }
}

/** Smart App Control state of this machine; "unknown" when the value does not exist. */
export async function readSmartAppControlState(): Promise<SmartAppControlState> {
    if (process.platform !== "win32") return "unknown";

    try {
        return parseSmartAppControlState(await regQuery(CI_POLICY_KEY, CI_POLICY_VALUE));
    } catch {
        // A machine where Smart App Control was never configured has no such value.
        return "unknown";
    }
}

/**
 * True when the PE file carries an Authenticode signature, so a code-integrity policy can evaluate
 * it. Only the header is inspected; the signature itself is not verified.
 */
export function hasAuthenticodeSignature(file: string): boolean {
    let handle: number;

    try {
        handle = fs.openSync(file, "r");
    } catch {
        return false;
    }

    try {
        const header = Buffer.alloc(4096);
        const read = fs.readSync(handle, header, 0, header.length, 0);

        if (read < 0x40 || header.toString("latin1", 0, 2) !== "MZ") return false;

        const peOffset = header.readUInt32LE(0x3c);
        // Header + optional header + the five data directories up to SECURITY must be present.
        if (peOffset + 0xb0 > read || header.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0") return false;

        const optionalHeader = peOffset + 24;
        if (header.readUInt16LE(optionalHeader) !== 0x20b) return false;

        // IMAGE_DIRECTORY_ENTRY_SECURITY (4) is the fifth entry, after the 112-byte PE32+ prefix.
        const security = optionalHeader + 112 + 4 * 8;
        return header.readUInt32LE(security + 4) > 0;
    } finally {
        fs.closeSync(handle);
    }
}

/**
 * True when Windows marked the file as coming from the internet: the `Zone.Identifier` alternate
 * data stream that Explorer's "Unblock" checkbox and `Unblock-File` remove.
 */
export function hasMarkOfTheWeb(file: string): boolean {
    if (process.platform !== "win32") return false;

    try {
        return fs.existsSync(`${file}:Zone.Identifier`);
    } catch {
        return false;
    }
}

/**
 * Removes the Mark-of-the-Web. Returns true when a mark was actually removed.
 *
 * CopyFile - and therefore `fs.cpSync` in the deployment - preserves alternate data streams, so a
 * DLL that arrived in a downloaded .vsix is still "from the internet" after being copied into the
 * Arma folder, while a DLL built on that machine never has the mark.
 */
export function clearMarkOfTheWeb(file: string): boolean {
    if (!hasMarkOfTheWeb(file)) return false;

    try {
        fs.rmSync(`${file}:Zone.Identifier`, { force: true });
        return !hasMarkOfTheWeb(file);
    } catch {
        return false;
    }
}

/**
 * Returns a warning when a code-integrity policy on this machine refuses to load the DLL.
 *
 * Only Smart App Control is detected; an enforced WDAC/AppLocker policy is reported through the
 * `Microsoft-Windows-CodeIntegrity/Operational` event log (see README-FULL "Troubleshooting").
 *
 * `smartAppControl` overrides the machine state; the verify script uses it to exercise the
 * warning on a machine where Smart App Control is off.
 */
export async function blockedDllWarning(dllPath: string, smartAppControl?: SmartAppControlState): Promise<DllPolicyWarning | undefined> {
    if (process.platform !== "win32" || !fs.existsSync(dllPath)) return undefined;

    // A signed DLL passes the policy, so there is nothing to report.
    if (hasAuthenticodeSignature(dllPath)) return undefined;
    if ((smartAppControl ?? await readSmartAppControlState()) !== "on") return undefined;

    const name = path.basename(dllPath);
    const marked = hasMarkOfTheWeb(dllPath);

    const detail = [
        "Smart App Control checks every DLL when it is loaded and has no per-app exception; the loader returns 0xC0E90002 (STATUS_SYSTEM_INTEGRITY_POLICY_VIOLATION).",
        `Arma 3 shows "${name} is either not designed to run on Windows or it contains an error" and continues without the reloader, so no function is ever reloaded.`
    ];

    if (marked) {
        detail.push(`${name} is still marked as downloaded (Mark-of-the-Web). A copy keeps that mark, which is why a DLL taken from another machine can be blocked while the same project built on this one loads.`);
        detail.push(`Fix: Unblock-File "${dllPath}", or turn Smart App Control off in Windows Security > App & browser control > Smart App Control settings.`);
    } else {
        detail.push("Fix: Windows Security > App & browser control > Smart App Control settings > Off, or sign the DLL with a code-signing certificate.");
    }

    return {
        message: `Windows Smart App Control blocks the unsigned ${name} (error 0xC0E90002), so Arma 3 starts without SqfReloader.`,
        detail
    };
}

function regQuery(key: string, value: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile("reg", ["query", key, "/v", value], {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
}
