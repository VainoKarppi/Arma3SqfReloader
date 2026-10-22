import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { Settings } from "./settings";

export interface ApiResponse {
    status: number;
    body: string;
    json?: unknown;
}

export class ApiError extends Error {
    constructor(message: string, readonly cause?: unknown) {
        super(message);
        this.name = "ApiError";
    }
}

/** Minimal HTTP helper (no node-fetch dependency, works offline). */
export function request(settings: Settings, method: "GET" | "POST", route: string, payload?: unknown, timeoutMs = settings.requestTimeout): Promise<ApiResponse> {
    const url = new URL(`${settings.apiUrl}${route}`);
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const transport = url.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
        const req = transport.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method,
            timeout: timeoutMs,
            headers: body
                ? {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body)
                }
                : undefined
        }, response => {
            const chunks: Buffer[] = [];

            response.on("data", chunk => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json: unknown;

                try {
                    json = text.length > 0 ? JSON.parse(text) : undefined;
                } catch {
                    json = undefined;
                }

                resolve({ status: response.statusCode ?? 0, body: text, json });
            });
        });

        req.on("timeout", () => {
            req.destroy(new ApiError(`Timed out after ${settings.requestTimeout} ms (${url.href}). Is Arma running?`));
        });

        req.on("error", error => {
            if (error instanceof ApiError) {
                reject(error);
            } else if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
                reject(new ApiError(`SqfReloader is not listening on ${settings.apiUrl}. Start Arma 3 with the @SqfReloader mod and run [] call SqfReloader_fnc_apiStart;`));
            } else {
                reject(new ApiError(error.message, error));
            }
        });

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

export interface Status {
    status?: string;
    extension?: string;
    version?: string;
    port?: number;
    host?: string;
    gameConnected?: boolean;
    logDirectory?: string;
}

export async function getStatus(settings: Settings): Promise<Status> {
    const response = await request(settings, "GET", "/status");

    if (response.status !== 200) {
        throw new ApiError(`SqfReloader answered HTTP ${response.status}: ${response.body}`);
    }

    return (response.json ?? {}) as Status;
}

export interface CommandResult {
    success: boolean;
    error?: string;
    count?: number;
    functions?: unknown;
    result?: unknown;
}

export async function reloadFunctions(settings: Settings, variables: string[]): Promise<CommandResult> {
    const response = await request(settings, "POST", "/reload", { functions: variables });
    return toResult(response);
}

export async function reloadEverything(settings: Settings): Promise<CommandResult> {
    const response = await request(settings, "POST", "/reload", {});
    return toResult(response);
}

export async function evalCode(settings: Settings, code: string): Promise<CommandResult> {
    const response = await request(settings, "POST", "/eval", { code });
    return toResult(response);
}

/** Executes SQF and waits for Arma to publish its return value to the API. */
export async function executeCode(settings: Settings, code: string, timeoutMs: number): Promise<CommandResult> {
    const accepted = await request(settings, "POST", "/execute", { code, timeoutMs });
    const acceptedResult = toResult(accepted);
    if (!acceptedResult.success) return acceptedResult;

    const requestId = (accepted.json as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
        return { success: false, error: "Arma accepted the execution request without returning a request ID." };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const remainingMs = Math.max(1, deadline - Date.now());
        let response: ApiResponse;
        try {
            response = await request(settings, "GET", `/result/${encodeURIComponent(requestId)}`, undefined, Math.min(settings.requestTimeout, remainingMs));
        } catch (error) {
            if (Date.now() >= deadline) break;
            throw error;
        }
        if (response.status === 202) continue;
        return toResult(response);
    }

    return { success: false, error: `Arma did not return an SQF result within ${Math.ceil(timeoutMs / 1000)} seconds.` };
}

export async function recompileCommand(settings: Settings, armaPath: string, code: string): Promise<CommandResult> {
    const response = await request(settings, "POST", "/command", {
        type: "recompile",
        method: armaPath,
        code
    });

    return toResult(response);
}

export async function listFunctions(settings: Settings): Promise<CommandResult> {
    const response = await request(settings, "GET", "/functions");
    return toResult(response);
}

function toResult(response: ApiResponse): CommandResult {
    const json = (response.json ?? {}) as CommandResult;
    const success = (json as { success?: unknown }).success;

    if (response.status >= 400 || success === false) {
        return {
            success: false,
            error: json.error ?? `HTTP ${response.status}: ${response.body}`
        };
    }

    return { ...json, success: true };
}

/** SQF string literal for embedding a path or variable name. */
export function sqfString(value: string): string {
    // SQF strings escape quotes by doubling them; backslashes are literal path characters.
    return `"${value.replace(/"/g, '""')}"`;
}
