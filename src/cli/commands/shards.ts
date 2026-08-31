import type { CliContext, CliFetch } from "../context.ts";

interface ShardsCommonOptions {
    readonly baseUrl: string;
    readonly token: string;
    readonly migrationId: string;
    readonly fetch: CliFetch;
}

export type ShardsSubcommand =
    | (ShardsCommonOptions & {
          readonly cmd: "split";
          readonly vshardLo: number;
          readonly vshardHi: number;
          readonly toShard: string;
          readonly maxSteps: number;
      })
    | (ShardsCommonOptions & { readonly cmd: "status" })
    | (ShardsCommonOptions & { readonly cmd: "recover" })
    | (ShardsCommonOptions & { readonly cmd: "abort" });

interface ShardsState {
    readonly migrationId: string;
    readonly phase: number;
    readonly phaseName: string;
    readonly terminal: boolean;
    readonly sourceShard: string;
    readonly destinationShard: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
}

const RESPONSE_MAX_BYTES = 64 * 1_024;
const REQUEST_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHASES = new Map<number, string>([
    [-1, "ABORTED"],
    [0, "INIT"],
    [1, "TAIL_CAPTURE_ENABLED"],
    [2, "BULK_COPY_DONE"],
    [3, "TAIL_CAUGHT_UP"],
    [4, "DUAL_WRITE_OPEN"],
    [5, "CATALOG_CUT_OVER"],
    [6, "SOURCE_DRAINED"],
    [7, "ABORTING"],
]);

export async function runShards(ctx: CliContext, sub: ShardsSubcommand): Promise<void> {
    assertCommonOptions(sub);
    const request = createShardsRequest(sub);
    if (sub.cmd === "status") {
        const body = await request(`status?migrationId=${encodeURIComponent(sub.migrationId)}`);
        const state = body.state === null ? null : parseShardsState(body.state);
        ctx.stdout(state ? formatState(state) : `reshard ${sub.migrationId} was not found\n`);
        return;
    }
    if (sub.cmd === "abort") {
        const body = await request("abort", { method: "POST", body: JSON.stringify({ migrationId: sub.migrationId }) });
        const state = body.state === null ? null : parseShardsState(body.state);
        ctx.stdout(state ? formatState(state) : `reshard ${sub.migrationId} aborted before start\n`);
        return;
    }
    if (sub.cmd === "recover") {
        const body = await request("recover", {
            method: "POST",
            body: JSON.stringify({ migrationId: sub.migrationId }),
        });
        if (body.action !== "aborted" && body.action !== "resumed") {
            throw new Error("reshard endpoint returned an invalid recovery action");
        }
        const state = parseShardsState(body.state);
        ctx.stdout(`recovery ${body.action} ${formatState(state)}`);
        return;
    }

    assertSplitOptions(sub);
    const startedBody = await request("start", {
        method: "POST",
        body: JSON.stringify({
            migrationId: sub.migrationId,
            destinationShard: sub.toShard,
            rangeLo: sub.vshardLo,
            rangeHi: sub.vshardHi,
        }),
    });
    if (startedBody.started !== true && startedBody.started !== false) {
        throw new Error("reshard endpoint returned an invalid start result");
    }
    let state = parseShardsState(startedBody.state);
    assertExactSplit(state, sub);
    ctx.stdout(`${startedBody.started ? "started" : "resumed"} ${formatState(state)}`);
    for (let step = 0; step < sub.maxSteps && !state.terminal; step++) {
        const driven = await request("drive", {
            method: "POST",
            body: JSON.stringify({ migrationId: sub.migrationId }),
        });
        state = parseShardsState(driven.state);
        assertExactSplit(state, sub);
    }
    if (!state.terminal) {
        throw new Error(
            `reshard ${sub.migrationId} did not reach a terminal state after ${sub.maxSteps} bounded steps (phase ${state.phaseName})`
        );
    }
    ctx.stdout(`completed ${formatState(state)}`);
}

function createShardsRequest(opts: ShardsCommonOptions) {
    const baseUrl = opts.baseUrl.replace(/\/$/, "");
    return async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
            let response: Response;
            try {
                response = await opts.fetch(`${baseUrl}/_chardb/shards/${path}`, {
                    ...init,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                    headers: {
                        authorization: `Bearer ${opts.token}`,
                        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
                    },
                });
            } catch (error) {
                lastError = error;
                if (attempt === REQUEST_ATTEMPTS) throw error;
                continue;
            }
            const text = await boundedResponseText(response);
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch {
                throw new Error(`reshard endpoint returned ${response.status} with invalid JSON`);
            }
            if (response.ok && typeof body === "object" && body !== null && !Array.isArray(body)) {
                return body as Record<string, unknown>;
            }
            const message =
                typeof body === "object" && body !== null && !Array.isArray(body)
                    ? String((body as Record<string, unknown>).error ?? response.statusText)
                    : response.statusText;
            const error = new Error(`reshard endpoint returned ${response.status}: ${message}`);
            if (![429, 502, 503, 504].includes(response.status) || attempt === REQUEST_ATTEMPTS) throw error;
            lastError = error;
        }
        throw lastError instanceof Error ? lastError : new Error("reshard request failed");
    };
}

function assertCommonOptions(opts: ShardsCommonOptions): void {
    const url = new URL(opts.baseUrl);
    if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
    ) {
        throw new TypeError("reshard URL must use HTTPS, except for localhost");
    }
    if (url.username || url.password || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
        throw new TypeError("reshard URL must contain only an origin");
    }
    if (opts.token.length < 1 || new TextEncoder().encode(opts.token).byteLength > 512) {
        throw new TypeError("reshard token is invalid");
    }
    if (!MIGRATION_ID.test(opts.migrationId)) throw new TypeError("reshard migration id is invalid");
}

function assertSplitOptions(opts: Extract<ShardsSubcommand, { cmd: "split" }>): void {
    if (!SHARD_ID.test(opts.toShard)) throw new TypeError("reshard destination shard is invalid");
    if (
        !Number.isSafeInteger(opts.vshardLo) ||
        !Number.isSafeInteger(opts.vshardHi) ||
        opts.vshardLo < 0 ||
        opts.vshardHi < opts.vshardLo ||
        opts.vshardHi >= 16_384
    ) {
        throw new TypeError("reshard virtual-shard range is invalid");
    }
    if (!Number.isSafeInteger(opts.maxSteps) || opts.maxSteps < 1 || opts.maxSteps > 10_000) {
        throw new TypeError("reshard max steps must be between 1 and 10000");
    }
}

function parseShardsState(value: unknown): ShardsState {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("reshard endpoint returned an invalid state");
    }
    const state = value as Record<string, unknown>;
    const phaseName = typeof state.phase === "number" ? PHASES.get(state.phase) : undefined;
    if (
        typeof state.migrationId !== "string" ||
        !MIGRATION_ID.test(state.migrationId) ||
        !Number.isSafeInteger(state.phase) ||
        phaseName === undefined ||
        state.phaseName !== phaseName ||
        typeof state.terminal !== "boolean" ||
        state.terminal !== (state.phase === -1 || state.phase === 6) ||
        typeof state.sourceShard !== "string" ||
        !SHARD_ID.test(state.sourceShard) ||
        typeof state.destinationShard !== "string" ||
        !SHARD_ID.test(state.destinationShard) ||
        !Number.isSafeInteger(state.rangeLo) ||
        !Number.isSafeInteger(state.rangeHi) ||
        (state.rangeLo as number) < 0 ||
        (state.rangeHi as number) < (state.rangeLo as number) ||
        (state.rangeHi as number) >= 16_384
    ) {
        throw new Error("reshard endpoint returned an invalid state");
    }
    return state as unknown as ShardsState;
}

function assertExactSplit(state: ShardsState, opts: Extract<ShardsSubcommand, { cmd: "split" }>): void {
    if (
        state.migrationId !== opts.migrationId ||
        state.destinationShard !== opts.toShard ||
        state.rangeLo !== opts.vshardLo ||
        state.rangeHi !== opts.vshardHi
    ) {
        throw new Error("reshard endpoint returned a different migration identity");
    }
}

function formatState(state: ShardsState): string {
    return `reshard ${state.migrationId}: ${state.phaseName} (${state.phase}) [${state.rangeLo}, ${state.rangeHi}] ${state.sourceShard} -> ${state.destinationShard}\n`;
}

async function boundedResponseText(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
        const bytes = Number(declared);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > RESPONSE_MAX_BYTES) {
            throw new Error("reshard response has an invalid content length");
        }
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > RESPONSE_MAX_BYTES) {
            await reader.cancel();
            throw new Error("reshard response is too large");
        }
        text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
}
