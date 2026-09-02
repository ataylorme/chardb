import { resolve } from "node:path";
import { stableJson } from "../../util/canonical.ts";
import type { CliContext, CliFetch } from "../context.ts";

const RESPONSE_MAX_BYTES = 2 * 1_024 * 1_024;
const REQUEST_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const RECONCILE_ATTEMPTS = 60;
const RECONCILE_RETRY_MS = 1_000;
const RECOVERY_OPERATION_TURNS = 6_000_000;

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
    const response = await runRecoveryOperation(request, "restore", recoveryPoint, digest);
    if (
        response.accepted !== true ||
        response.recoveryPointDigest !== digest ||
        !Number.isSafeInteger(response.reconcileAfterMs) ||
        (response.reconcileAfterMs as number) < 0 ||
        (response.reconcileAfterMs as number) > 30_000
    ) {
        throw new Error("backup endpoint returned an invalid restore acknowledgement");
    }
    const providerReset = response.providerReset;
    if (typeof providerReset !== "object" || providerReset === null || Array.isArray(providerReset)) {
        throw new Error("backup endpoint omitted the provider reset result");
    }
    const reset = providerReset as Record<string, unknown>;
    if (
        !Number.isSafeInteger(reset.files) ||
        (reset.files as number) < 0 ||
        !Number.isSafeInteger(reset.filesRetained) ||
        (reset.filesRetained as number) < 0 ||
        !Number.isSafeInteger(reset.vectors) ||
        (reset.vectors as number) < 0
    ) {
        throw new Error("backup endpoint returned an invalid provider reset result");
    }
    const reconcileAfterMs = response.reconcileAfterMs as number;
    if (reconcileAfterMs > 0) await new Promise(resolve => setTimeout(resolve, reconcileAfterMs));
    const reconciled = await runRecoveryOperation(request, "reconcile", recoveryPoint, digest);
    if (
        reconciled.reconciled !== true ||
        reconciled.recoveryPointDigest !== digest ||
        !Number.isSafeInteger(reconciled.filesRehydrated) ||
        (reconciled.filesRehydrated as number) < 0 ||
        !Number.isSafeInteger(reconciled.vectorsRequeued) ||
        (reconciled.vectorsRequeued as number) < 0
    ) {
        throw new Error("backup endpoint returned an invalid recovery reconciliation");
    }
    ctx.stdout(
        `restored ${digest}; retained ${reset.filesRetained} files, reset ${reset.files} file objects and ${reset.vectors} vector records, then rehydrated ${reconciled.filesRehydrated} files and requeued ${reconciled.vectorsRequeued} vectors\n`
    );
}

async function runRecoveryOperation(
    request: ReturnType<typeof backupRequest>,
    action: "restore" | "reconcile",
    recoveryPoint: unknown,
    digest: string
): Promise<Record<string, unknown>> {
    let continuation: unknown;
    let continuationIdentity: string | undefined;
    for (let turn = 0; turn < RECOVERY_OPERATION_TURNS; turn++) {
        const body = continuation === undefined ? { recoveryPoint } : { recoveryPoint, continuation };
        const response = await request(action, { method: "POST", body: JSON.stringify(body) });
        if (response.pending !== true) return response;
        if (
            response.recoveryPointDigest !== digest ||
            typeof response.continuation !== "object" ||
            response.continuation === null ||
            Array.isArray(response.continuation)
        ) {
            throw new Error(`backup endpoint returned an invalid ${action} continuation`);
        }
        let retryAfterMs = 0;
        if (response.retryAfterMs !== undefined) {
            if (
                !Number.isSafeInteger(response.retryAfterMs) ||
                (response.retryAfterMs as number) < 0 ||
                (response.retryAfterMs as number) > 30_000
            ) {
                throw new Error(`backup endpoint returned an invalid ${action} retry delay`);
            }
            retryAfterMs = response.retryAfterMs as number;
        }
        const nextIdentity = stableJson(response.continuation);
        if (nextIdentity === continuationIdentity && retryAfterMs === 0) {
            throw new Error(`backup endpoint returned a stalled ${action} continuation`);
        }
        continuation = response.continuation;
        continuationIdentity = nextIdentity;
        if (retryAfterMs > 0) await new Promise(resolve => setTimeout(resolve, retryAfterMs));
    }
    throw new Error(`backup ${action} exceeded its continuation bound`);
}

function backupRequest(options: BackupCommonOptions) {
    const baseUrl = validatedBaseUrl(options.baseUrl);
    if (options.token.length < 1 || new TextEncoder().encode(options.token).byteLength > 512) {
        throw new TypeError("backup token is invalid");
    }
    return async (action: "create" | "restore" | "reconcile", init: RequestInit): Promise<Record<string, unknown>> => {
        let lastError: unknown;
        const attempts = action === "reconcile" ? RECONCILE_ATTEMPTS : REQUEST_ATTEMPTS;
        for (let attempt = 1; attempt <= attempts; attempt++) {
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
                if (attempt === attempts) throw error;
                if (action === "reconcile") await new Promise(resolve => setTimeout(resolve, RECONCILE_RETRY_MS));
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
            const code =
                typeof body === "object" && body !== null && !Array.isArray(body)
                    ? (body as Record<string, unknown>).code
                    : undefined;
            const activating = action === "reconcile" && response.status === 409 && code === "CDB_STALE_EPOCH";
            if ((!activating && ![429, 502, 503, 504].includes(response.status)) || attempt === attempts) throw error;
            lastError = error;
            if (action === "reconcile") await new Promise(resolve => setTimeout(resolve, RECONCILE_RETRY_MS));
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
