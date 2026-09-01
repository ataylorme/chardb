import { resolve } from "node:path";
import type { CliContext, CliFetch } from "../context.ts";

const RESPONSE_MAX_BYTES = 2 * 1_024 * 1_024;
const REQUEST_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

interface BackupCommonOptions {
    readonly baseUrl: string;
    readonly token: string;
    readonly fetch: CliFetch;
}

export async function runBackupCreate(
    ctx: CliContext,
    options: BackupCommonOptions & { readonly out: string; readonly atMs?: number }
): Promise<void> {
    const request = backupRequest(options);
    const response = await request("create", {
        method: "POST",
        body: JSON.stringify(options.atMs === undefined ? {} : { atMs: options.atMs }),
    });
    const recoveryPoint = response.recoveryPoint;
    if (typeof recoveryPoint !== "object" || recoveryPoint === null || Array.isArray(recoveryPoint)) {
        throw new Error("backup endpoint returned an invalid recovery point");
    }
    const outputPath = resolve(ctx.cwd, options.out);
    const contents = `${JSON.stringify(recoveryPoint, null, 2)}\n`;
    if (new TextEncoder().encode(contents).byteLength > RESPONSE_MAX_BYTES) {
        throw new Error("recovery point is too large to save");
    }
    if (ctx.writeFilesExclusive) {
        await ctx.writeFilesExclusive([{ path: outputPath, contents }]);
    } else {
        if (await ctx.exists(outputPath)) throw new Error(`backup output already exists: ${outputPath}`);
        await ctx.write(outputPath, contents);
    }
    const digest = (recoveryPoint as Record<string, unknown>).digest;
    if (typeof digest !== "string") throw new Error("backup endpoint omitted the recovery point digest");
    ctx.stdout(`saved recovery point ${digest} to ${outputPath}\n`);
}

export async function runBackupRestore(
    ctx: CliContext,
    options: BackupCommonOptions & { readonly from: string }
): Promise<void> {
    const inputPath = resolve(ctx.cwd, options.from);
    const contents = await ctx.read(inputPath);
    if (new TextEncoder().encode(contents).byteLength > RESPONSE_MAX_BYTES) {
        throw new Error("recovery point file is too large");
    }
    let recoveryPoint: unknown;
    try {
        recoveryPoint = JSON.parse(contents);
    } catch {
        throw new Error("recovery point file is not valid JSON");
    }
    if (typeof recoveryPoint !== "object" || recoveryPoint === null || Array.isArray(recoveryPoint)) {
        throw new Error("recovery point file must contain one object");
    }
    const digest = (recoveryPoint as Record<string, unknown>).digest;
    if (typeof digest !== "string") throw new Error("recovery point file has no digest");
    const request = backupRequest(options);
    const response = await request("restore", {
        method: "POST",
        body: JSON.stringify({ recoveryPoint }),
    });
    if (response.accepted !== true || response.recoveryPointDigest !== digest) {
        throw new Error("backup endpoint returned an invalid restore acknowledgement");
    }
    ctx.stdout(`restore ${digest} accepted; Durable Objects will restart at the recovery point\n`);
}

function backupRequest(options: BackupCommonOptions) {
    const baseUrl = validatedBaseUrl(options.baseUrl);
    if (options.token.length < 1 || new TextEncoder().encode(options.token).byteLength > 512) {
        throw new TypeError("backup token is invalid");
    }
    return async (action: "create" | "restore", init: RequestInit): Promise<Record<string, unknown>> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
            let response: Response;
            try {
                response = await options.fetch(`${baseUrl}/_chardb/backups/${action}`, {
                    ...init,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                    headers: {
                        authorization: `Bearer ${options.token}`,
                        "content-type": "application/json",
                    },
                });
            } catch (error) {
                lastError = error;
                if (attempt === REQUEST_ATTEMPTS) throw error;
                continue;
            }
            const body = await boundedJson(response);
            if (response.ok && typeof body === "object" && body !== null && !Array.isArray(body)) {
                return body as Record<string, unknown>;
            }
            const message =
                typeof body === "object" && body !== null && !Array.isArray(body)
                    ? String((body as Record<string, unknown>).error ?? response.statusText)
                    : response.statusText;
            const error = new Error(`backup endpoint returned ${response.status}: ${message}`);
            if (![429, 502, 503, 504].includes(response.status) || attempt === REQUEST_ATTEMPTS) throw error;
            lastError = error;
        }
        throw lastError instanceof Error ? lastError : new Error("backup request failed");
    };
}

function validatedBaseUrl(value: string): string {
    const url = new URL(value);
    if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
    ) {
        throw new TypeError("backup URL must use HTTPS, except for localhost");
    }
    if (url.username || url.password || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
        throw new TypeError("backup URL must contain only an origin");
    }
    return url.origin;
}

function parseDeclaredLength(response: Response): number | null {
    const declared = response.headers.get("content-length");
    if (declared === null) return null;
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > RESPONSE_MAX_BYTES) {
        throw new Error("backup response has an invalid content length");
    }
    return bytes;
}

async function boundedJson(response: Response): Promise<unknown> {
    parseDeclaredLength(response);
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > RESPONSE_MAX_BYTES) {
            await reader.cancel();
            throw new Error("backup response is too large");
        }
        chunks.push(next.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    } catch {
        throw new Error(`backup endpoint returned ${response.status} with invalid JSON`);
    }
}
