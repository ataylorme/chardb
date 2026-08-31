import type { CliContext, CliFetch } from "../context.ts";

export interface MigrateOptions {
    readonly baseUrl: string;
    readonly token: string;
    readonly migrationId: string;
    readonly targetVersion: number;
    readonly concurrency: number;
    readonly baseline?: boolean;
    /** Per-request deadline. Exposed for deterministic callers and tests. */
    readonly requestTimeoutMs?: number;
    readonly fetch: CliFetch;
}

interface MigrationState {
    readonly activeVersion: number;
    readonly activeEpoch: number;
    readonly lastMigrationId: string | null;
    readonly status: "active" | "migrating";
    readonly migrationId: string | null;
    readonly targetVersion: number | null;
}

interface MigrationShard {
    readonly shardId: string;
    readonly status: "pending" | "active";
    readonly lastError: string | null;
}

const RESPONSE_MAX_BYTES = 4 * 1_024 * 1_024;
const ERROR_DETAIL_MAX_CHARS = 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const SHARD_MAX_ATTEMPTS = 3;
const SHARD_RETRY_BASE_DELAY_MS = 100;

class MigrationRequestError extends Error {
    readonly retryable: boolean;

    constructor(message: string, retryable: boolean, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "MigrationRequestError";
        this.retryable = retryable;
    }
}

class MigrationResponseValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MigrationResponseValidationError";
    }
}

export async function runMigrate(ctx: CliContext, opts: MigrateOptions): Promise<void> {
    assertMigrateOptions(opts);
    const baseUrl = opts.baseUrl.replace(/\/$/, "");
    const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
                controller.abort();
                reject(
                    new MigrationRequestError(`migration endpoint request timed out after ${requestTimeoutMs}ms`, true)
                );
            }, requestTimeoutMs);
        });
        const execute = async (): Promise<Record<string, unknown>> => {
            let response: Response;
            try {
                response = await opts.fetch(`${baseUrl}/_chardb/migrations/${path}`, {
                    ...init,
                    signal: controller.signal,
                    headers: {
                        authorization: `Bearer ${opts.token}`,
                        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
                    },
                });
            } catch (error) {
                throw new MigrationRequestError(
                    `migration endpoint request failed: ${boundedErrorMessage(error)}`,
                    true,
                    error
                );
            }
            let text: string;
            try {
                text = await boundedResponseText(response);
            } catch (error) {
                throw new MigrationRequestError(
                    `migration endpoint response failed: ${boundedErrorMessage(error)}`,
                    !(error instanceof MigrationResponseValidationError),
                    error
                );
            }
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch (error) {
                throw new MigrationRequestError(
                    `migration endpoint returned ${response.status} with invalid JSON`,
                    isRetryableStatus(response.status),
                    error
                );
            }
            if (!response.ok || typeof body !== "object" || body === null || Array.isArray(body)) {
                const message =
                    typeof body === "object" && body !== null && !Array.isArray(body)
                        ? boundedText(String((body as Record<string, unknown>).error ?? response.statusText))
                        : boundedText(response.statusText);
                throw new MigrationRequestError(
                    `migration endpoint returned ${response.status}: ${message}`,
                    isRetryableStatus(response.status)
                );
            }
            return body as Record<string, unknown>;
        };
        try {
            return await Promise.race([execute(), deadline]);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    };

    const activateShard = async (shard: MigrationShard): Promise<MigrationShard> => {
        let lastFailure: unknown;
        let catalogLastError: string | null = shard.lastError;
        for (let attempt = 1; attempt <= SHARD_MAX_ATTEMPTS; attempt++) {
            try {
                const result = await request("shard", {
                    method: "POST",
                    body: JSON.stringify({ migrationId: opts.migrationId, shardId: shard.shardId }),
                });
                const activated = parseMigrationShard(result.shard);
                if (activated.shardId !== shard.shardId || activated.status !== "active") {
                    throw new Error(`Catalog did not activate shard ${shard.shardId}`);
                }
                return activated;
            } catch (error) {
                if (!(error instanceof MigrationRequestError) || !error.retryable) throw error;
                lastFailure = error;
            }

            try {
                const inventory = parseMigrationShards(
                    (await request(`shards?migrationId=${encodeURIComponent(opts.migrationId)}`)).shards
                );
                const reconciled = inventory.find(item => item.shardId === shard.shardId);
                if (!reconciled) throw new Error(`Catalog lost migration shard ${shard.shardId}`);
                if (reconciled.status === "active") return reconciled;
                catalogLastError = reconciled.lastError;
            } catch (error) {
                if (!(error instanceof MigrationRequestError) || !error.retryable) throw error;
                lastFailure = new Error(`${errorMessage(lastFailure)}; shard reconciliation failed: ${error.message}`, {
                    cause: error,
                });
            }

            if (attempt === SHARD_MAX_ATTEMPTS) {
                const detail = catalogLastError ? `; Catalog last error: ${catalogLastError}` : "";
                throw new Error(
                    `migration shard ${shard.shardId} failed after ${SHARD_MAX_ATTEMPTS} attempts: ${errorMessage(lastFailure)}${detail}`,
                    { cause: lastFailure }
                );
            }
            await delay(SHARD_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
        throw new Error(`migration shard ${shard.shardId} retry loop ended unexpectedly`);
    };

    const stateBody = await request("state");
    const state = parseMigrationState(stateBody.state);
    if (state.status === "active" && state.activeVersion === opts.targetVersion) {
        ctx.stdout(`schema version ${state.activeVersion} is already active at epoch ${state.activeEpoch}\n`);
        return;
    }
    if (state.status === "active" && state.activeVersion > opts.targetVersion) {
        throw new Error(`deployed schema version ${state.activeVersion} is newer than target ${opts.targetVersion}`);
    }
    const begin = await request(opts.baseline ? "baseline" : "begin", {
        method: "POST",
        body: JSON.stringify({ migrationId: opts.migrationId, targetVersion: opts.targetVersion }),
    });
    const begun = parseMigrationState(begin.state);
    if (
        begun.status === "active" &&
        begun.activeVersion === opts.targetVersion &&
        begun.lastMigrationId === opts.migrationId
    ) {
        ctx.stdout(`schema version ${begun.activeVersion} active at epoch ${begun.activeEpoch}\n`);
        return;
    }
    if (
        begun.status !== "migrating" ||
        begun.migrationId !== opts.migrationId ||
        begun.targetVersion !== opts.targetVersion
    ) {
        throw new Error("Catalog returned a different migration owner or target");
    }

    const shardsBody = await request(`shards?migrationId=${encodeURIComponent(opts.migrationId)}`);
    const shards = parseMigrationShards(shardsBody.shards);
    const pending = shards.filter(shard => shard.status === "pending");
    ctx.stdout(`migrating ${pending.length} pending shard(s) to version ${opts.targetVersion}\n`);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(opts.concurrency, pending.length) }, async () => {
        while (cursor < pending.length) {
            const shard = pending[cursor++];
            if (!shard) return;
            await activateShard(shard);
            ctx.stdout(`activated shard ${shard.shardId}\n`);
        }
    });
    await Promise.all(workers);
    for (let version = state.activeVersion + 1; version <= opts.targetVersion; version++) {
        const applied = await request("catalog", {
            method: "POST",
            body: JSON.stringify({ migrationId: opts.migrationId, version }),
        });
        const applying = parseMigrationState(applied.state);
        if (
            applying.status === "active" &&
            applying.activeVersion === opts.targetVersion &&
            applying.lastMigrationId === opts.migrationId
        ) {
            ctx.stdout(`schema version ${applying.activeVersion} active at epoch ${applying.activeEpoch}\n`);
            return;
        }
        if (
            applying.status !== "migrating" ||
            applying.migrationId !== opts.migrationId ||
            applying.targetVersion !== opts.targetVersion
        ) {
            throw new Error(`Catalog did not record schema migration version ${version}`);
        }
        ctx.stdout(`applied Catalog schema version ${version}\n`);
    }
    const completed = await request("complete", {
        method: "POST",
        body: JSON.stringify({ migrationId: opts.migrationId }),
    });
    const active = parseMigrationState(completed.state);
    if (
        active.status !== "active" ||
        active.activeVersion !== opts.targetVersion ||
        active.lastMigrationId !== opts.migrationId
    ) {
        throw new Error("Catalog did not activate the requested schema version");
    }
    ctx.stdout(`schema version ${active.activeVersion} active at epoch ${active.activeEpoch}\n`);
}

function assertMigrateOptions(opts: MigrateOptions): void {
    const url = new URL(opts.baseUrl);
    if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
    ) {
        throw new TypeError("migration URL must use HTTPS, except for localhost");
    }
    if (opts.token.length < 1 || new TextEncoder().encode(opts.token).byteLength > 512) {
        throw new TypeError("migration token is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(opts.migrationId)) {
        throw new TypeError("migration id is invalid");
    }
    if (!Number.isSafeInteger(opts.targetVersion) || opts.targetVersion < 1) {
        throw new TypeError("migration target version is invalid");
    }
    if (!Number.isSafeInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 32) {
        throw new TypeError("migration concurrency must be between 1 and 32");
    }
    if (
        opts.requestTimeoutMs !== undefined &&
        (!Number.isSafeInteger(opts.requestTimeoutMs) || opts.requestTimeoutMs < 1 || opts.requestTimeoutMs > 300_000)
    ) {
        throw new TypeError("migration request timeout must be between 1 and 300000 milliseconds");
    }
}

async function boundedResponseText(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
        const bytes = Number(declared);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > RESPONSE_MAX_BYTES) {
            throw new MigrationResponseValidationError("migration response has an invalid content length");
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
            void reader.cancel().catch(() => {});
            throw new MigrationResponseValidationError("migration response is too large");
        }
        text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
}

function parseMigrationState(value: unknown): MigrationState {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("migration endpoint returned an invalid state");
    }
    const state = value as Record<string, unknown>;
    if (
        !Number.isSafeInteger(state.activeVersion) ||
        (state.activeVersion as number) < 0 ||
        !Number.isSafeInteger(state.activeEpoch) ||
        (state.activeEpoch as number) < 1 ||
        (state.lastMigrationId !== undefined &&
            state.lastMigrationId !== null &&
            typeof state.lastMigrationId !== "string") ||
        (state.status !== "active" && state.status !== "migrating") ||
        (state.migrationId !== null && typeof state.migrationId !== "string") ||
        (state.targetVersion !== null &&
            (!Number.isSafeInteger(state.targetVersion) || (state.targetVersion as number) < 1)) ||
        (state.status === "active" && (state.migrationId !== null || state.targetVersion !== null)) ||
        (state.status === "migrating" &&
            (typeof state.migrationId !== "string" ||
                !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(state.migrationId) ||
                typeof state.targetVersion !== "number" ||
                state.targetVersion <= (state.activeVersion as number)))
    ) {
        throw new Error("migration endpoint returned an invalid state");
    }
    return {
        activeVersion: state.activeVersion as number,
        activeEpoch: state.activeEpoch as number,
        lastMigrationId: typeof state.lastMigrationId === "string" ? state.lastMigrationId : null,
        status: state.status as MigrationState["status"],
        migrationId: state.migrationId as string | null,
        targetVersion: state.targetVersion as number | null,
    };
}

function parseMigrationShard(value: unknown): MigrationShard {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("migration endpoint returned an invalid shard state");
    }
    const shard = value as Record<string, unknown>;
    if (
        typeof shard.shardId !== "string" ||
        shard.shardId.length < 1 ||
        shard.shardId.length > 256 ||
        (shard.status !== "pending" && shard.status !== "active") ||
        (shard.lastError !== undefined && shard.lastError !== null && typeof shard.lastError !== "string")
    ) {
        throw new Error("migration endpoint returned an invalid shard state");
    }
    return {
        shardId: shard.shardId,
        status: shard.status,
        lastError: typeof shard.lastError === "string" ? shard.lastError.slice(0, 512) : null,
    };
}

function parseMigrationShards(value: unknown): readonly MigrationShard[] {
    if (!Array.isArray(value)) throw new Error("migration endpoint returned an invalid shard list");
    return value.map(parseMigrationShard);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function boundedText(value: string): string {
    return value.length <= ERROR_DETAIL_MAX_CHARS ? value : `${value.slice(0, ERROR_DETAIL_MAX_CHARS)}...[truncated]`;
}

function boundedErrorMessage(error: unknown): string {
    return boundedText(errorMessage(error));
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
