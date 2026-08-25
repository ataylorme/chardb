import type { CliContext, CliFetch } from "../context.ts";

export interface MigrateOptions {
    readonly baseUrl: string;
    readonly token: string;
    readonly migrationId: string;
    readonly targetVersion: number;
    readonly concurrency: number;
    readonly baseline?: boolean;
    readonly fetch: CliFetch;
}

interface MigrationState {
    readonly activeVersion: number;
    readonly activeEpoch: number;
    readonly status: "active" | "migrating";
    readonly migrationId: string | null;
    readonly targetVersion: number | null;
}

interface MigrationShard {
    readonly shardId: string;
    readonly status: "pending" | "active";
}

const RESPONSE_MAX_BYTES = 4 * 1_024 * 1_024;

export async function runMigrate(ctx: CliContext, opts: MigrateOptions): Promise<void> {
    assertMigrateOptions(opts);
    const baseUrl = opts.baseUrl.replace(/\/$/, "");
    const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
        const response = await opts.fetch(`${baseUrl}/_chardb/migrations/${path}`, {
            ...init,
            headers: {
                authorization: `Bearer ${opts.token}`,
                ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
            },
        });
        const text = await boundedResponseText(response);
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            throw new Error(`migration endpoint returned ${response.status} with invalid JSON`);
        }
        if (!response.ok || typeof body !== "object" || body === null || Array.isArray(body)) {
            const message =
                typeof body === "object" && body !== null && !Array.isArray(body)
                    ? String((body as Record<string, unknown>).error ?? response.statusText)
                    : response.statusText;
            throw new Error(`migration endpoint returned ${response.status}: ${message}`);
        }
        return body as Record<string, unknown>;
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
            const result = await request("shard", {
                method: "POST",
                body: JSON.stringify({ migrationId: opts.migrationId, shardId: shard.shardId }),
            });
            const activated = parseMigrationShard(result.shard);
            if (activated.shardId !== shard.shardId || activated.status !== "active") {
                throw new Error(`Catalog did not activate shard ${shard.shardId}`);
            }
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
    if (active.status !== "active" || active.activeVersion !== opts.targetVersion) {
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
}

async function boundedResponseText(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
        const bytes = Number(declared);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > RESPONSE_MAX_BYTES) {
            throw new Error("migration response has an invalid content length");
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
            throw new Error("migration response is too large");
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
    return state as unknown as MigrationState;
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
        (shard.status !== "pending" && shard.status !== "active")
    ) {
        throw new Error("migration endpoint returned an invalid shard state");
    }
    return { shardId: shard.shardId, status: shard.status };
}

function parseMigrationShards(value: unknown): readonly MigrationShard[] {
    if (!Array.isArray(value)) throw new Error("migration endpoint returned an invalid shard list");
    return value.map(parseMigrationShard);
}
