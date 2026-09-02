import { DurableObject } from "cloudflare:workers";
import { organization } from "better-auth/plugins/organization";
import { eq } from "drizzle-orm";
import { text } from "drizzle-orm/sqlite-core";
import { defineAuth } from "../../src/auth/synthesize.ts";
import { isCdbError } from "../../src/errors.ts";
import { createApi } from "../../src/server/define.ts";
import { packagedReshardTableSpecs } from "../../src/server/do/cdb-reshard-identity-store.ts";
import { deleteCdbVector, stageCdbVector } from "../../src/server/do/cdb-vector-mutation.ts";
import {
    CDB_VECTOR_DELETE_VERIFICATION_MAX_POLLS,
    CdbVectorOutboxStore,
} from "../../src/server/do/cdb-vector-outbox-store.ts";
import { resolveCdbVectorSearchMatches } from "../../src/server/do/cdb-vector-search.ts";
import {
    type CdbVectorizeMutationIndex,
    type CdbVectorizeQueryOptions,
    type CdbVectorizeRecord,
    queryCdbVectorizeCandidates,
} from "../../src/server/do/cdb-vectorize-adapter.ts";
import { cdbVectorizePhysicalIdFromCanonical } from "../../src/server/do/cdb-vectorize-wire.ts";
import { type CdbEnv, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { Resharder as ProductionResharder } from "../../src/server/do/resharder.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";
import {
    collectSchemaResourceDescriptors,
    isChardbVectorResourceDescriptor,
} from "../../src/server/resource-descriptors.ts";
import { dispatchOrganizationVectorSearch } from "../../src/server/vector-search-dispatch.ts";
import { PrincipalId, type RawJson, TenantId } from "../../src/types.ts";
import { stableHashHex } from "../../src/util/canonical.ts";
import { vector } from "../../src/vector.ts";
import { forOrg } from "../helpers/cdb-table.ts";

const auth = defineAuth({ appName: "vector-delivery-workerd-proof", plugins: [organization()] });
const { cdbTable } = forOrg();
const messages = cdbTable(
    "vector_proof_messages",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        body: text("body").notNull(),
        embedding: vector("embedding", { dim: 3, binding: "CDB_PROOF_VECTORS", metric: "cosine" }),
    },
    { roles: { member: { create: "*", update: "*", delete: true, read: "*" } } }
);
const benchmarkMessages = cdbTable(
    "vector_benchmark_messages",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        body: text("body").notNull(),
        embedding: vector("embedding", { dim: 32, binding: "CDB_PROOF_VECTORS", metric: "cosine" }),
    },
    { roles: { member: { create: "*", update: "*", delete: true, read: "*" } } }
);
const schema = { messages, benchmarkMessages };
const api = createApi(schema);
const benchmarkVectorResource = (() => {
    const resource = collectSchemaResourceDescriptors(schema).find(
        candidate => isChardbVectorResourceDescriptor(candidate) && candidate.table === "vector_benchmark_messages"
    );
    if (!resource || !isChardbVectorResourceDescriptor(resource)) {
        throw new Error("vector benchmark resource is unavailable");
    }
    return resource;
})();

const putVector = api.mutation(
    (ctx, args: { organizationId: string; id: string; body: string; values: number[] }) => {
        const embedding = stageCdbVector(ctx, {
            column: messages.embedding,
            rowPk: args.id,
            values: args.values,
            metadata: { body: args.body },
        });
        ctx.db.insert(messages).values({ id: args.id, body: args.body, embedding }).run();
        return { id: args.id, vectorId: embedding.id };
    },
    {
        authority: "organization",
        ref: "test/workerd/vector-delivery#put",
        partitionKey: args => args.organizationId,
    }
);

const putBenchmarkVector = api.mutation(
    (ctx, args: { organizationId: string; id: string; body: string; values: number[] }) => {
        const embedding = stageCdbVector(ctx, {
            column: benchmarkMessages.embedding,
            rowPk: args.id,
            values: args.values,
            metadata: { body: args.body },
        });
        ctx.db.insert(benchmarkMessages).values({ id: args.id, body: args.body, embedding }).run();
        return { id: args.id, vectorId: embedding.id };
    },
    {
        authority: "organization",
        ref: "test/workerd/vector-delivery#benchmark-put",
        partitionKey: args => args.organizationId,
    }
);

const replaceVector = api.mutation(
    (ctx, args: { organizationId: string; id: string; body: string; values: number[] }) => {
        const embedding = stageCdbVector(ctx, {
            column: messages.embedding,
            rowPk: args.id,
            values: args.values,
            metadata: { body: args.body },
        });
        ctx.db.update(messages).set({ body: args.body, embedding }).where(eq(messages.id, args.id)).run();
        return { id: args.id, vectorId: embedding.id };
    },
    {
        authority: "organization",
        ref: "test/workerd/vector-delivery#replace",
        partitionKey: args => args.organizationId,
    }
);

const deleteVector = api.mutation(
    (ctx, args: { organizationId: string; id: string }) => {
        deleteCdbVector(ctx, { column: messages.embedding, rowPk: args.id });
        ctx.db.delete(messages).where(eq(messages.id, args.id)).run();
        return args.id;
    },
    {
        authority: "organization",
        ref: "test/workerd/vector-delivery#delete",
        partitionKey: args => args.organizationId,
    }
);

const moveVectorIdentity = api.mutation(
    (ctx, args: { organizationId: string; id: string; nextId: string }) => {
        ctx.db.update(messages).set({ id: args.nextId }).where(eq(messages.id, args.id)).run();
        return args.nextId;
    },
    {
        authority: "organization",
        ref: "test/workerd/vector-delivery#move",
        partitionKey: args => args.organizationId,
    }
);

const manifest = manifestFromExports({
    putVector,
    putBenchmarkVector,
    replaceVector,
    deleteVector,
    moveVectorIdentity,
});

interface VectorProofEnv extends CdbEnv {
    readonly VECTOR_INDEX: DurableObjectNamespace;
}

export class Resharder extends ProductionResharder {}

type FaultMode = "none" | "reject_before" | "accept_then_throw" | "delete_accept_then_throw";
const PROOF_CLOCK_OFFSET_MS = 60 * 60 * 1_000;
let runtimeBootIdentity: string | undefined;

function currentRuntimeBootId(): string {
    runtimeBootIdentity ??= crypto.randomUUID();
    return runtimeBootIdentity;
}

export class VectorIndexProbe extends DurableObject<Record<string, never>> {
    constructor(state: DurableObjectState, env: Record<string, never>) {
        super(state, env);
        state.blockConcurrencyWhile(async () => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                `CREATE TABLE IF NOT EXISTS vector_documents (
                   id TEXT PRIMARY KEY,
                   namespace TEXT NOT NULL,
                   values_json TEXT NOT NULL,
                   metadata_json TEXT NOT NULL
                 )`
            );
            sql.exec(
                `CREATE TABLE IF NOT EXISTS vector_calls (
                   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                   operation TEXT NOT NULL,
                   ids_json TEXT NOT NULL,
                   payload_hash TEXT NOT NULL
                )`
            );
            sql.exec(
                `CREATE TABLE IF NOT EXISTS vector_pending (
                   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                   mutation_id TEXT NOT NULL UNIQUE,
                   operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
                   payload_json TEXT NOT NULL
                 )`
            );
            sql.exec(
                `CREATE TABLE IF NOT EXISTS vector_progress (
                   singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                   processed_up_to_mutation TEXT
                 )`
            );
            sql.exec("INSERT OR IGNORE INTO vector_progress (singleton, processed_up_to_mutation) VALUES (1, NULL)");
            sql.exec(
                `CREATE TABLE IF NOT EXISTS vector_fault (
                   singleton INTEGER PRIMARY KEY,
                   mode TEXT NOT NULL,
                   target_id TEXT
                 )`
            );
            sql.exec("INSERT OR IGNORE INTO vector_fault (singleton, mode, target_id) VALUES (1, 'none', NULL)");
        });
    }

    setFault(mode: FaultMode, targetId?: string): void {
        if (
            mode !== "none" &&
            mode !== "reject_before" &&
            mode !== "accept_then_throw" &&
            mode !== "delete_accept_then_throw"
        ) {
            throw new TypeError("invalid vector proof fault");
        }
        if (mode === "delete_accept_then_throw" && !targetId) {
            throw new TypeError("delete response-loss fault requires an exact physical id");
        }
        adaptSqlStorage(this.ctx.storage.sql).exec(
            "UPDATE vector_fault SET mode = ?, target_id = ? WHERE singleton = 1",
            mode,
            targetId ?? null
        );
    }

    upsert(records: readonly CdbVectorizeRecord[]): { readonly mutationId: string } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const mode = sql.one<{ mode: FaultMode }>("SELECT mode FROM vector_fault WHERE singleton = 1")?.mode ?? "none";
        if (mode === "reject_before") {
            sql.exec("UPDATE vector_fault SET mode = 'none' WHERE singleton = 1");
            throw new Error("vector proof rejected before acceptance");
        }
        const ids = records.map(record => record.id);
        const payloadHash = stableHashHex(records);
        let mutationId = "";
        this.ctx.storage.transactionSync(() => {
            const tx = adaptSqlStorage(this.ctx.storage.sql);
            tx.exec(
                "INSERT INTO vector_calls (operation, ids_json, payload_hash) VALUES ('upsert', ?, ?)",
                JSON.stringify(ids),
                payloadHash
            );
            const sequence = tx.one<{ sequence: number }>("SELECT last_insert_rowid() AS sequence")?.sequence;
            if (!Number.isSafeInteger(sequence)) throw new Error("vector proof mutation sequence is unavailable");
            mutationId = `upsert-${sequence}`;
            tx.exec(
                "INSERT INTO vector_pending (mutation_id, operation, payload_json) VALUES (?, 'upsert', ?)",
                mutationId,
                JSON.stringify(records)
            );
            if (mode === "accept_then_throw") tx.exec("UPDATE vector_fault SET mode = 'none' WHERE singleton = 1");
        });
        if (mode === "accept_then_throw") throw new Error("vector proof lost accepted response");
        return { mutationId };
    }

    deleteByIds(ids: readonly string[]): { readonly mutationId: string } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const fault = sql.one<{ mode: FaultMode; target_id: string | null }>(
            "SELECT mode, target_id FROM vector_fault WHERE singleton = 1"
        ) ?? { mode: "none", target_id: null };
        const loseResponse =
            fault.mode === "delete_accept_then_throw" && fault.target_id !== null && ids.includes(fault.target_id);
        const payloadHash = stableHashHex(ids);
        let mutationId = "";
        this.ctx.storage.transactionSync(() => {
            const tx = adaptSqlStorage(this.ctx.storage.sql);
            tx.exec(
                "INSERT INTO vector_calls (operation, ids_json, payload_hash) VALUES ('delete', ?, ?)",
                JSON.stringify(ids),
                payloadHash
            );
            const sequence = tx.one<{ sequence: number }>("SELECT last_insert_rowid() AS sequence")?.sequence;
            if (!Number.isSafeInteger(sequence)) throw new Error("vector proof mutation sequence is unavailable");
            mutationId = `delete-${sequence}`;
            tx.exec(
                "INSERT INTO vector_pending (mutation_id, operation, payload_json) VALUES (?, 'delete', ?)",
                mutationId,
                JSON.stringify(ids)
            );
            if (loseResponse) {
                tx.exec("UPDATE vector_fault SET mode = 'none', target_id = NULL WHERE singleton = 1");
            }
        });
        if (loseResponse) throw new Error("vector proof lost accepted delete response");
        return { mutationId };
    }

    getByIds(ids: readonly string[]) {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return ids.flatMap(id => {
            const row = sql.one<{
                id: string;
                namespace: string;
                values_json: string;
                metadata_json: string;
            }>("SELECT id, namespace, values_json, metadata_json FROM vector_documents WHERE id = ?", id);
            return row
                ? [
                      {
                          id: row.id,
                          namespace: row.namespace,
                          values: JSON.parse(row.values_json),
                          metadata: JSON.parse(row.metadata_json),
                      },
                  ]
                : [];
        });
    }

    describe(): { readonly processedUpToMutation: string } {
        const mutationId = adaptSqlStorage(this.ctx.storage.sql).one<{ processed_up_to_mutation: string | null }>(
            "SELECT processed_up_to_mutation FROM vector_progress WHERE singleton = 1"
        )?.processed_up_to_mutation;
        if (!mutationId) throw new Error("vector proof has not processed a mutation");
        return { processedUpToMutation: mutationId };
    }

    query(values: readonly number[], options: CdbVectorizeQueryOptions) {
        if (
            values.length !== 32 ||
            values.some(value => !Number.isFinite(value)) ||
            options.returnValues !== false ||
            options.returnMetadata !== "none" ||
            !Number.isSafeInteger(options.topK) ||
            options.topK < 1 ||
            options.topK > 100
        ) {
            throw new TypeError("invalid vector benchmark query contract");
        }
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const magnitude = (items: readonly number[]) => Math.sqrt(items.reduce((sum, item) => sum + item * item, 0));
        const queryMagnitude = magnitude(values);
        const matches = sql
            .all<{ id: string; values_json: string }>(
                `SELECT id, values_json FROM vector_documents
                 WHERE namespace = ? AND json_extract(metadata_json, '$.cdb_resource') = ?
                 ORDER BY id`,
                options.namespace,
                options.filter.cdb_resource
            )
            .map(row => {
                const stored = JSON.parse(row.values_json) as number[];
                const denominator = queryMagnitude * magnitude(stored);
                const score =
                    denominator === 0
                        ? 0
                        : stored.reduce((sum, item, index) => sum + item * (values[index] ?? 0), 0) / denominator;
                return { id: row.id, score };
            })
            .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
            .slice(0, options.topK);
        return { count: matches.length, matches };
    }

    processPending(limit = 1): { readonly processed: number } {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw new TypeError("invalid pending mutation limit");
        let processed = 0;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            const rows = sql.all<{
                sequence: number;
                mutation_id: string;
                operation: "upsert" | "delete";
                payload_json: string;
            }>(
                "SELECT sequence, mutation_id, operation, payload_json FROM vector_pending ORDER BY sequence LIMIT ?",
                limit
            );
            for (const row of rows) {
                const payload: unknown = JSON.parse(row.payload_json);
                if (row.operation === "upsert") {
                    if (!Array.isArray(payload)) throw new Error("queued upsert payload is invalid");
                    for (const value of payload) {
                        const record = value as CdbVectorizeRecord;
                        sql.exec(
                            `INSERT INTO vector_documents (id, namespace, values_json, metadata_json)
                             VALUES (?, ?, ?, ?)
                             ON CONFLICT(id) DO UPDATE SET namespace = excluded.namespace,
                               values_json = excluded.values_json, metadata_json = excluded.metadata_json`,
                            record.id,
                            record.namespace,
                            JSON.stringify(record.values),
                            JSON.stringify(record.metadata)
                        );
                    }
                } else {
                    if (!Array.isArray(payload) || !payload.every(id => typeof id === "string")) {
                        throw new Error("queued delete payload is invalid");
                    }
                    for (const id of payload) sql.exec("DELETE FROM vector_documents WHERE id = ?", id);
                }
                sql.exec(
                    "UPDATE vector_progress SET processed_up_to_mutation = ? WHERE singleton = 1",
                    row.mutation_id
                );
                sql.exec("DELETE FROM vector_pending WHERE sequence = ?", row.sequence);
                processed++;
            }
        });
        return { processed };
    }

    inspect() {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            processedUpToMutation:
                sql.one<{ processed_up_to_mutation: string | null }>(
                    "SELECT processed_up_to_mutation FROM vector_progress WHERE singleton = 1"
                )?.processed_up_to_mutation ?? null,
            documents: sql.all<{ id: string; namespace: string }>(
                "SELECT id, namespace FROM vector_documents ORDER BY id"
            ),
            calls: sql.all<{ sequence: number; operation: string; ids_json: string; payload_hash: string }>(
                "SELECT sequence, operation, ids_json, payload_hash FROM vector_calls ORDER BY sequence"
            ),
            pending: sql.all<{ sequence: number; operation: string }>(
                "SELECT sequence, operation FROM vector_pending ORDER BY sequence"
            ),
        };
    }
}

const ConfiguredCdb = configureCdbRuntime({ schema: () => schema, manifest: () => manifest });

export class VectorProofCdb extends ConfiguredCdb {
    private readonly proofEnv: VectorProofEnv;

    constructor(state: DurableObjectState, env: VectorProofEnv) {
        super(state, env);
        this.proofEnv = env;
    }

    protected override resolveVectorIndex(binding: string): CdbVectorizeMutationIndex {
        if (binding !== "CDB_PROOF_VECTORS") throw new Error("unexpected vector proof binding");
        const stub = this.proofEnv.VECTOR_INDEX.get(
            this.proofEnv.VECTOR_INDEX.idFromName("vector-proof-index")
        ) as unknown as CdbVectorizeMutationIndex & { describe(): Promise<unknown> | unknown };
        return {
            upsert: records => stub.upsert(records),
            deleteByIds: ids => stub.deleteByIds(ids),
            getByIds: ids => stub.getByIds(ids),
            describe: () => stub.describe(),
        };
    }

    protected override invalidationNowMs(): number {
        // Keep platform-scheduled alarms outside the proof window. The harness
        // invokes exact alarm turns explicitly, so fault timing cannot race an
        // automatic now+1ms delivery while still exercising native alarm code.
        return Date.now() + PROOF_CLOCK_OFFSET_MS;
    }

    proofState() {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            rows: sql.all<{ id: string; organization_id: string; body: string; embedding: string | null }>(
                "SELECT id, organization_id, body, embedding FROM vector_proof_messages ORDER BY id"
            ),
            heads: sql.all<{
                vector_id: string;
                row_pk: string;
                version: number;
                delivered_version: number;
                state: string;
            }>(
                `SELECT vector_id, row_pk, version, delivered_version, state
                 FROM _chardb_vectors ORDER BY vector_id`
            ),
            outbox: sql.all<{
                vector_id: string;
                target_version: number;
                operation: string;
                phase: string;
                mutation_id: string | null;
                accepted_at: number | null;
                attempts: number;
                next_attempt_at: number;
                leased_until: number | null;
                terminal_failure: number;
                last_error: string | null;
            }>(
                `SELECT vector_id, target_version, operation, phase, mutation_id, accepted_at, attempts,
                        next_attempt_at, leased_until, terminal_failure, last_error
                 FROM _chardb_vector_outbox ORDER BY vector_id`
            ),
            attempts: sql.all<{ vector_id: string; physical_version: number; settle_after: number }>(
                `SELECT vector_id, physical_version, settle_after
                 FROM _chardb_vector_attempts ORDER BY vector_id, physical_version`
            ),
            opLogRows: sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_op_log")?.count ?? 0,
        };
    }

    proofForceDueAndSettled(): void {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `UPDATE _chardb_vector_outbox
             SET next_attempt_at = 0, leased_until = NULL, lease_token = NULL,
                 accepted_at = CASE WHEN accepted_at IS NULL THEN NULL ELSE 0 END`
        );
        sql.exec("UPDATE _chardb_vector_attempts SET settle_after = first_sent_at");
    }

    proofForceAcceptedDeletePollBound(): void {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec(
            `UPDATE _chardb_vector_outbox
             SET attempts = ?, next_attempt_at = 0, leased_until = NULL, lease_token = NULL
             WHERE operation = 'delete' AND phase = 'verify' AND accepted_at IS NOT NULL`,
            CDB_VECTOR_DELETE_VERIFICATION_MAX_POLLS
        );
        if (sql.changes() !== 1) throw new Error("proof expected one accepted delete at the verification poll bound");
        sql.exec("UPDATE _chardb_vector_attempts SET settle_after = first_sent_at");
    }

    proofClaimOnly(): { readonly operation: "upsert" | "delete"; readonly physicalId: string | null } | null {
        return this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec("UPDATE _chardb_vector_outbox SET next_attempt_at = 0, leased_until = NULL, lease_token = NULL");
            const claim = new CdbVectorOutboxStore(sql).claimNext({
                nowMs: this.invalidationNowMs(),
                leaseMs: 60_000,
                settlementMs: 60_000,
                claimToken: `proof_${crypto.randomUUID()}`,
            });
            if (!claim) return null;
            return {
                operation: claim.operation,
                physicalId:
                    claim.operation === "upsert"
                        ? cdbVectorizePhysicalIdFromCanonical(claim.physicalId).wireId
                        : claim.physicalIds[0]
                          ? cdbVectorizePhysicalIdFromCanonical(claim.physicalIds[0]).wireId
                          : null,
            };
        });
    }

    proofExpireLease(): void {
        adaptSqlStorage(this.ctx.storage.sql).exec("UPDATE _chardb_vector_outbox SET leased_until = 0");
    }

    async proofAlarm(): Promise<void> {
        // Direct RPC invocation is not a platform alarm turn. Consume the
        // visible slot first so deterministic fixture turns model Cloudflare's
        // getAlarm() === null entry contract.
        await this.ctx.storage.deleteAlarm();
        await this.alarm();
    }

    proofScheduledAlarm(): Promise<number | null> {
        return this.ctx.storage.getAlarm();
    }

    proofOrganizationGuard(nextOrganizationId: string): { readonly error: string | null } {
        try {
            adaptSqlStorage(this.ctx.storage.sql).exec(
                "UPDATE vector_proof_messages SET organization_id = ? WHERE embedding IS NOT NULL",
                nextOrganizationId
            );
            return { error: null };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }

    proofReshardRejection(): { readonly error: string | null; readonly splitRows: number } {
        let error: string | null = null;
        try {
            packagedReshardTableSpecs(schema);
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        const splitRows =
            adaptSqlStorage(this.ctx.storage.sql).one<{ count: number }>(
                "SELECT COUNT(*) AS count FROM _chardb_split_state"
            )?.count ?? 0;
        return { error, splitRows };
    }

    async proofVectorSearch(organizationId: string, values: readonly number[], limit: number) {
        const index = this.proofEnv.VECTOR_INDEX.get(
            this.proofEnv.VECTOR_INDEX.idFromName("vector-proof-index")
        ) as unknown as CdbVectorizeMutationIndex & {
            query(values: readonly number[], options: CdbVectorizeQueryOptions): Promise<unknown>;
        };
        const matches = await queryCdbVectorizeCandidates({
            index,
            resource: benchmarkVectorResource,
            organizationId,
            values,
            limit,
        });
        const validated = await resolveCdbVectorSearchMatches({
            storage: this.ctx.storage,
            schema,
            auth: {
                userId: PrincipalId("vector-proof-user"),
                tenantId: TenantId(organizationId),
                role: "member",
                roles: ["member"],
                claims: {},
            },
            organizationId,
            resource: benchmarkVectorResource,
            matches,
            limit,
        });
        return validated.map(match => ({ rowPk: match.rowPk, score: match.score }));
    }
}

export class PlatformAlarmVectorProofCdb extends VectorProofCdb {
    protected override invalidationNowMs(): number {
        return Date.now();
    }

    override async alarm(): Promise<void> {
        const entryAlarm = await this.ctx.storage.getAlarm();
        await super.alarm();
        const exitAlarm = await this.ctx.storage.getAlarm();
        const nextAttemptAt = adaptSqlStorage(this.ctx.storage.sql).one<{ next_attempt_at: number | null }>(
            "SELECT MIN(next_attempt_at) AS next_attempt_at FROM _chardb_vector_outbox WHERE terminal_failure = 0"
        )?.next_attempt_at;
        this.ctx.storage.sql.exec(
            `CREATE TABLE IF NOT EXISTS _chardb_alarm_probe (
               turn INTEGER PRIMARY KEY AUTOINCREMENT,
               entry_alarm INTEGER,
               exit_alarm INTEGER,
               next_attempt_at INTEGER
             )`
        );
        this.ctx.storage.sql.exec(
            "INSERT INTO _chardb_alarm_probe (entry_alarm, exit_alarm, next_attempt_at) VALUES (?, ?, ?)",
            entryAlarm,
            exitAlarm,
            nextAttemptAt ?? null
        );
    }

    proofAlarmTurns(): readonly {
        readonly turn: number;
        readonly entry_alarm: number | null;
        readonly exit_alarm: number | null;
        readonly next_attempt_at: number | null;
    }[] {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const exists = sql.one<{ present: number }>(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_chardb_alarm_probe'"
        );
        return exists
            ? sql.all("SELECT turn, entry_alarm, exit_alarm, next_attempt_at FROM _chardb_alarm_probe ORDER BY turn")
            : [];
    }

    async proofDeferDeleteWake(delayMs: number): Promise<{ readonly wakeAt: number }> {
        if (!Number.isSafeInteger(delayMs) || delayMs < 10 || delayMs > 1_000) {
            throw new TypeError("platform alarm proof delay is invalid");
        }
        const wakeAt = Date.now() + delayMs;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec("UPDATE _chardb_vector_attempts SET settle_after = ? WHERE delete_confirmed = 0", wakeAt);
            sql.exec(
                `UPDATE _chardb_vector_outbox
                 SET next_attempt_at = ?, leased_until = NULL, lease_token = NULL
                 WHERE operation = 'delete' AND phase = 'submit' AND terminal_failure = 0`,
                wakeAt
            );
            if (sql.changes() !== 1) throw new Error("platform alarm proof expected one deferred delete");
        });
        await this.ctx.storage.setAlarm(wakeAt);
        return Object.freeze({ wakeAt });
    }
}

interface WorkerEnv extends VectorProofEnv {
    readonly CDB: DurableObjectNamespace;
    readonly PLATFORM_CDB: DurableObjectNamespace;
}

function requestFor(body: Record<string, unknown>) {
    const organizationId = String(body.organizationId);
    return {
        principalId: "vector-proof-user",
        mutId: String(body.mutId),
        ref: String(body.ref),
        args: body.args as RawJson,
        auth: {
            userId: "vector-proof-user",
            tenantId: organizationId,
            role: "member",
            roles: ["member"],
            claims: {},
        },
        placement: { authority: "organization" as const, partitionKey: organizationId },
        recoveryGeneration: 0,
        schemaEpoch: 1,
        domainSchemaEpoch: 1,
    };
}

async function body(request: Request): Promise<Record<string, unknown>> {
    return (await request.json()) as Record<string, unknown>;
}

function json(value: unknown, status = 200): Response {
    return Response.json(value, { status });
}

export default {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
        try {
            const path = new URL(request.url).pathname;
            const input = request.method === "POST" ? await body(request) : {};
            const namespace = input.platformAlarm === true ? env.PLATFORM_CDB : env.CDB;
            const cdb = namespace.get(
                namespace.idFromName(String(input.shardId ?? "vector-proof-shard"))
            ) as unknown as VectorProofCdb & PlatformAlarmVectorProofCdb;
            const index = env.VECTOR_INDEX.get(
                env.VECTOR_INDEX.idFromName("vector-proof-index")
            ) as unknown as VectorIndexProbe;
            if (path === "/mutate") return json(await cdb.mutate(requestFor(input)));
            if (path === "/state") return json(await cdb.proofState());
            if (path === "/alarm") {
                await cdb.proofAlarm();
                return json({ ok: true });
            }
            if (path === "/scheduled-alarm") return json({ alarm: await cdb.proofScheduledAlarm() });
            if (path === "/alarm-turns") return json(await cdb.proofAlarmTurns());
            if (path === "/defer-delete-wake") {
                return json(await cdb.proofDeferDeleteWake(Number(input.delayMs)));
            }
            if (path === "/force-due") {
                await cdb.proofForceDueAndSettled();
                return json({ ok: true });
            }
            if (path === "/force-accepted-delete-poll-bound") {
                await cdb.proofForceAcceptedDeletePollBound();
                return json({ ok: true });
            }
            if (path === "/claim-only") return json(await cdb.proofClaimOnly());
            if (path === "/expire-lease") {
                await cdb.proofExpireLease();
                return json({ ok: true });
            }
            if (path === "/organization-guard") {
                return json(await cdb.proofOrganizationGuard(String(input.nextOrganizationId)));
            }
            if (path === "/reshard-rejection") return json(await cdb.proofReshardRejection());
            if (path === "/vector-fault") {
                await index.setFault(
                    String(input.mode) as FaultMode,
                    typeof input.targetId === "string" ? input.targetId : undefined
                );
                return json({ ok: true });
            }
            if (path === "/vector-state") return json(await index.inspect());
            if (path === "/vector-process") return json(await index.processPending(Number(input.limit ?? 1)));
            if (path === "/benchmark-search") {
                return json(
                    await cdb.proofVectorSearch(
                        String(input.organizationId),
                        Array.isArray(input.values) ? (input.values as number[]) : [],
                        Number(input.limit)
                    )
                );
            }
            if (path === "/rpc-vector-search") {
                const organizationId = String(input.organizationId);
                const result = await dispatchOrganizationVectorSearch({
                    session: {
                        user: { id: "vector-proof-user" },
                        session: { activeOrganizationId: organizationId },
                    },
                    locator: {
                        organizationId,
                        table: benchmarkVectorResource.table,
                        column: benchmarkVectorResource.column,
                    },
                    resources: [benchmarkVectorResource],
                    values: Array.isArray(input.values) ? (input.values as number[]) : [],
                    limit: Number(input.limit),
                    catalog: {
                        async resolveOrganizationAuthorityRoute() {
                            return {
                                authority: {
                                    principalId: PrincipalId("vector-proof-user"),
                                    organizationId: TenantId(organizationId),
                                    recoveryGeneration: 0,
                                    role: "member",
                                    roles: ["member"],
                                    authEpochs: { global: 1, tenant: 1, principal: 1 },
                                },
                                route: {
                                    shardId: "vector-proof-shard" as never,
                                    recoveryGeneration: 0,
                                    schemaEpoch: 1,
                                    domainSchemaEpoch: Number(input.domainSchemaEpoch ?? 1),
                                },
                            };
                        },
                    },
                    indexes: { CDB_PROOF_VECTORS: index },
                    validate: validation => cdb.resolveOrganizationVectorSearch(validation),
                });
                return json(result);
            }
            if (path === "/runtime-boot-id") return json({ runtimeBootId: currentRuntimeBootId() });
            if (path === "/refs") {
                return json({
                    put: putVector.__chardbRef,
                    benchmarkPut: putBenchmarkVector.__chardbRef,
                    replace: replaceVector.__chardbRef,
                    delete: deleteVector.__chardbRef,
                    move: moveVectorIdentity.__chardbRef,
                });
            }
            return json({ error: "not found" }, 404);
        } catch (error) {
            return json(
                {
                    error: error instanceof Error ? error.message : String(error),
                    ...(isCdbError(error) ? { code: error.code } : {}),
                },
                500
            );
        }
    },
};
