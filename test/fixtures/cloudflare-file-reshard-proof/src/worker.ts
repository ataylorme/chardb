import { DurableObject } from "cloudflare:workers";
import { type ChardbBinding, client } from "@chardb/core";
import { chardb } from "@chardb/core/server";
import * as api from "./api.ts";
import { auth } from "./auth.ts";
import { migrations } from "./migrations.ts";
import { FILE_RESHARD_PROOF_VECTOR, proofVectorValues } from "./proof-config.ts";
import * as schema from "./schema.ts";
import {
    type CdbVectorizeMutationIndex,
    type CdbVectorizeRecord,
    type CdbVectorizeSearchIndex,
    cdbVectorizePhysicalId,
} from "./vector-proof.ts";

const CAPABILITIES_SCHEMA = "chardb.file-vector-reshard-proof-capabilities.v3";
const CLEANUP_SCHEMA = "chardb.file-reshard-proof-cleanup.v2";
const FAULT_SCHEMA = "chardb.file-reshard-proof-fault.v1";
const SAMPLE_SCHEMA = "chardb.file-vector-reshard-deployment-sample.v3";
const PHASES = [
    "setup",
    "init",
    "snapshot",
    "bulk",
    "converge",
    "barrierValidateCutover",
    "drain",
    "finish",
    "verify",
] as const;
const PROFILES = {
    small: { name: "small", organizations: 3, files: 16, logicalRuns: 3, ciDefault: true },
    medium: { name: "medium", organizations: 3, files: 256, logicalRuns: 3, ciDefault: false },
    large: { name: "large", organizations: 3, files: 2_048, logicalRuns: 3, ciDefault: false },
} as const;
const DEPLOYED_BINDINGS = ["CDB_CATALOG", "CDB_FILES", "CDB_PROOF_VECTORS", "CDB_RESHARD", "CDB_SHARD"] as const;
const LOCAL_BINDINGS = ["CDB_CATALOG", "CDB_FILES", "CDB_RESHARD", "CDB_SHARD", "CDB_VECTOR_PROBE"] as const;
const TERMINAL_PHASE = 6;
const SNAPSHOT_COMMITTED_PHASE = 2;
const MAX_DRIVE_TURNS = 16_384;
const CLEANUP_BATCH_SIZE = 500;

interface ProofEnv {
    readonly DB: ChardbBinding;
    readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
    readonly CDB_ADMIN_TOKEN: string;
    readonly CDB_CATALOG?: DurableObjectNamespace;
    readonly Catalog?: DurableObjectNamespace;
    readonly CDB_SHARD?: DurableObjectNamespace;
    readonly Cdb?: DurableObjectNamespace;
    readonly CDB_FILES: R2Bucket;
    readonly CDB_PROOF_VECTORS: VectorizeIndex;
    readonly CDB_VECTOR_PROBE?: DurableObjectNamespace;
    readonly CDB_PROOF_CONFIGURATION_SHA256: string;
    readonly CDB_PROOF_LOCAL_VERSION?: string;
    readonly CDB_PROOF_RUN_ID: string;
    readonly CDB_PROOF_R2_BUCKET: string;
    readonly CDB_PROOF_RUNTIME: string;
    readonly CDB_PROOF_TARGET_KIND: "local" | "deployed";
    readonly CDB_PROOF_VECTORIZE_INDEX: string;
    readonly CDB_RELEASE_SHA256: string;
}

function deploymentVersion(env: ProofEnv): string {
    const version =
        env.CDB_PROOF_TARGET_KIND === "deployed" ? env.CF_VERSION_METADATA?.id : env.CDB_PROOF_LOCAL_VERSION;
    if (typeof version !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(version)) {
        throw new Error(
            env.CDB_PROOF_TARGET_KIND === "deployed"
                ? "Cloudflare Worker version metadata is unavailable"
                : "local proof version is unavailable"
        );
    }
    return version;
}

interface ProofRequest {
    readonly runId: string;
    readonly runKey: string;
    readonly sequence: number;
    readonly excluded: boolean;
    readonly candidateSha256: string;
    readonly profile: (typeof PROFILES)[keyof typeof PROFILES];
    readonly fault: { readonly operation: "apply_snapshot"; readonly mode: "commit-then-response-loss-once" };
}

interface Receipt {
    readonly runKey: string;
    readonly requestSha256: string;
    readonly stage: "claimed" | "faulted" | "completed";
    readonly payload: Record<string, unknown>;
}

interface ClaimResult {
    readonly receipt: Receipt;
    readonly claimed: boolean;
}

interface CleanupBatch {
    readonly cursor: number;
    readonly nextCursor: number;
    readonly remaining: number;
    readonly keys: readonly string[];
    readonly pendingDeleted: number | null;
    readonly done: boolean;
    readonly doneAfterCommit: boolean;
}

interface Principal {
    cookie: string;
    token: string;
    userId: string;
}

interface FileRecord {
    readonly organizationId: string;
    readonly rowId: string;
    readonly fileId: string;
    readonly vectorId: string;
    readonly values: readonly number[];
    readonly bytes: number;
    readonly contentSha256: string;
}

interface VectorEvidence {
    readonly heads: number;
    readonly readyHeads: number;
    readonly outbox: number;
    readonly attempts: number;
    readonly headDigest: string;
    readonly outboxDigest: string;
    readonly attemptDigest: string;
    readonly physicalIds: readonly string[];
    readonly physicalIdentityDigest: string;
    readonly providerRecords: number;
    readonly providerMutationCalls: { readonly upsert: number; readonly delete: number } | null;
}

interface R2Inventory {
    readonly objects: number;
    readonly bytes: number;
    readonly digest: string;
}

interface ReshardState {
    readonly migrationId: string;
    readonly phase: number;
    readonly phaseName: string;
    readonly terminal: boolean;
    readonly sourceShard: string;
    readonly destinationShard: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
}

const app = chardb({ ownership: "organization", auth, authBasePath: "/api/auth", schema, api, migrations });
interface ProofExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
}

function exact(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new TypeError(`${label} fields are invalid`);
    }
}

function string(value: unknown, label: string, pattern: RegExp): asserts value is string {
    if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
}

function parseRequest(value: unknown): ProofRequest {
    exact(value, ["runId", "runKey", "sequence", "excluded", "candidateSha256", "profile", "fault"], "proof request");
    string(value.runId, "runId", /^[A-Za-z0-9_-]{16,80}$/);
    string(value.runKey, "runKey", /^[A-Za-z0-9_-]{16,128}$/);
    string(value.candidateSha256, "candidateSha256", /^[a-f0-9]{64}$/);
    if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < -1)
        throw new TypeError("sequence is invalid");
    if (value.excluded !== (value.sequence === -1)) throw new TypeError("excluded does not match sequence");
    exact(value.profile, ["name", "organizations", "files", "logicalRuns", "ciDefault"], "profile");
    const profile =
        typeof value.profile.name === "string" ? PROFILES[value.profile.name as keyof typeof PROFILES] : undefined;
    if (!profile || JSON.stringify(value.profile) !== JSON.stringify(profile))
        throw new TypeError("profile is invalid");
    exact(value.fault, ["operation", "mode"], "fault");
    if (value.fault.operation !== "apply_snapshot" || value.fault.mode !== "commit-then-response-loss-once") {
        throw new TypeError("fault is invalid");
    }
    return value as unknown as ProofRequest;
}

async function hexDigest(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sameSecret(left: string, right: string): Promise<boolean> {
    const [a, b] = await Promise.all([hexDigest(left), hexDigest(right)]);
    let difference = a.length ^ b.length;
    for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return difference === 0 && left.length > 0;
}

async function authorized(request: Request, env: ProofEnv, runId: string): Promise<boolean> {
    const header = request.headers.get("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    return (
        runId === env.CDB_PROOF_RUN_ID &&
        request.headers.get("x-chardb-proof-run-id") === env.CDB_PROOF_RUN_ID &&
        (await sameSecret(bearer, env.CDB_ADMIN_TOKEN))
    );
}

function ensureProofTables(storage: DurableObjectStorage): void {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_receipts (
      run_key TEXT PRIMARY KEY,
      request_sha256 TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('claimed', 'faulted', 'completed')),
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_cleanup (
      run_key TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL,
      remaining INTEGER NOT NULL,
      pending_next_cursor INTEGER,
      pending_deleted INTEGER,
      updated_at INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_cleanup_manifest (
      run_key TEXT PRIMARY KEY,
      keys_json TEXT NOT NULL,
      initial_remaining INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
}

export class Catalog extends app.Catalog {
    proofReceipt(input: { runKey: string; requestSha256: string }): Receipt | null {
        ensureProofTables(this.ctx.storage);
        const row = this.ctx.storage.sql
            .exec<{ run_key: string; request_sha256: string; stage: Receipt["stage"]; payload_json: string }>(
                "SELECT run_key, request_sha256, stage, payload_json FROM proof_receipts WHERE run_key = ?",
                input.runKey
            )
            .toArray()[0];
        if (!row) return null;
        if (row.request_sha256 !== input.requestSha256) throw new Error("proof run key was reused with another body");
        return {
            runKey: row.run_key,
            requestSha256: row.request_sha256,
            stage: row.stage,
            payload: JSON.parse(row.payload_json),
        };
    }

    proofClaim(input: { runKey: string; requestSha256: string }): ClaimResult {
        return this.ctx.storage.transactionSync(() => {
            ensureProofTables(this.ctx.storage);
            const existing = this.proofReceipt(input);
            if (existing) return { receipt: existing, claimed: false };
            this.ctx.storage.sql.exec(
                "INSERT INTO proof_receipts (run_key, request_sha256, stage, payload_json, updated_at) VALUES (?, ?, 'claimed', '{}', ?)",
                input.runKey,
                input.requestSha256,
                Date.now()
            );
            this.ctx.storage.sql.exec(
                "INSERT INTO proof_cleanup_manifest (run_key, keys_json, initial_remaining, created_at) VALUES (?, '[]', 0, ?)",
                input.runKey,
                Date.now()
            );
            return {
                receipt: { runKey: input.runKey, requestSha256: input.requestSha256, stage: "claimed", payload: {} },
                claimed: true,
            };
        });
    }

    proofAppendCleanupKey(input: { runKey: string; key: string }): void {
        this.ctx.storage.transactionSync(() => {
            ensureProofTables(this.ctx.storage);
            const manifest = this.ctx.storage.sql
                .exec<{ keys_json: string }>(
                    "SELECT keys_json FROM proof_cleanup_manifest WHERE run_key = ?",
                    input.runKey
                )
                .toArray()[0];
            if (!manifest) throw new Error("proof cleanup manifest is unavailable");
            const keys = JSON.parse(manifest.keys_json) as unknown;
            if (!Array.isArray(keys) || !keys.every(key => typeof key === "string")) {
                throw new Error("proof cleanup manifest is malformed");
            }
            if (keys.includes(input.key)) return;
            if (keys.length >= 512 || !/^_chardb\/retained\/sha256\/[a-f0-9]{64}$/.test(input.key)) {
                throw new TypeError("proof cleanup key is invalid");
            }
            const next = [...keys, input.key];
            this.ctx.storage.sql.exec(
                "UPDATE proof_cleanup_manifest SET keys_json = ?, initial_remaining = ?, created_at = ? WHERE run_key = ?",
                JSON.stringify(next),
                next.length,
                Date.now(),
                input.runKey
            );
        });
    }

    proofAdvance(input: {
        runKey: string;
        requestSha256: string;
        from: Receipt["stage"];
        to: Receipt["stage"];
        payload: Record<string, unknown>;
    }): Receipt {
        return this.ctx.storage.transactionSync(() => {
            const existing = this.proofReceipt(input);
            if (!existing) throw new Error("proof receipt is missing");
            if (existing.stage === input.to) return existing;
            if (existing.stage !== input.from) throw new Error(`proof receipt cannot advance from ${existing.stage}`);
            if (input.from === "faulted" && input.to === "completed") {
                const files = existing.payload.files as FileRecord[] | undefined;
                const alarm = input.payload.alarm as { retainedObjects?: unknown } | undefined;
                const retainedObjects = alarm?.retainedObjects;
                if (!Array.isArray(files) || !Number.isSafeInteger(retainedObjects)) {
                    throw new Error("completed proof receipt has no cleanup manifest");
                }
                const manifest = this.ctx.storage.sql
                    .exec<{ keys_json: string }>(
                        "SELECT keys_json FROM proof_cleanup_manifest WHERE run_key = ?",
                        input.runKey
                    )
                    .toArray()[0];
                const expectedKeys = files.map(file => `_chardb/retained/sha256/${file.contentSha256}`);
                if (!manifest || JSON.stringify(JSON.parse(manifest.keys_json)) !== JSON.stringify(expectedKeys)) {
                    throw new Error("completed proof cleanup manifest drifted from seeded files");
                }
                this.ctx.storage.sql.exec(
                    "UPDATE proof_cleanup_manifest SET initial_remaining = ?, created_at = ? WHERE run_key = ?",
                    retainedObjects as number,
                    Date.now(),
                    input.runKey
                );
            }
            this.ctx.storage.sql.exec(
                "UPDATE proof_receipts SET stage = ?, payload_json = ?, updated_at = ? WHERE run_key = ? AND request_sha256 = ?",
                input.to,
                JSON.stringify(input.payload),
                Date.now(),
                input.runKey,
                input.requestSha256
            );
            return {
                runKey: input.runKey,
                requestSha256: input.requestSha256,
                stage: input.to,
                payload: input.payload,
            };
        });
    }

    proofCleanupBatch(input: { runKey: string }): CleanupBatch {
        return this.ctx.storage.transactionSync(() => {
            ensureProofTables(this.ctx.storage);
            const manifest = this.ctx.storage.sql
                .exec<{ keys_json: string; initial_remaining: number }>(
                    "SELECT keys_json, initial_remaining FROM proof_cleanup_manifest WHERE run_key = ?",
                    input.runKey
                )
                .toArray()[0];
            if (!manifest) {
                const receipt = this.ctx.storage.sql
                    .exec<{ present: number }>(
                        "SELECT 1 AS present FROM proof_receipts WHERE run_key = ?",
                        input.runKey
                    )
                    .toArray()[0];
                if (receipt) throw new TypeError("claimed proof cleanup manifest is unavailable");
                return {
                    cursor: 0,
                    nextCursor: 0,
                    remaining: 0,
                    keys: [],
                    pendingDeleted: null,
                    done: true,
                    doneAfterCommit: true,
                };
            }
            const keys = JSON.parse(manifest.keys_json) as unknown;
            if (!Array.isArray(keys) || !keys.every(key => typeof key === "string")) {
                throw new Error("completed proof cleanup manifest is malformed");
            }
            this.ctx.storage.sql.exec(
                "INSERT OR IGNORE INTO proof_cleanup (run_key, cursor, remaining, pending_next_cursor, pending_deleted, updated_at) VALUES (?, 0, ?, NULL, NULL, ?)",
                input.runKey,
                manifest.initial_remaining,
                Date.now()
            );
            const state = this.ctx.storage.sql
                .exec<{
                    cursor: number;
                    remaining: number;
                    pending_next_cursor: number | null;
                    pending_deleted: number | null;
                }>(
                    "SELECT cursor, remaining, pending_next_cursor, pending_deleted FROM proof_cleanup WHERE run_key = ?",
                    input.runKey
                )
                .toArray()[0];
            if (!state) throw new Error("proof cleanup state is unavailable");
            const nextCursor = state.pending_next_cursor ?? Math.min(state.cursor + CLEANUP_BATCH_SIZE, keys.length);
            return {
                cursor: state.cursor,
                nextCursor,
                remaining: state.remaining,
                keys: keys.slice(state.cursor, nextCursor),
                pendingDeleted: state.pending_deleted,
                done: state.cursor >= keys.length,
                doneAfterCommit: nextCursor >= keys.length,
            };
        });
    }

    proofPrepareCleanup(input: { runKey: string; cursor: number; nextCursor: number; deleted: number }): void {
        this.ctx.storage.transactionSync(() => {
            const state = this.proofCleanupBatch({ runKey: input.runKey });
            if (state.done || state.pendingDeleted !== null) throw new Error("proof cleanup batch is already prepared");
            if (state.cursor !== input.cursor || state.nextCursor !== input.nextCursor) {
                throw new Error("proof cleanup cursor changed");
            }
            if (!Number.isSafeInteger(input.deleted) || input.deleted < 0 || input.deleted > state.keys.length) {
                throw new TypeError("proof cleanup deletion count is invalid");
            }
            this.ctx.storage.sql.exec(
                "UPDATE proof_cleanup SET pending_next_cursor = ?, pending_deleted = ?, updated_at = ? WHERE run_key = ? AND cursor = ? AND pending_next_cursor IS NULL",
                input.nextCursor,
                input.deleted,
                Date.now(),
                input.runKey,
                input.cursor
            );
        });
    }

    proofCommitCleanup(input: { runKey: string; cursor: number; nextCursor: number }): {
        deleted: number;
        remaining: number;
        done: boolean;
    } {
        return this.ctx.storage.transactionSync(() => {
            const state = this.proofCleanupBatch({ runKey: input.runKey });
            if (
                state.cursor !== input.cursor ||
                state.nextCursor !== input.nextCursor ||
                state.pendingDeleted === null
            ) {
                throw new Error("proof cleanup batch is not prepared");
            }
            const remaining = Math.max(0, state.remaining - state.pendingDeleted);
            this.ctx.storage.sql.exec(
                "UPDATE proof_cleanup SET cursor = ?, remaining = ?, pending_next_cursor = NULL, pending_deleted = NULL, updated_at = ? WHERE run_key = ? AND cursor = ? AND pending_next_cursor = ?",
                input.nextCursor,
                remaining,
                Date.now(),
                input.runKey,
                input.cursor,
                input.nextCursor
            );
            return { deleted: state.pendingDeleted, remaining, done: state.doneAfterCommit };
        });
    }
}

interface CatalogProofRpc {
    proofReceipt(input: { runKey: string; requestSha256: string }): Promise<Receipt | null>;
    proofClaim(input: { runKey: string; requestSha256: string }): Promise<ClaimResult>;
    proofAppendCleanupKey(input: { runKey: string; key: string }): Promise<void>;
    proofAdvance(input: {
        runKey: string;
        requestSha256: string;
        from: Receipt["stage"];
        to: Receipt["stage"];
        payload: Record<string, unknown>;
    }): Promise<Receipt>;
    proofCleanupBatch(input: { runKey: string }): Promise<CleanupBatch>;
    proofPrepareCleanup(input: { runKey: string; cursor: number; nextCursor: number; deleted: number }): Promise<void>;
    proofCommitCleanup(input: { runKey: string; cursor: number; nextCursor: number }): Promise<{
        deleted: number;
        remaining: number;
        done: boolean;
    }>;
    organizationDeletionPurgeStatus(input: { organizationId: string }): Promise<Record<string, unknown>>;
    route(vshard: number): Promise<{ shardId: string; schemaEpoch: number; domainSchemaEpoch: number }>;
}

function catalog(env: ProofEnv): CatalogProofRpc {
    const namespace = env.CDB_CATALOG ?? env.Catalog;
    if (!namespace) throw new Error("proof Catalog loopback is unavailable");
    return namespace.get(namespace.idFromName("global")) as unknown as CatalogProofRpc;
}

export class VectorIndexProbe extends DurableObject<Record<string, never>> {
    constructor(state: DurableObjectState, env: Record<string, never>) {
        super(state, env);
        state.blockConcurrencyWhile(async () => {
            this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_vector_calls (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'get', 'query')),
              ids_json TEXT NOT NULL
            )`);
            this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_vector_records (
              id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL
            )`);
        });
    }

    upsert(records: readonly CdbVectorizeRecord[]): { readonly ids: readonly string[]; readonly count: number } {
        const ids = records.map(record => record.id);
        this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
                "INSERT INTO proof_vector_calls (operation, ids_json) VALUES ('upsert', ?)",
                JSON.stringify(ids)
            );
            for (const record of records) {
                this.ctx.storage.sql.exec(
                    `INSERT INTO proof_vector_records (id, payload_json) VALUES (?, ?)
                     ON CONFLICT (id) DO UPDATE SET payload_json = excluded.payload_json`,
                    record.id,
                    JSON.stringify(record)
                );
            }
        });
        return { ids, count: ids.length };
    }

    deleteByIds(ids: readonly string[]): { readonly ids: readonly string[]; readonly count: number } {
        this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
                "INSERT INTO proof_vector_calls (operation, ids_json) VALUES ('delete', ?)",
                JSON.stringify(ids)
            );
            for (const id of ids) this.ctx.storage.sql.exec("DELETE FROM proof_vector_records WHERE id = ?", id);
        });
        return { ids: [...ids], count: ids.length };
    }

    getByIds(ids: readonly string[]): readonly CdbVectorizeRecord[] {
        this.ctx.storage.sql.exec(
            "INSERT INTO proof_vector_calls (operation, ids_json) VALUES ('get', ?)",
            JSON.stringify(ids)
        );
        if (ids.length === 0) return [];
        return this.ctx.storage.sql
            .exec<{ payload_json: string }>(
                `SELECT payload_json FROM proof_vector_records
                 WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`,
                ...ids
            )
            .toArray()
            .map(row => JSON.parse(row.payload_json) as CdbVectorizeRecord);
    }

    query(
        values: readonly number[],
        options: {
            readonly topK: number;
            readonly namespace?: string;
            readonly filter?: { readonly cdb_resource?: string };
            readonly returnValues: boolean;
            readonly returnMetadata: string;
        }
    ): { readonly count: number; readonly matches: readonly { readonly id: string; readonly score: number }[] } {
        if (
            values.length !== FILE_RESHARD_PROOF_VECTOR.dimensions ||
            values.some(value => !Number.isFinite(value)) ||
            options.returnValues !== false ||
            options.returnMetadata !== "none" ||
            !Number.isSafeInteger(options.topK) ||
            options.topK < 1 ||
            options.topK > 100
        ) {
            throw new TypeError("local vector proof query contract drifted");
        }
        this.ctx.storage.sql.exec("INSERT INTO proof_vector_calls (operation, ids_json) VALUES ('query', '[]')");
        const magnitude = (items: readonly number[]) => Math.sqrt(items.reduce((sum, item) => sum + item * item, 0));
        const queryMagnitude = magnitude(values);
        const matches = this.ctx.storage.sql
            .exec<{ id: string; payload_json: string }>("SELECT id, payload_json FROM proof_vector_records ORDER BY id")
            .toArray()
            .flatMap(row => {
                const record = JSON.parse(row.payload_json) as CdbVectorizeRecord;
                if (
                    record.namespace !== options.namespace ||
                    record.metadata.cdb_resource !== options.filter?.cdb_resource
                ) {
                    return [];
                }
                const stored = Array.from(record.values as ArrayLike<number>);
                const denominator = queryMagnitude * magnitude(stored);
                const score =
                    denominator === 0
                        ? 0
                        : stored.reduce((sum, item, index) => sum + item * (values[index] ?? 0), 0) / denominator;
                return [{ id: row.id, score }];
            })
            .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
            .slice(0, options.topK);
        return { count: matches.length, matches };
    }

    inspect(): {
        readonly calls: readonly {
            readonly operation: "upsert" | "delete" | "get" | "query";
            readonly count: number;
        }[];
        readonly ids: readonly string[];
    } {
        return {
            calls: this.ctx.storage.sql
                .exec<{ operation: "upsert" | "delete" | "get" | "query"; count: number }>(
                    "SELECT operation, COUNT(*) AS count FROM proof_vector_calls GROUP BY operation ORDER BY operation"
                )
                .toArray(),
            ids: this.ctx.storage.sql
                .exec<{ id: string }>("SELECT id FROM proof_vector_records ORDER BY id")
                .toArray()
                .map(row => row.id),
        };
    }
}

function ensureCdbR2Table(storage: DurableObjectStorage): void {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS _chardb_proof_r2_operations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
      keys_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
}

function recordCdbR2(storage: DurableObjectStorage, operation: "put" | "delete", keys: readonly string[]): void {
    ensureCdbR2Table(storage);
    storage.sql.exec(
        "INSERT INTO _chardb_proof_r2_operations (operation, keys_json, created_at) VALUES (?, ?, ?)",
        operation,
        JSON.stringify(keys),
        Date.now()
    );
}

function instrumentBucket(env: ProofEnv, storage: DurableObjectStorage): R2Bucket {
    const bucket = env.CDB_FILES;
    return new Proxy(bucket, {
        get(target, property) {
            if (property === "put") {
                return async (key: string, ...args: unknown[]) => {
                    recordCdbR2(storage, "put", [key]);
                    return Reflect.apply(target.put, target, [key, ...args]);
                };
            }
            if (property === "delete") {
                return async (input: string | string[]) => {
                    const keys = typeof input === "string" ? [input] : [...input];
                    recordCdbR2(storage, "delete", keys);
                    return Reflect.apply(target.delete, target, [input]);
                };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

export class Cdb extends app.Cdb {
    private readonly proofEnv: ProofEnv;

    constructor(state: DurableObjectState, env: ProofEnv) {
        if (env.CDB_PROOF_TARGET_KIND !== "local") {
            super(state, env);
            this.proofEnv = env;
            return;
        }
        const instrumented = Object.create(env) as ProofEnv;
        Object.defineProperty(instrumented, "CDB_FILES", {
            value: instrumentBucket(env, state.storage),
            enumerable: true,
            configurable: false,
            writable: false,
        });
        super(state, instrumented);
        this.proofEnv = instrumented;
    }

    private localVectorProbe(): DurableObjectStub | null {
        if (this.proofEnv.CDB_PROOF_TARGET_KIND !== "local") return null;
        const namespace = this.proofEnv.CDB_VECTOR_PROBE;
        if (!namespace) throw new Error("local vector proof Durable Object is unavailable");
        return namespace.get(namespace.idFromName(this.proofEnv.CDB_PROOF_VECTORIZE_INDEX));
    }

    protected override resolveVectorIndex(binding: string): CdbVectorizeMutationIndex {
        if (binding !== "CDB_PROOF_VECTORS") return super.resolveVectorIndex(binding);
        const local = this.localVectorProbe();
        return local ? (local as unknown as CdbVectorizeMutationIndex) : super.resolveVectorIndex(binding);
    }

    protected override resolveVectorSearchIndex(binding: string): CdbVectorizeSearchIndex {
        if (binding !== "CDB_PROOF_VECTORS") return super.resolveVectorSearchIndex(binding);
        const local = this.localVectorProbe();
        return local ? (local as unknown as CdbVectorizeSearchIndex) : super.resolveVectorSearchIndex(binding);
    }

    proofR2Counts(): { putCalls: number; deleteCalls: number } {
        ensureCdbR2Table(this.ctx.storage);
        const rows = this.ctx.storage.sql
            .exec<{ operation: "put" | "delete"; count: number }>(
                "SELECT operation, COUNT(*) AS count FROM _chardb_proof_r2_operations GROUP BY operation"
            )
            .toArray();
        return {
            putCalls: rows.find(row => row.operation === "put")?.count ?? 0,
            deleteCalls: rows.find(row => row.operation === "delete")?.count ?? 0,
        };
    }

    proofStaleSourceFence(input: {
        readonly file: FileRecord;
        readonly principalId: string;
        readonly schemaEpoch: number;
        readonly domainSchemaEpoch: number;
    }): boolean {
        try {
            this.markFileReady({
                fileId: input.file.fileId,
                organizationId: input.file.organizationId,
                sha256: input.file.contentSha256,
                size: input.file.bytes,
                nowMs: Date.now(),
                recoveryGeneration: 0,
                schemaEpoch: input.schemaEpoch,
                domainSchemaEpoch: input.domainSchemaEpoch,
                auth: {
                    userId: input.principalId,
                    tenantId: input.file.organizationId,
                    role: "owner",
                    roles: ["owner"],
                    authEpochs: { global: 1, tenant: 1, principal: 1 },
                    claims: {},
                },
            });
            return false;
        } catch (error) {
            return (error instanceof Error ? error.message : String(error)).includes("CDB_STALE_EPOCH");
        }
    }

    async proofSettleLocalVectors(): Promise<void> {
        if (this.proofEnv.CDB_PROOF_TARGET_KIND !== "local") {
            throw new Error("forced vector settlement is local-proof only");
        }
        for (let turn = 0; turn < 4; turn++) {
            this.ctx.storage.sql.exec(
                "UPDATE _chardb_vector_outbox SET next_attempt_at = 0, leased_until = NULL, lease_token = NULL"
            );
            this.ctx.storage.sql.exec(
                "UPDATE _chardb_vector_attempts SET settle_after = first_sent_at WHERE visibility_confirmed = 0"
            );
            await this.ctx.storage.deleteAlarm();
            await super.alarm();
        }
    }

    async proofVectorEvidence(input: { vectorIds: readonly string[] }): Promise<VectorEvidence> {
        if (
            !Array.isArray(input.vectorIds) ||
            input.vectorIds.length < 1 ||
            input.vectorIds.length > PROFILES.large.files ||
            new Set(input.vectorIds).size !== input.vectorIds.length ||
            input.vectorIds.some(vectorId => typeof vectorId !== "string" || vectorId.length === 0)
        ) {
            throw new TypeError("vector proof scope is invalid");
        }
        const vectorIds = new Set(input.vectorIds);
        const heads = this.ctx.storage.sql
            .exec<{ vector_id: string; row_pk: string; version: number; state: string }>(
                "SELECT vector_id, row_pk, version, state FROM _chardb_vectors ORDER BY vector_id"
            )
            .toArray()
            .filter(row => vectorIds.has(row.vector_id));
        const outbox = this.ctx.storage.sql
            .exec<{
                vector_id: string;
                operation: string;
                target_version: number;
                phase: string;
                terminal_failure: number;
            }>(
                `SELECT vector_id, operation, target_version, phase, terminal_failure
                 FROM _chardb_vector_outbox ORDER BY vector_id`
            )
            .toArray()
            .filter(row => vectorIds.has(row.vector_id));
        const attempts = this.ctx.storage.sql
            .exec<{
                vector_id: string;
                physical_version: number;
                visibility_confirmed: number;
                response_ambiguous: number;
                delete_confirmed: number;
            }>(
                `SELECT vector_id, physical_version, visibility_confirmed, response_ambiguous, delete_confirmed
                 FROM _chardb_vector_attempts ORDER BY vector_id, physical_version`
            )
            .toArray()
            .filter(row => vectorIds.has(row.vector_id));
        const physicalIds = heads.map(head => cdbVectorizePhysicalId(head.vector_id, head.version)).sort();
        let providerRecords = 0;
        let providerMutationCalls: { upsert: number; delete: number } | null = null;
        if (this.proofEnv.CDB_PROOF_TARGET_KIND === "local") {
            const probe = this.localVectorProbe() as unknown as {
                inspect(): Promise<{
                    calls: readonly { operation: "upsert" | "delete" | "get" | "query"; count: number }[];
                    ids: readonly string[];
                }>;
            };
            const inspected = await probe.inspect();
            providerRecords = inspected.ids.filter(id => physicalIds.includes(id)).length;
            providerMutationCalls = {
                upsert: inspected.calls.find(item => item.operation === "upsert")?.count ?? 0,
                delete: inspected.calls.find(item => item.operation === "delete")?.count ?? 0,
            };
        } else {
            const providerResult = await this.resolveVectorIndex("CDB_PROOF_VECTORS").getByIds(physicalIds);
            if (!Array.isArray(providerResult)) throw new Error("Vectorize getByIds returned a non-array result");
            providerRecords = providerResult.length;
        }
        return {
            heads: heads.length,
            readyHeads: heads.filter(head => head.state === "ready").length,
            outbox: outbox.length,
            attempts: attempts.length,
            headDigest: await hexDigest(JSON.stringify(heads)),
            outboxDigest: await hexDigest(JSON.stringify(outbox)),
            attemptDigest: await hexDigest(JSON.stringify(attempts)),
            physicalIds,
            physicalIdentityDigest: await hexDigest(JSON.stringify(physicalIds)),
            providerRecords,
            providerMutationCalls,
        };
    }

    async proofFileAlarmState(input: { organizationId: string }): Promise<Record<string, unknown>> {
        const files = this.ctx.storage.sql
            .exec<{ status: string; count: number }>(
                `SELECT status, COUNT(*) AS count FROM _chardb_files
                 WHERE organization_id = ? GROUP BY status ORDER BY status`,
                input.organizationId
            )
            .toArray();
        const metadataRows = Number(
            this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_files").one()?.count ??
                0
        );
        const organizationMetadataRows = files.reduce((total, row) => total + Number(row.count), 0);
        const tombstone = this.ctx.storage.sql
            .exec<{
                organization_id: string;
                deleted_at: number;
                placement_vshard: number;
                vector_unproven_turns: number;
            }>("SELECT * FROM _chardb_deleted_organizations WHERE organization_id = ?", input.organizationId)
            .toArray();
        const ownership = this.ctx.storage.sql
            .exec<{
                mig_id: string;
                role: string;
                outcome: string;
                source_fenced: number;
                maintenance_enabled: number;
                range_lo: number;
                range_hi: number;
                updated_at: number;
            }>(
                `SELECT mig_id, role, outcome, source_fenced, maintenance_enabled, range_lo, range_hi, updated_at
                 FROM _chardb_split_file_cursor
                 ORDER BY updated_at DESC, mig_id`
            )
            .toArray();
        return {
            alarm: await this.ctx.storage.getAlarm(),
            metadataRows,
            organizationMetadataRows,
            files,
            tombstone,
            ownership,
        };
    }
}

interface CdbProofRpc {
    proofR2Counts(): Promise<{ putCalls: number; deleteCalls: number }>;
    proofStaleSourceFence(input: {
        readonly file: FileRecord;
        readonly principalId: string;
        readonly schemaEpoch: number;
        readonly domainSchemaEpoch: number;
    }): Promise<boolean>;
    proofSettleLocalVectors(): Promise<void>;
    proofVectorEvidence(input: { vectorIds: readonly string[] }): Promise<VectorEvidence>;
    proofFileAlarmState(input: { organizationId: string }): Promise<Record<string, unknown>>;
}

function cdb(env: ProofEnv, shardId: string): CdbProofRpc {
    const namespace = env.CDB_SHARD ?? env.Cdb;
    if (!namespace) throw new Error("proof Cdb loopback is unavailable");
    return namespace.get(namespace.idFromName(shardId)) as unknown as CdbProofRpc;
}

async function cdbR2Counts(
    env: ProofEnv,
    shardIds: readonly string[]
): Promise<{ putCalls: number; deleteCalls: number }> {
    const counts = await Promise.all([...new Set(shardIds)].map(shardId => cdb(env, shardId).proofR2Counts()));
    return counts.reduce(
        (total, item) => ({
            putCalls: total.putCalls + item.putCalls,
            deleteCalls: total.deleteCalls + item.deleteCalls,
        }),
        { putCalls: 0, deleteCalls: 0 }
    );
}

async function settledVectorEvidence(
    env: ProofEnv,
    shardId: string,
    vectorIds: readonly string[]
): Promise<VectorEvidence> {
    const owner = cdb(env, shardId);
    if (env.CDB_PROOF_TARGET_KIND === "local") await owner.proofSettleLocalVectors();
    const deadline = Date.now() + 5 * 60_000;
    let evidence = await owner.proofVectorEvidence({ vectorIds });
    while (
        (evidence.readyHeads !== vectorIds.length || evidence.providerRecords !== vectorIds.length) &&
        Date.now() < deadline
    ) {
        await scheduler.wait(250);
        evidence = await owner.proofVectorEvidence({ vectorIds });
    }
    if (evidence.readyHeads !== vectorIds.length || evidence.providerRecords !== vectorIds.length) {
        throw new Error("vector proof did not settle the exact seeded dataset before movement");
    }
    return evidence;
}

function cookies(headers: Headers): string {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")];
    return values
        .filter((value): value is string => value !== null)
        .map(value => value.split(";", 1)[0])
        .join("; ");
}

function mergeCookies(current: string, headers: Headers): string {
    const values = new Map<string, string>();
    for (const source of [current, cookies(headers)]) {
        for (const cookie of source.split(/;\s*/)) {
            const separator = cookie.indexOf("=");
            if (separator > 0) values.set(cookie.slice(0, separator), cookie.slice(separator + 1));
        }
    }
    return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function dispatch(
    origin: string,
    env: ProofEnv,
    ctx: ProofExecutionContext,
    pathname: string,
    init: RequestInit = {}
): Promise<{ response: Response; body: unknown }> {
    const response = await app.fetch(
        new Request(new URL(pathname, origin), init),
        env as never,
        ctx as Parameters<typeof app.fetch>[2]
    );
    const text = await response.text();
    let body: unknown = text;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        // The caller reports the status and never includes this body in evidence.
    }
    return { response, body };
}

function bodyObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} returned no JSON object`);
    return value as Record<string, unknown>;
}

async function admin(
    origin: string,
    env: ProofEnv,
    ctx: ProofExecutionContext,
    pathname: string,
    body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
    const result = await dispatch(origin, env, ctx, pathname, {
        method: body ? "POST" : "GET",
        headers: {
            authorization: `Bearer ${env.CDB_ADMIN_TOKEN}`,
            ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!result.response.ok) throw new Error(`admin ${pathname} failed with ${result.response.status}`);
    return bodyObject(result.body, pathname);
}

async function ensureMigration(origin: string, env: ProofEnv, ctx: ProofExecutionContext): Promise<void> {
    const state = bodyObject((await admin(origin, env, ctx, "/_chardb/migrations/state")).state, "migration state");
    if (state.status === "active" && state.activeVersion === 1) return;
    const migrationId = "file-reshard-proof-schema-v1";
    await admin(origin, env, ctx, "/_chardb/migrations/begin", { migrationId, targetVersion: 1 });
    const inventory = await admin(origin, env, ctx, `/_chardb/migrations/shards?migrationId=${migrationId}`);
    if (!Array.isArray(inventory.shards)) throw new Error("migration shard inventory is invalid");
    for (const shard of inventory.shards) {
        const item = bodyObject(shard, "migration shard");
        if (item.status !== "active") {
            await admin(origin, env, ctx, "/_chardb/migrations/shard", { migrationId, shardId: item.shardId });
        }
    }
    await admin(origin, env, ctx, "/_chardb/migrations/catalog", { migrationId, version: 1 });
    await admin(origin, env, ctx, "/_chardb/migrations/complete", { migrationId });
}

async function principal(origin: string, env: ProofEnv, ctx: ProofExecutionContext): Promise<Principal> {
    const signed = await dispatch(origin, env, ctx, "/api/auth/sign-in/anonymous", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: "{}",
    });
    if (!signed.response.ok) throw new Error(`anonymous sign-in failed with ${signed.response.status}`);
    const current: Principal = { cookie: cookies(signed.response.headers), token: "", userId: "" };
    const session = await dispatch(origin, env, ctx, "/api/auth/get-session", { headers: { cookie: current.cookie } });
    const sessionBody = bodyObject(session.body, "session");
    const user = bodyObject(sessionBody.user, "session user");
    if (typeof user.id !== "string") throw new Error("session user ID is missing");
    current.userId = user.id;
    current.cookie = mergeCookies(current.cookie, session.response.headers);
    const token = await dispatch(origin, env, ctx, "/api/auth/token", { headers: { cookie: current.cookie } });
    const tokenBody = bodyObject(token.body, "token");
    if (!token.response.ok || typeof tokenBody.token !== "string") throw new Error("JWT issue failed");
    current.token = tokenBody.token;
    current.cookie = mergeCookies(current.cookie, token.response.headers);
    return current;
}

async function authPost(
    origin: string,
    env: ProofEnv,
    ctx: ProofExecutionContext,
    principal: Principal,
    pathname: string,
    body: Record<string, unknown>
): Promise<Record<string, unknown>> {
    const result = await dispatch(origin, env, ctx, `/api/auth${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: principal.cookie, origin },
        body: JSON.stringify(body),
    });
    if (!result.response.ok) throw new Error(`Better Auth ${pathname} failed with ${result.response.status}`);
    principal.cookie = mergeCookies(principal.cookie, result.response.headers);
    return bodyObject(result.body, pathname);
}

async function createOrganizations(
    origin: string,
    env: ProofEnv,
    ctx: ProofExecutionContext,
    owner: Principal,
    request: ProofRequest
): Promise<string[]> {
    const suffix = (await hexDigest(request.runKey)).slice(0, 16);
    const ids: string[] = [];
    for (let index = 0; index < request.profile.organizations; index++) {
        const organization = await authPost(origin, env, ctx, owner, "/organization/create", {
            name: `File reshard proof ${index}`,
            slug: `file-reshard-proof-${suffix}-${index}`,
            keepCurrentActiveOrganization: true,
        });
        if (typeof organization.id !== "string") throw new Error("organization ID is missing");
        ids.push(organization.id);
    }
    return ids;
}

async function setActive(
    origin: string,
    env: ProofEnv,
    ctx: ProofExecutionContext,
    owner: Principal,
    organizationId: string
): Promise<void> {
    await authPost(origin, env, ctx, owner, "/organization/set-active", { organizationId });
    const token = await dispatch(origin, env, ctx, "/api/auth/token", { headers: { cookie: owner.cookie } });
    const tokenBody = bodyObject(token.body, "refreshed token");
    if (!token.response.ok || typeof tokenBody.token !== "string") throw new Error("JWT refresh failed");
    owner.token = tokenBody.token;
    owner.cookie = mergeCookies(owner.cookie, token.response.headers);
}

async function seedFiles(
    origin: string,
    env: ProofEnv,
    ctx: ProofExecutionContext,
    owner: Principal,
    organizationIds: readonly string[],
    request: ProofRequest
): Promise<FileRecord[]> {
    const records: FileRecord[] = [];
    for (let index = 0; index < request.profile.files; index++) {
        const organizationId = organizationIds[
            index === 0 ? 0 : 1 + ((index - 1) % (organizationIds.length - 1))
        ] as string;
        await setActive(origin, env, ctx, owner, organizationId);
        const bytes = new TextEncoder().encode(`${request.runKey}:${index}`);
        const query = new URLSearchParams({ organizationId, table: "proof_documents", column: "attachment" });
        const uploaded = await dispatch(origin, env, ctx, `/_chardb/files/upload?${query}`, {
            method: "PUT",
            headers: {
                "content-type": "application/octet-stream",
                "idempotency-key": `${request.runKey}-${index}`,
                cookie: owner.cookie,
                origin,
            },
            body: bytes,
        });
        const uploadBody = bodyObject(uploaded.body, "upload");
        const file = bodyObject(uploadBody.file, "uploaded file");
        if (!uploaded.response.ok || typeof file.fileId !== "string") throw new Error(`upload ${index} failed`);
        const contentSha256 = await hexDigest(bytes);
        await catalog(env).proofAppendCleanupKey({
            runKey: request.runKey,
            key: `_chardb/retained/sha256/${contentSha256}`,
        });
        const rowId = `row-${request.sequence < 0 ? "warmup" : request.sequence}-${index}`;
        const values = proofVectorValues(index);
        const attached = await client(env.DB, { jwt: owner.token, authOrigin: origin }).mutate(
            api.attachDocument,
            {
                id: rowId,
                organizationId,
                ownerId: owner.userId,
                fileId: file.fileId,
                body: `proof document ${index}`,
                values: [...values],
            },
            { mutId: `${request.runKey}-attach-${index}` }
        );
        if (typeof attached.vectorId !== "string") throw new Error(`vector ${index} was not staged`);
        records.push({
            organizationId,
            rowId,
            fileId: file.fileId,
            vectorId: attached.vectorId,
            values,
            bytes: bytes.byteLength,
            contentSha256,
        });
    }
    return records;
}

async function inventory(bucket: R2Bucket, files: readonly FileRecord[]): Promise<R2Inventory> {
    const objects = (await Promise.all(files.map(file => bucket.head(`_chardb/retained/sha256/${file.contentSha256}`))))
        .filter((object): object is R2Object => object !== null)
        .sort((left, right) => left.key.localeCompare(right.key));
    return {
        objects: objects.length,
        bytes: objects.reduce((total, object) => total + object.size, 0),
        digest: await hexDigest(objects.map(object => `${object.key}\0${object.size}\0${object.etag}`).join("\n")),
    };
}

async function verifyDownloads(
    origin: string,
    env: ProofEnv,
    ctx: ProofExecutionContext,
    owner: Principal,
    files: readonly FileRecord[]
): Promise<void> {
    for (const file of files) {
        await setActive(origin, env, ctx, owner, file.organizationId);
        const query = new URLSearchParams({
            organizationId: file.organizationId,
            table: "proof_documents",
            column: "attachment",
            rowId: file.rowId,
        });
        const downloaded = await dispatch(origin, env, ctx, `/_chardb/files/download?${query}`, {
            headers: { cookie: owner.cookie, origin },
        });
        if (!downloaded.response.ok)
            throw new Error(`download ${file.rowId} failed with ${downloaded.response.status}`);
        if (typeof downloaded.body !== "string") throw new Error(`download ${file.rowId} returned a non-file body`);
        const bytes = new TextEncoder().encode(downloaded.body);
        if (bytes.byteLength !== file.bytes || (await hexDigest(bytes)) !== file.contentSha256) {
            throw new Error(`download ${file.rowId} did not preserve exact file bytes`);
        }
    }
}

async function verifyDestinationVectorSearch(
    origin: string,
    env: ProofEnv,
    ctx: ProofExecutionContext,
    owner: Principal,
    record: FileRecord
): Promise<{ readonly rowPk: string; readonly score: number }> {
    await setActive(origin, env, ctx, owner, record.organizationId);
    const matches = await client(env.DB, { jwt: owner.token, authOrigin: origin }).query(api.searchDocuments, {
        organizationId: record.organizationId,
        values: [...record.values],
        limit: 1,
    });
    const first = matches[0];
    if (!first || first.rowPk !== record.rowId || typeof first.score !== "number" || !Number.isFinite(first.score)) {
        throw new Error("post-cutover public vector search did not return the exact destination row");
    }
    return { rowPk: first.rowPk, score: first.score };
}

function stateFrom(value: Record<string, unknown>): ReshardState {
    const state = bodyObject(value.state, "reshard state");
    if (
        typeof state.migrationId !== "string" ||
        typeof state.phase !== "number" ||
        typeof state.phaseName !== "string" ||
        typeof state.terminal !== "boolean" ||
        typeof state.sourceShard !== "string" ||
        typeof state.destinationShard !== "string" ||
        typeof state.rangeLo !== "number" ||
        typeof state.rangeHi !== "number"
    ) {
        throw new Error("reshard state is malformed");
    }
    return state as unknown as ReshardState;
}

async function driveTo(
    origin: string,
    env: ProofEnv,
    ctx: ProofExecutionContext,
    migrationId: string,
    targetPhase: number,
    timings: Record<(typeof PHASES)[number], number>
): Promise<{ state: ReshardState; turns: number }> {
    let state = stateFrom(await admin(origin, env, ctx, `/_chardb/shards/status?migrationId=${migrationId}`));
    let turns = 0;
    while (state.phase < targetPhase) {
        if (turns >= MAX_DRIVE_TURNS) throw new Error("reshard drive exceeded its bounded turn limit");
        const started = performance.now();
        const phase = state.phase;
        state = stateFrom(await admin(origin, env, ctx, "/_chardb/shards/drive", { migrationId }));
        const elapsed = performance.now() - started;
        const timing =
            phase === 0
                ? "init"
                : phase === 1
                  ? "snapshot"
                  : phase === 2
                    ? "converge"
                    : phase === 3
                      ? "barrierValidateCutover"
                      : phase === 4
                        ? "drain"
                        : "finish";
        timings[timing] += elapsed;
        turns++;
    }
    return { state, turns };
}

function target(env: ProofEnv, sourceShard: string, destinationShard: string) {
    return {
        kind: env.CDB_PROOF_TARGET_KIND,
        runtime: env.CDB_PROOF_RUNTIME,
        deploymentVersion: deploymentVersion(env),
        configurationSha256: env.CDB_PROOF_CONFIGURATION_SHA256,
        bindings: [...(env.CDB_PROOF_TARGET_KIND === "local" ? LOCAL_BINDINGS : DEPLOYED_BINDINGS)],
        sourceShard,
        destinationShard,
        r2Bucket: env.CDB_PROOF_R2_BUCKET,
        vectorizeIndex: env.CDB_PROOF_VECTORIZE_INDEX,
    };
}

app.get("/proof/file-reshard/capabilities", async c => {
    const env = c.env as unknown as ProofEnv;
    const runId = c.req.header("x-chardb-proof-run-id") ?? "";
    if (!(await authorized(c.req.raw, env, runId))) return c.json({ error: "not found" }, 404);
    return c.json({
        schema: CAPABILITIES_SCHEMA,
        releaseSha256: env.CDB_RELEASE_SHA256,
        runId,
        target: target(env, "catalog-current-owner", "per-run-fresh-destination"),
        protocol: "bounded-operator-v1",
        features: {
            alarms: true,
            commitThenResponseLoss: true,
            directR2OperationTrace: env.CDB_PROOF_TARGET_KIND === "local",
            fileAwareReshard: true,
            freshDisposableData: true,
            providerVectorMutationTrace: env.CDB_PROOF_TARGET_KIND === "local",
            publicVectorSearch: true,
            retainedFileRecovery: true,
            vectorAwareReshard: true,
        },
    });
});

app.post("/proof/file-reshard/cleanup", async c => {
    const env = c.env as unknown as ProofEnv;
    try {
        const headerRunId = c.req.header("x-chardb-proof-run-id") ?? "";
        if (!(await authorized(c.req.raw, env, headerRunId))) return c.json({ error: "not found" }, 404);
        const value = await c.req.json();
        exact(value, ["runId", "runKey"], "proof cleanup request");
        string(value.runId, "runId", /^[A-Za-z0-9_-]{16,80}$/);
        string(value.runKey, "runKey", /^[A-Za-z0-9_-]{16,128}$/);
        if (value.runId !== headerRunId) return c.json({ error: "not found" }, 404);
        const ledger = catalog(env);
        const batch = await ledger.proofCleanupBatch({ runKey: value.runKey });
        if (batch.done) {
            return c.json({
                schema: CLEANUP_SCHEMA,
                runId: value.runId,
                runKey: value.runKey,
                deleted: 0,
                remaining: batch.remaining,
                done: true,
            });
        }
        let deleted = batch.pendingDeleted;
        if (deleted === null) {
            const present = await Promise.all(batch.keys.map(key => env.CDB_FILES.head(key)));
            deleted = present.filter(object => object !== null).length;
            await ledger.proofPrepareCleanup({
                runKey: value.runKey,
                cursor: batch.cursor,
                nextCursor: batch.nextCursor,
                deleted,
            });
        }
        await env.CDB_FILES.delete([...batch.keys]);
        const committed = await ledger.proofCommitCleanup({
            runKey: value.runKey,
            cursor: batch.cursor,
            nextCursor: batch.nextCursor,
        });
        return c.json({
            schema: CLEANUP_SCHEMA,
            runId: value.runId,
            runKey: value.runKey,
            ...committed,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, error instanceof TypeError ? 400 : 500);
    }
});

app.post("/proof/file-reshard/run", async c => {
    const env = c.env as unknown as ProofEnv;
    let checkpoint = "request-parse";
    try {
        const declared = c.req.header("content-length");
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 16_384)) {
            throw new TypeError("proof body is too large");
        }
        const request = parseRequest(await c.req.json());
        checkpoint = "authorization";
        if (!(await authorized(c.req.raw, env, request.runId)) || request.candidateSha256 !== env.CDB_RELEASE_SHA256) {
            return c.json({ error: "not found" }, 404);
        }
        checkpoint = "receipt-claim";
        const requestSha256 = await hexDigest(JSON.stringify(request));
        const ledger = catalog(env);
        const injection = c.req.header("x-chardb-proof-inject");
        const existing = await ledger.proofReceipt({ runKey: request.runKey, requestSha256 });
        if ((!existing && injection !== request.fault.mode) || (existing && injection !== undefined)) {
            return c.json({ error: "response-loss injection does not match the durable run stage" }, 409);
        }
        const claim = await ledger.proofClaim({ runKey: request.runKey, requestSha256 });
        const receipt = claim.receipt;
        if (receipt.stage === "claimed" && !claim.claimed) {
            return c.json({ error: "response-loss injection does not match the durable run stage" }, 409);
        }
        if (receipt.stage === "completed") return c.json(receipt.payload);
        const origin = new URL(c.req.url).origin;
        const timings = Object.fromEntries(PHASES.map(phase => [phase, 0])) as Record<(typeof PHASES)[number], number>;
        if (receipt.stage === "claimed") {
            const startedAt = new Date().toISOString();
            const setupStarted = performance.now();
            checkpoint = "migration-setup";
            await ensureMigration(origin, env, c.executionCtx);
            const owner = await principal(origin, env, c.executionCtx);
            checkpoint = "organization-seed";
            const organizationIds = await createOrganizations(origin, env, c.executionCtx, owner, request);
            checkpoint = "file-seed";
            const files = await seedFiles(origin, env, c.executionCtx, owner, organizationIds, request);
            checkpoint = "pre-move-inventory";
            const before = await inventory(env.CDB_FILES, files);
            timings.setup = performance.now() - setupStarted;
            const routeBefore = await ledger.route(0);
            const migrationId = `proof-${(await hexDigest(request.runKey)).slice(0, 32)}`;
            const destinationShard = `proof-dst-${(await hexDigest(`${request.runKey}:dest`)).slice(0, 24)}`;
            checkpoint = "vector-settlement";
            const vectorsBefore = await settledVectorEvidence(
                env,
                routeBefore.shardId,
                files.map(file => file.vectorId)
            );
            const operationsBefore = await cdbR2Counts(env, [routeBefore.shardId, destinationShard]);
            checkpoint = "migration-start";
            const started = stateFrom(
                await admin(origin, env, c.executionCtx, "/_chardb/shards/start", {
                    migrationId,
                    destinationShard,
                    rangeLo: 0,
                    rangeHi: 16_383,
                })
            );
            checkpoint = "snapshot-commit";
            const driven = await driveTo(origin, env, c.executionCtx, migrationId, SNAPSHOT_COMMITTED_PHASE, timings);
            const faultPayload = {
                startedAt,
                timings,
                turns: driven.turns,
                migrationId,
                sourceShard: started.sourceShard,
                destinationShard,
                routeEpochBefore: routeBefore.schemaEpoch,
                domainSchemaEpochBefore: routeBefore.domainSchemaEpoch,
                owner,
                organizationIds,
                files,
                before,
                vectorsBefore,
                operationsBefore,
            };
            checkpoint = "fault-receipt";
            await ledger.proofAdvance({
                runKey: request.runKey,
                requestSha256,
                from: "claimed",
                to: "faulted",
                payload: faultPayload,
            });
            return c.json(
                {
                    schema: FAULT_SCHEMA,
                    runKey: request.runKey,
                    operation: "apply_snapshot",
                    committed: true,
                    retryable: true,
                },
                503
            );
        }
        checkpoint = "retry-receipt";
        const payload = receipt.payload;
        const owner = bodyObject(payload.owner, "receipt owner") as unknown as Principal;
        const organizationIds = payload.organizationIds as string[];
        const files = payload.files as FileRecord[];
        const before = payload.before as unknown as R2Inventory;
        const vectorsBefore = payload.vectorsBefore as unknown as VectorEvidence;
        const operationsBefore = payload.operationsBefore as { putCalls: number; deleteCalls: number };
        const migrationId = String(payload.migrationId);
        const sourceShard = String(payload.sourceShard);
        const destinationShard = String(payload.destinationShard);
        const routeEpochBefore = Number(payload.routeEpochBefore);
        const domainSchemaEpochBefore = Number(payload.domainSchemaEpochBefore);
        Object.assign(timings, payload.timings);
        checkpoint = "migration-finish";
        const driven = await driveTo(origin, env, c.executionCtx, migrationId, TERMINAL_PHASE, timings);
        const routeAfter = await ledger.route(0);
        const verifyStarted = performance.now();
        checkpoint = "post-move-inventory";
        const after = await inventory(env.CDB_FILES, files);
        checkpoint = "download-verify";
        await verifyDownloads(origin, env, c.executionCtx, owner, files);
        const vectorIds = files.map(file => file.vectorId);
        checkpoint = "vector-verify";
        const vectorsAfter = await cdb(env, destinationShard).proofVectorEvidence({ vectorIds });
        const sourceVectorsAfter = await cdb(env, sourceShard).proofVectorEvidence({ vectorIds });
        checkpoint = "source-fence";
        const sourceFenced = await cdb(env, sourceShard).proofStaleSourceFence({
            file: files[0] as FileRecord,
            principalId: owner.userId,
            schemaEpoch: routeEpochBefore,
            domainSchemaEpoch: domainSchemaEpochBefore,
        });
        checkpoint = "vector-search";
        const search = await verifyDestinationVectorSearch(origin, env, c.executionCtx, owner, files[0] as FileRecord);
        const operationsAfter = await cdbR2Counts(env, [sourceShard, destinationShard]);
        checkpoint = "organization-delete";
        await setActive(origin, env, c.executionCtx, owner, organizationIds[0] as string);
        await authPost(origin, env, c.executionCtx, owner, "/organization/delete", {
            organizationId: organizationIds[0],
        });
        checkpoint = "file-alarm";
        const alarmDeadline = Date.now() + 30_000;
        const deletedOrganizationId = organizationIds[0] as string;
        let alarmState = await cdb(env, destinationShard).proofFileAlarmState({
            organizationId: deletedOrganizationId,
        });
        while (alarmState.organizationMetadataRows !== 0 && Date.now() < alarmDeadline) {
            await scheduler.wait(25);
            alarmState = await cdb(env, destinationShard).proofFileAlarmState({
                organizationId: deletedOrganizationId,
            });
        }
        const alarmInventory = await inventory(env.CDB_FILES, files);
        if (alarmState.organizationMetadataRows !== 0) {
            const catalogDeletion = await ledger.organizationDeletionPurgeStatus({
                organizationId: deletedOrganizationId,
            });
            throw new Error(
                `durable file alarm did not converge: ${JSON.stringify({ catalogDeletion, destinationAlarm: alarmState })}`
            );
        }
        timings.verify = performance.now() - verifyStarted;
        const localTrace = env.CDB_PROOF_TARGET_KIND === "local";
        const totalMs = Object.values(timings).reduce((sum, value) => sum + value, 0);
        const sample = {
            schema: SAMPLE_SCHEMA,
            sequence: request.sequence,
            excluded: request.excluded,
            candidateSha256: request.candidateSha256,
            runKey: request.runKey,
            workload: { id: "file-vector-aware-range-move", version: 3, profile: request.profile },
            target: target(env, sourceShard, destinationShard),
            execution: { startedAt: payload.startedAt, completedAt: new Date().toISOString(), requestAttempts: 2 },
            dataset: {
                organizations: organizationIds.length,
                files: files.length,
                metadataRows: files.length,
                vectors: files.length,
                objectBytes: before.bytes,
            },
            timing: { totalMs: Math.max(totalMs, Number.EPSILON), phasesMs: timings },
            movement: {
                runTurns: Number(payload.turns) + driven.turns,
                routeEpochBefore,
                routeEpochAfter: routeAfter.schemaEpoch,
                r2: {
                    objectsBefore: before.objects,
                    objectsAfter: after.objects,
                    bytesBefore: before.bytes,
                    bytesAfter: after.bytes,
                    identityDigestBefore: before.digest,
                    identityDigestAfter: after.digest,
                    operationTrace: {
                        available: localTrace,
                        method: localTrace ? "cdb-r2-proxy" : "unavailable-native-binding",
                        putsDuringMove: localTrace ? operationsAfter.putCalls - operationsBefore.putCalls : null,
                        deletesDuringMove: localTrace
                            ? operationsAfter.deleteCalls - operationsBefore.deleteCalls
                            : null,
                    },
                },
                vectors: {
                    headsBefore: vectorsBefore.heads,
                    headsAfter: vectorsAfter.heads,
                    readyHeadsBefore: vectorsBefore.readyHeads,
                    readyHeadsAfter: vectorsAfter.readyHeads,
                    outboxBefore: vectorsBefore.outbox,
                    outboxAfter: vectorsAfter.outbox,
                    attemptsBefore: vectorsBefore.attempts,
                    attemptsAfter: vectorsAfter.attempts,
                    headDigestBefore: vectorsBefore.headDigest,
                    headDigestAfter: vectorsAfter.headDigest,
                    outboxDigestBefore: vectorsBefore.outboxDigest,
                    outboxDigestAfter: vectorsAfter.outboxDigest,
                    attemptDigestBefore: vectorsBefore.attemptDigest,
                    attemptDigestAfter: vectorsAfter.attemptDigest,
                    physicalIdsBefore: vectorsBefore.physicalIds,
                    physicalIdsAfter: vectorsAfter.physicalIds,
                    physicalIdentityDigestBefore: vectorsBefore.physicalIdentityDigest,
                    physicalIdentityDigestAfter: vectorsAfter.physicalIdentityDigest,
                    providerRecordsBefore: vectorsBefore.providerRecords,
                    providerRecordsAfter: vectorsAfter.providerRecords,
                    providerMutationTrace: {
                        available: localTrace,
                        method: localTrace ? "durable-object-vector-probe" : "stable-physical-identity",
                        upsertsDuringMove: localTrace
                            ? (vectorsAfter.providerMutationCalls?.upsert ?? 0) -
                              (vectorsBefore.providerMutationCalls?.upsert ?? 0)
                            : null,
                        deletesDuringMove: localTrace
                            ? (vectorsAfter.providerMutationCalls?.delete ?? 0) -
                              (vectorsBefore.providerMutationCalls?.delete ?? 0)
                            : null,
                    },
                    search,
                },
            },
            responseLoss: {
                operation: "apply_snapshot",
                firstStatus: 503,
                committed: true,
                sameRunKey: true,
                retrySucceeded: true,
            },
            alarm: {
                invoked: true,
                durable: true,
                ownerShard: routeAfter.shardId,
                deletedMetadataRows: request.profile.files - Number(alarmState.metadataRows),
                remainingMetadataRows: Number(alarmState.metadataRows),
                retainedObjects: alarmInventory.objects,
            },
            correctness: {
                alarmConverged: true,
                catalogCutover: routeAfter.schemaEpoch === routeEpochBefore + 1,
                destinationServing: routeAfter.shardId === destinationShard,
                fileParity: before.digest === after.digest,
                r2Stable: before.digest === after.digest,
                retainedContentStable: alarmInventory.digest === after.digest,
                responseLossRecovered: true,
                sourceDrained: driven.state.phase === TERMINAL_PHASE,
                sourceFenced,
                vectorAttemptContinuity: vectorsBefore.attemptDigest === vectorsAfter.attemptDigest,
                vectorHeadParity: vectorsBefore.headDigest === vectorsAfter.headDigest,
                vectorOutboxContinuity: vectorsBefore.outboxDigest === vectorsAfter.outboxDigest,
                vectorPhysicalIdentityStable:
                    vectorsBefore.physicalIdentityDigest === vectorsAfter.physicalIdentityDigest,
                vectorProviderNoMovementMutation: localTrace
                    ? (vectorsAfter.providerMutationCalls?.upsert ?? 0) ===
                          (vectorsBefore.providerMutationCalls?.upsert ?? 0) &&
                      (vectorsAfter.providerMutationCalls?.delete ?? 0) ===
                          (vectorsBefore.providerMutationCalls?.delete ?? 0)
                    : vectorsBefore.providerRecords === vectorsAfter.providerRecords &&
                      vectorsBefore.physicalIdentityDigest === vectorsAfter.physicalIdentityDigest,
                destinationPublicSearch: search.rowPk === files[0]?.rowId,
                sourceVectorDrained:
                    sourceVectorsAfter.heads === 0 &&
                    sourceVectorsAfter.outbox === 0 &&
                    sourceVectorsAfter.attempts === 0,
            },
        };
        checkpoint = "receipt-complete";
        await ledger.proofAdvance({
            runKey: request.runKey,
            requestSha256,
            from: "faulted",
            to: "completed",
            payload: sample,
        });
        return c.json(sample);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json(
            {
                code: error instanceof TypeError ? "PROOF_REQUEST_INVALID" : "PROOF_RUN_FAILED",
                checkpoint,
                message,
            },
            error instanceof TypeError ? 400 : 500
        );
    }
});

export default app;
export const { DB, Gateway, Resharder } = app;
