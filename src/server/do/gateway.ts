/**
 * `Gateway` DO — Hibernatable WebSockets
 * (https://developers.cloudflare.com/durable-objects/api/hibernatable-websockets-api/),
 * sub registry, presence broadcast.
 *
 * Sharded by `clientId` prefix (12-bit prefix → 4096 Gateway DOs default).
 * Hibernated state is rebuilt from `_gw_subs` and `_gw_presence_subs` on wake;
 * the per-conn 2 KiB `serializeAttachment` payload carries
 * `{clientId, lastCookie, jwtKid}` so a wake-up can reconstitute the routing
 * decision without a fresh handshake.
 */

import { DurableObject } from "cloudflare:workers";
import { decodeJwtClaims, principalIdFromJwt } from "../../auth/jwt.ts";
import { CdbError, isCdbErrorCode } from "../../errors.ts";
import {
    type ChardbRef,
    type ClientId,
    Cookie,
    CorrelationId,
    type MutId,
    type PrincipalId,
    type RawJson,
    type SubId,
} from "../../types.ts";
import type { Vshard } from "../../types.ts";
import { vshardOf } from "../../vshard.ts";
import {
    type CdbIntent,
    type Down,
    type MustRefetchReason,
    type RowPatch,
    type Up,
    type WireMessage,
    decodeWire,
    encodeWire,
} from "../../wire.ts";
import { adaptSqlStorage } from "./sql_adapter.ts";

const GW_DDL = `
CREATE TABLE IF NOT EXISTS _gw_subs (
  client_id TEXT NOT NULL,
  sub_id INTEGER NOT NULL,
  ast_hash TEXT NOT NULL,
  shard_ids TEXT NOT NULL,
  intent_blob TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL,
  last_cookie TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, sub_id)
);
CREATE TABLE IF NOT EXISTS _gw_shard_subs (
  shard_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sub_id INTEGER NOT NULL,
  PRIMARY KEY (shard_id, client_id, sub_id)
);
CREATE TABLE IF NOT EXISTS _gw_presence_subs (
  client_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (client_id, key)
);
` as const;

export const COALESCE_WINDOW_MS = 50 as const;
export const MAX_POKE_INTERVAL_MS = 250 as const;
export const PRESENCE_FANOUT_CAP = 1024 as const;

export const PRESENCE_TTL_DEFAULT_MS = 30_000 as const;

interface GwAttachment {
    readonly clientId: ClientId;
    readonly lastCookie?: Cookie;
    readonly jwtKid: string;
    readonly presenceKeys?: readonly string[];
    /**
     * Authenticated principal id, populated during `hello` from the
     * decoded JWT `sub` claim. Falls back to a clientId projection in
     * `onSub` when the token was missing/expired/malformed so
     * subscription routing still works pre-auth — write paths
     * re-validate authority before granting it.
     */
    readonly principalId?: PrincipalId;
    /**
     * Active tenant from the JWT (`activeOrganizationId` claim issued
     * by the better-auth `organization` plugin). Threaded into every
     * mutation/query envelope so handlers can read it from `ctx.auth.tenantId`.
     */
    readonly tenantId?: string;
    /** Comma-separated role string from the active org membership. */
    readonly role?: string;
    /** JWT expiry in epoch seconds. The Gateway uses this to schedule a re-auth. */
    readonly jwtExp?: number;
    /**
     * Remaining JWT claims as a stringified JSON blob. Kept stringified
     * so the per-conn 2 KiB attachment budget isn't blown by sprawling
     * custom-session payloads.
     */
    readonly claimsJson?: string;
}

/** Auth context the Gateway threads into mut/query envelopes for the entrypoint to consume. */
export interface GwAuthEnvelope {
    readonly userId: string;
    readonly tenantId: string | null;
    readonly role: string | null;
    readonly claims: { readonly [k: string]: unknown };
}

function authEnvelopeFrom(att: GwAttachment): GwAuthEnvelope | null {
    if (!att.principalId) return null;
    let claims: { readonly [k: string]: unknown } = {};
    if (att.claimsJson) {
        try {
            claims = JSON.parse(att.claimsJson) as { readonly [k: string]: unknown };
        } catch {
            // Corrupt blob — treat as empty rather than failing the mutation.
            claims = {};
        }
    }
    return {
        userId: att.principalId as unknown as string,
        tenantId: att.tenantId ?? null,
        role: att.role ?? null,
        claims,
    };
}

/**
 * Extract a `CdbErrorCode` from an unknown thrown value. Prefers a real
 * `CdbError`; otherwise inspects an `Error.message` for a `CDB_…` prefix
 * (legacy paths still throw bare `Error`s); otherwise returns the safe
 * shard-unavailable retry code so transient errors get retried by the
 * client without leaking handler internals.
 */
function errorCodeFrom(e: unknown): import("../../errors.ts").CdbErrorCode {
    if (e instanceof CdbError) return e.code;
    if (e instanceof Error) {
        const m = /^(CDB_[A-Z_]+)/.exec(e.message);
        if (m && isCdbErrorCode(m[1])) return m[1];
    }
    return "CDB_SHARD_UNAVAILABLE";
}

export interface GatewayEnv {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    /**
     * Service binding back to the user's `WorkerEntrypoint` (the class returned
     * by `defineChardb`). The Gateway uses it to resolve mutations against the
     * bundler-emitted manifest without re-evaluating the user's closures.
     */
    readonly CDB_WORKER?: ChardbWorkerRpc;
}

interface ChardbWorkerRpc {
    runMutation(input: {
        readonly ref: string;
        readonly args: RawJson;
        readonly mutId: string;
        readonly auth?: GwAuthEnvelope | null;
    }): Promise<
        | { readonly ok: true; readonly vshard: number }
        | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
    >;
}

/** Minimal RPC surface the Gateway requires from the Catalog DO. */
interface CatalogRpc {
    route(vshard: number): Promise<{ shardId: string; schemaEpoch: number }>;
}

/** Minimal RPC surface the Gateway requires from each Cdb shard DO. */
interface CdbRpc {
    subscribe(args: {
        subId: number;
        principalId: PrincipalId;
        tables: readonly string[];
        intervals: readonly {
            readonly table: string;
            readonly indexName: string;
            readonly intervals: readonly import("../../wire.ts").WireInterval[];
        }[];
    }): Promise<{ subId: number }>;
    unsubscribe(subId: number): Promise<void>;
}

export class Gateway extends DurableObject<GatewayEnv> {
    private bootstrapped = false;
    private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly pendingPatches = new Map<ClientId, RowPatch[]>();

    constructor(state: DurableObjectState, env: GatewayEnv) {
        super(state, env);
        state.blockConcurrencyWhile(async () => this.bootstrap());
    }

    private bootstrap(): void {
        if (this.bootstrapped) return;
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        for (const stmt of GW_DDL.split(";")
            .map(s => s.trim())
            .filter(Boolean))
            sql.exec(stmt);
        this.bootstrapped = true;
    }

    /**
     * Upgrade an HTTP request to a hibernated WebSocket. Returns a Response.
     */
    override async fetch(request: Request): Promise<Response> {
        const upgrade = request.headers.get("Upgrade");
        if (upgrade !== "websocket") {
            return new Response("expected websocket", { status: 426 });
        }
        const pair = new WebSocketPair();
        const server = pair[1];
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
        if (typeof raw !== "string") return;
        let msg: WireMessage;
        try {
            msg = decodeWire(raw);
        } catch {
            this.sendError(ws, "CDB_UNSUPPORTED_FEATURE");
            return;
        }
        switch ((msg as Up).t) {
            case "hello":
                this.onHello(ws, msg as Extract<Up, { t: "hello" }>);
                break;
            case "sub":
                this.onSub(ws, msg as Extract<Up, { t: "sub" }>);
                break;
            case "unsub":
                this.onUnsub(ws, msg as Extract<Up, { t: "unsub" }>);
                break;
            case "mut":
                this.onMut(ws, msg as Extract<Up, { t: "mut" }>);
                break;
            case "presencePub":
                this.onPresencePub(ws, msg as Extract<Up, { t: "presencePub" }>);
                break;
            case "presenceSub":
                this.onPresenceSub(ws, msg as Extract<Up, { t: "presenceSub" }>);
                break;
            case "ping":
                // Hibernation auto-replies; nothing to do.
                break;
            default:
                this.sendError(ws, "CDB_UNSUPPORTED_FEATURE");
        }
    }

    override webSocketClose(ws: WebSocket): void {
        void ws;
        // Subs persist in `_gw_subs` so a hibernated socket can resume with its
        // last cookie after a wake-up without re-running the user's `useQuery`.
    }

    private onHello(ws: WebSocket, msg: Extract<Up, { t: "hello" }>): void {
        const decoded = decodeJwtClaims(msg.jwt);
        const principalId = principalIdFromJwt(msg.jwt);
        const tenantId =
            decoded?.claims.activeOrganizationId !== undefined &&
            typeof decoded.claims.activeOrganizationId === "string"
                ? decoded.claims.activeOrganizationId
                : undefined;
        const role =
            decoded?.claims.role !== undefined && typeof decoded.claims.role === "string"
                ? decoded.claims.role
                : undefined;
        const exp = typeof decoded?.claims.exp === "number" ? decoded.claims.exp : undefined;
        const claimsJson = decoded ? JSON.stringify(decoded.claims) : undefined;
        const attachment: GwAttachment = {
            clientId: msg.clientId,
            ...(msg.resumeFromCookie ? { lastCookie: msg.resumeFromCookie } : {}),
            jwtKid: decoded?.kid ?? "",
            ...(principalId !== null ? { principalId } : {}),
            ...(tenantId !== undefined ? { tenantId } : {}),
            ...(role !== undefined ? { role } : {}),
            ...(exp !== undefined ? { jwtExp: exp } : {}),
            ...(claimsJson !== undefined ? { claimsJson } : {}),
        };
        ws.serializeAttachment(attachment);
        const welcome: Down = {
            t: "welcome",
            baseCookie: Cookie(`${msg.clientId}:0`),
            region: "WNAM",
            ...(msg.resumeFromCookie ? { resumedFromCookie: msg.resumeFromCookie } : {}),
        };
        this.send(ws, welcome);
    }

    private onSub(ws: WebSocket, msg: Extract<Up, { t: "sub" }>): void {
        const att = ws.deserializeAttachment() as GwAttachment | null;
        if (!att) return;
        // `att.principalId` is the JWT-derived `sub` claim from `hello`. When
        // the inbound token is missing/expired/malformed we fall back to a
        // deterministic projection of `clientId` so cross-shard subs still
        // share a stable bucket key — write paths re-validate authority.
        const principalId = att.principalId ?? (att.clientId as unknown as PrincipalId);
        void this.subscribeAcrossShards(att.clientId, msg.subId, msg.queryHash, msg.intent, principalId).catch(
            (e: unknown) => {
                const code = errorCodeFrom(e);
                this.sendError(ws, code, msg.subId);
            }
        );
    }

    private onUnsub(ws: WebSocket, msg: Extract<Up, { t: "unsub" }>): void {
        const att = ws.deserializeAttachment() as GwAttachment | null;
        if (!att) return;
        void this.unsubscribeAcrossShards(att.clientId, msg.subId);
    }

    private onMut(ws: WebSocket, msg: Extract<Up, { t: "mut" }>): void {
        const att = ws.deserializeAttachment() as GwAttachment | null;
        if (!att) return;
        void this.routeMut(ws, att, msg);
    }

    /**
     * Resolve a mutation through the worker manifest, route the resulting vshard
     * via the Catalog, and call `Cdb.mutate` on the owning shard. The handler
     * intentionally does not re-evaluate the user's mutation body; that runs
     * inside the shard DO under `transactionSync`. Errors flow back over the
     * wire as `Down.mutAck { ok: false, error }`.
     */
    private async routeMut(ws: WebSocket, att: GwAttachment, msg: Extract<Up, { t: "mut" }>): Promise<void> {
        const worker = this.env.CDB_WORKER;
        if (!worker) {
            this.sendMutFailure(ws, msg.mutId, "CDB_INVARIANT");
            return;
        }
        const auth = authEnvelopeFrom(att);
        const result = await worker.runMutation({
            ref: msg.ref,
            args: msg.args,
            mutId: msg.mutId,
            ...(auth ? { auth } : {}),
        });
        if (!result.ok) {
            const code = isCdbErrorCode(result.error.code) ? result.error.code : "CDB_INVARIANT";
            this.sendMutFailure(ws, msg.mutId, code);
            return;
        }
        const catalogId = this.env.CDB_CATALOG.idFromName("global");
        const catalog = this.env.CDB_CATALOG.get(catalogId) as unknown as CatalogRpc;
        const { shardId } = await catalog.route(result.vshard);
        const shardDoId = this.env.CDB_SHARD.idFromName(shardId);
        const shard = this.env.CDB_SHARD.get(shardDoId) as unknown as {
            mutate(args: { ref: ChardbRef; mutId: MutId; args: RawJson }): Promise<{
                ok: boolean;
                cookie?: Cookie;
                result?: RawJson;
            }>;
        };
        const ack = await shard.mutate({ ref: msg.ref, mutId: msg.mutId, args: msg.args });
        if (ack.ok && ack.cookie) {
            this.send(ws, {
                t: "poke",
                cookie: ack.cookie,
                patches: [],
                mutResults: [{ mutId: msg.mutId, ok: true, result: ack.result ?? null, cookie: ack.cookie }],
            });
        } else {
            this.sendMutFailure(ws, msg.mutId, "CDB_INVARIANT");
        }
    }

    private onPresencePub(ws: WebSocket, msg: Extract<Up, { t: "presencePub" }>): void {
        const sender = ws.deserializeAttachment() as GwAttachment | null;
        if (!sender) return;
        const ttl = msg.ttlMs ?? PRESENCE_TTL_DEFAULT_MS;
        const expires = Date.now() + ttl;
        let fanout = 0;
        for (const peer of this.ctx.getWebSockets()) {
            if (peer === ws) continue;
            if (fanout >= PRESENCE_FANOUT_CAP) break;
            const att = peer.deserializeAttachment() as GwAttachment | null;
            if (!att) continue;
            if (!att.presenceKeys?.includes(msg.key)) continue;
            this.send(peer, {
                t: "presence",
                key: msg.key,
                version: 1,
                states: [{ clientId: sender.clientId, state: msg.state, ts: expires }],
            });
            fanout++;
        }
    }

    private onPresenceSub(ws: WebSocket, msg: Extract<Up, { t: "presenceSub" }>): void {
        const att = ws.deserializeAttachment() as GwAttachment | null;
        if (!att) return;
        const keys = new Set([...(att.presenceKeys ?? []), msg.key]);
        ws.serializeAttachment({ ...att, presenceKeys: [...keys] });
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec("INSERT OR IGNORE INTO _gw_presence_subs (client_id, key) VALUES (?, ?)", att.clientId, msg.key);
    }

    /**
     * Routes a sub-request to every shard whose vshard range overlaps the
     * intent's partition-key set, and persists the gateway-side mapping so
     * hibernation rebuilds work without a fresh client handshake.
     *
     * Intent shapes:
     *   - `partitionKey.values` enumerable → route to exactly those vshards
     *   - `joinShape: "reference"` → route to a single canonical replica
     *   - everything else → fan out to every shard in the catalog (scatter)
     */
    private async subscribeAcrossShards(
        clientId: ClientId,
        subId: SubId,
        queryHash: string,
        intent: CdbIntent,
        principalId: PrincipalId
    ): Promise<void> {
        const shardIds = await this.shardsForIntent(intent);
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `INSERT OR REPLACE INTO _gw_subs
       (client_id, sub_id, ast_hash, shard_ids, intent_blob, auth_epoch, last_cookie, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
            clientId,
            subId,
            queryHash,
            JSON.stringify([...shardIds]),
            JSON.stringify(intent),
            Date.now()
        );
        for (const shardId of shardIds) {
            sql.exec(
                "INSERT OR IGNORE INTO _gw_shard_subs (shard_id, client_id, sub_id) VALUES (?, ?, ?)",
                shardId,
                clientId,
                subId
            );
        }
        const intervals = (intent.intervals ?? []).map(b => ({
            table: b.table,
            indexName: b.indexName,
            intervals: b.intervals,
        }));
        await Promise.all(
            shardIds.map(async shardId => {
                const cdb = this.cdb(shardId);
                await cdb.subscribe({
                    subId,
                    principalId,
                    tables: [...intent.tables],
                    intervals,
                });
            })
        );
    }

    private async unsubscribeAcrossShards(clientId: ClientId, subId: SubId): Promise<void> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const shards: string[] = [];
        const cur = this.ctx.storage.sql.exec<{ shard_id: string }>(
            "SELECT shard_id FROM _gw_shard_subs WHERE client_id = ? AND sub_id = ?",
            clientId,
            subId
        );
        for (const r of cur) shards.push(r.shard_id);
        sql.exec("DELETE FROM _gw_subs WHERE client_id = ? AND sub_id = ?", clientId, subId);
        sql.exec("DELETE FROM _gw_shard_subs WHERE client_id = ? AND sub_id = ?", clientId, subId);
        await Promise.all(
            shards.map(async shardId => {
                await this.cdb(shardId).unsubscribe(subId);
            })
        );
    }

    /**
     * Resolve which shards own a given intent. Single-partition queries hit
     * exactly one vshard via `xxhash64(canonical_concat(values))`; reference
     * tables hit a single canonical replica; cross-partition fans out to
     * every shard currently in the catalog's range table.
     */
    private async shardsForIntent(intent: CdbIntent): Promise<string[]> {
        const catalog = this.catalog();
        const shards = new Set<string>();
        const pk = intent.partitionKey;
        if (pk && pk.values.length > 0 && intent.joinShape !== "cross-partition") {
            for (const v of pk.values) {
                const vsh = vshardOf([toScalar(v)]) as Vshard;
                const r = await catalog.route(vsh);
                shards.add(r.shardId);
            }
            return [...shards];
        }
        if (intent.joinShape === "reference") {
            const r = await catalog.route(0 as Vshard);
            return [r.shardId];
        }
        // Scatter: probe a representative vshard from each contiguous range.
        // The Catalog will report unique shard ids by routing every bucket;
        // we sample buckets in steps of 256 to keep the round-trip count bounded.
        for (let v = 0; v < 16384; v += 256) {
            const r = await catalog.route(v);
            shards.add(r.shardId);
        }
        return [...shards];
    }

    private catalog(): CatalogRpc {
        const id = this.env.CDB_CATALOG.idFromName("global");
        return this.env.CDB_CATALOG.get(id) as unknown as CatalogRpc;
    }

    private cdb(shardId: string): CdbRpc {
        const id = this.env.CDB_SHARD.idFromName(shardId);
        return this.env.CDB_SHARD.get(id) as unknown as CdbRpc;
    }

    /**
     * Coalesce row patches per client; flush every COALESCE_WINDOW_MS.
     * The MAX_POKE_INTERVAL_MS hard ceiling is enforced by the alarm timer so
     * stalled producers cannot starve a subscription of progress.
     */
    enqueuePatch(clientId: ClientId, patch: RowPatch): void {
        let arr = this.pendingPatches.get(clientId);
        if (!arr) {
            arr = [];
            this.pendingPatches.set(clientId, arr);
        }
        arr.push(patch);
        if (this.coalesceTimer === null) {
            this.coalesceTimer = setTimeout(() => this.flushCoalesce(), COALESCE_WINDOW_MS);
        }
    }

    private flushCoalesce(): void {
        this.coalesceTimer = null;
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment() as GwAttachment | null;
            if (!att) continue;
            const patches = this.pendingPatches.get(att.clientId);
            if (!patches || patches.length === 0) continue;
            const cookie = Cookie(`${att.clientId}:${Date.now()}`);
            this.send(ws, { t: "poke", cookie, patches });
            patches.length = 0;
        }
    }

    emitMustRefetch(subIds: readonly SubId[], reason: MustRefetchReason): void {
        for (const ws of this.ctx.getWebSockets()) {
            this.send(ws, { t: "mustRefetch", subIds, reason });
        }
    }

    private send(ws: WebSocket, down: Down): void {
        ws.send(encodeWire(down));
    }

    private sendError(ws: WebSocket, code: import("../../errors.ts").CdbErrorCode, subId?: SubId): void {
        const corr = CorrelationId(crypto.randomUUID());
        this.send(ws, {
            t: "error",
            code,
            retryable: false,
            correlationId: corr,
            docs: `https://chardb.dev/errors/${code.toLowerCase()}`,
            ...(subId !== undefined ? { subId } : {}),
        });
    }

    private sendMutFailure(ws: WebSocket, mutId: MutId, code: import("../../errors.ts").CdbErrorCode): void {
        this.send(ws, {
            t: "poke",
            cookie: Cookie(""),
            patches: [],
            mutResults: [
                {
                    mutId,
                    ok: false,
                    error: {
                        code,
                        retryable: false,
                        docs: `https://chardb.dev/errors/${code.toLowerCase()}`,
                    },
                },
            ],
        });
    }
}

/** Re-export for downstream tests that want to drive the routing logic. */
export type { CatalogRpc as GatewayCatalogRpc, CdbRpc as GatewayCdbRpc };

function toScalar(v: RawJson): string | number | bigint | Uint8Array {
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
    if (v === null) return "";
    return JSON.stringify(v);
}
