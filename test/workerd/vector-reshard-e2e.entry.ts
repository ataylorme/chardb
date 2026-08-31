import { DurableObject } from "cloudflare:workers";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { eq } from "drizzle-orm";
import { text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { isCdbError } from "../../src/errors.ts";
import { SPLIT_LOG_ACCOUNTED_BYTES_SQL } from "../../src/oplog/schema.ts";
import type { TableSpec } from "../../src/reshard/triggers.ts";
import { forOrg } from "../../src/server/cdb-tenant.ts";
import { api } from "../../src/server/define.ts";
import { cdbVectorLogicalId } from "../../src/server/do/cdb-vector-mutation.ts";
import { CdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import type {
    CdbVectorizeMutationIndex,
    CdbVectorizeQueryOptions,
    CdbVectorizeRecord,
    CdbVectorizeSearchIndex,
} from "../../src/server/do/cdb-vectorize-adapter.ts";
import type { CdbEnv } from "../../src/server/do/cdb.ts";
import { Resharder as ProductionResharder, RESHARDER_PHASE } from "../../src/server/do/resharder.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { withExternalReshardCapture } from "../../src/server/external-reshard-capture.ts";
import { gatewayBucketName } from "../../src/server/gateway-bucket.ts";
import { chardb, defineAuth, defineMigrations, defineSchemaBaseline } from "../../src/server/index.ts";
import {
    cdbVectorResourceId,
    collectSchemaResourceDescriptors,
    isChardbVectorResourceDescriptor,
} from "../../src/server/resource-descriptors.ts";
import { renderVectorMutationTriggerSet } from "../../src/server/vector-triggers.ts";
import { searchVector, vector } from "../../src/vector.ts";
import { vshardOf } from "../../src/vshard.ts";

const ISSUER = "https://vector-reshard-e2e.invalid";
const AUDIENCE = "vector-reshard-e2e";
const JWKS_URL = "https://vector-reshard-e2e.invalid/jwks";

const auth = defineAuth({
    appName: "vector-reshard-e2e",
    baseURL: ISSUER,
    plugins: [
        organization(),
        jwt({
            jwt: { issuer: ISSUER, audience: AUDIENCE },
            jwks: {
                remoteUrl: JWKS_URL,
                keyPairConfig: { alg: "ES256" },
            },
        }),
    ],
});
const { cdbTable } = forOrg();
const messages = cdbTable(
    "vector_move_messages",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        body: text("body").notNull(),
        embedding: vector("embedding", { dim: 3, binding: "CDB_PROOF_VECTORS", metric: "cosine" }),
    },
    { roles: { member: { create: "*", read: "*", update: ["body", "embedding"], delete: true } } }
);
const schema = { messages };
const resource = (() => {
    const found = collectSchemaResourceDescriptors(schema).find(isChardbVectorResourceDescriptor);
    if (!found || !isChardbVectorResourceDescriptor(found)) throw new Error("vector proof resource is missing");
    return found;
})();
const resourceId = cdbVectorResourceId(resource);
const mutationTriggerNames = renderVectorMutationTriggerSet(resource).names;

const publicVectorArgs = z.object({
    organizationId: z.string(),
    id: z.string(),
    body: z.string(),
    values: z.array(z.number()).length(3),
});

const putMessage = api.mutation({
    ref: "test/workerd/vector-reshard-e2e.entry.ts#putMessage",
    authority: "organization",
    partitionKey: "organizationId",
    args: publicVectorArgs,
    handler: (ctx, args) => {
        const embedding = ctx.vector.set(messages.embedding, args.id, args.values);
        ctx.db.insert(messages).values({ id: args.id, body: args.body, embedding }).run();
        return { id: args.id };
    },
});

const replaceMessage = api.mutation({
    ref: "test/workerd/vector-reshard-e2e.entry.ts#replaceMessage",
    authority: "organization",
    partitionKey: "organizationId",
    args: z.object({
        organizationId: z.string(),
        id: z.string(),
        body: z.string(),
        values: z.array(z.number()).length(3),
    }),
    handler: (ctx, args) => {
        const embedding = ctx.vector.set(messages.embedding, args.id, args.values);
        ctx.db.update(messages).set({ body: args.body, embedding }).where(eq(messages.id, args.id)).run();
        return { id: args.id };
    },
});

const deleteMessage = api.mutation({
    ref: "test/workerd/vector-reshard-e2e.entry.ts#deleteMessage",
    authority: "organization",
    partitionKey: "organizationId",
    args: z.object({ organizationId: z.string(), id: z.string() }),
    handler: (ctx, args) => {
        ctx.vector.delete(messages.embedding, args.id);
        ctx.db.delete(messages).where(eq(messages.id, args.id)).run();
        return { id: args.id };
    },
});

const searchMessages = api.query({
    ref: "test/workerd/vector-reshard-e2e.entry.ts#searchMessages",
    args: z.object({
        organizationId: z.string(),
        values: z.array(z.number()).length(3),
        limit: z.number().int().min(1).max(100),
    }),
    query: (_db, args) =>
        searchVector(messages.embedding, {
            organizationId: args.organizationId,
            values: args.values,
            limit: args.limit,
        }),
});

const migrations = defineMigrations([
    defineSchemaBaseline({
        version: 1,
        name: "vector_move_e2e",
        domainSchema: schema,
        authOptions: auth.options,
    }),
]);
const app = chardb({ auth, schema, api: { putMessage, replaceMessage, deleteMessage, searchMessages }, migrations });

const TABLES = Object.freeze([
    Object.freeze({
        name: "vector_move_messages",
        partitionColumn: "organization_id",
        columns: Object.freeze(["id", "organization_id", "body", "embedding"]),
    }),
]) satisfies readonly TableSpec[];
const SOURCE = "ShardDO_0";

interface Env extends CdbEnv {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_RESHARD: DurableObjectNamespace;
    readonly VECTOR_INDEX: DurableObjectNamespace;
}

interface Route {
    readonly shardId: string;
    readonly schemaEpoch: number;
    readonly domainSchemaEpoch: number;
}

interface CatalogRpc {
    schemaState(): Promise<{ activeVersion: number }>;
    beginSchemaMigration(args: { migrationId: string; targetVersion: number }): Promise<unknown>;
    migrateSchemaShard(args: { migrationId: string; shardId: string }): Promise<unknown>;
    applyCatalogSchemaMigration(args: { migrationId: string; version: number }): Promise<unknown>;
    completeSchemaMigration(args: { migrationId: string }): Promise<unknown>;
    mutateAuth(args: Record<string, unknown>): Promise<unknown>;
    route(vshard: number): Promise<Route>;
    seedJwkForTest(jwksUrl: string, kid: string, jwkJson: string, ttlMs: number): Promise<void>;
}

interface GatewayRpc {
    fixtureRunRealAlarm(): Promise<void>;
    fixtureRegistrationState(input: { readonly subId: number }): Promise<Record<string, unknown> | null>;
}

type VectorResponseLossOperation =
    | "apply_snapshot"
    | "apply_tail"
    | "read_tombstones_v2"
    | "verify_parity"
    | "finalize_dest"
    | "drain_source";

interface CdbRpc {
    schemaState(): Promise<{ activeVersion: number; activeEpoch: number; activeDigest: string }>;
    mutate(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    fixtureSeed(input: { organizationId: string; count: number }): Promise<Record<string, unknown>>;
    fixtureDeleteOrganization(input: { organizationId: string; domainSchemaEpoch: number }): Promise<unknown>;
    fixtureState(input: { organizationId: string; migId: string }): Promise<Record<string, unknown>>;
    fixtureArmResponseLoss(input: { migId: string; operation: VectorResponseLossOperation }): Promise<void>;
    fixtureResponseLossState(input: { migId: string }): Promise<readonly Record<string, unknown>[]>;
    fixtureForceDue(input: { readonly organizationId: string }): Promise<void>;
    fixtureRunRealAlarm(): Promise<void>;
}

interface ResharderRpc {
    startSplit(args: {
        migId: string;
        srcShard: string;
        dstShard: string;
        rangeLo: number;
        rangeHi: number;
        epochAtStart: number;
        tables: readonly TableSpec[];
    }): Promise<void>;
    runSplit(migId: string): Promise<{ phase: number }>;
    getPhase(migId: string): Promise<number | null>;
    abort(migId: string): Promise<void>;
    fixtureState(migId: string): Promise<Record<string, unknown>>;
}

function catalog(env: Env): CatalogRpc {
    return env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogRpc;
}

function cdb(env: Env, shardId: string): CdbRpc {
    return env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as CdbRpc;
}

function resharder(env: Env): ResharderRpc {
    return env.CDB_RESHARD.get(env.CDB_RESHARD.idFromName("global")) as unknown as ResharderRpc;
}

function gateway(env: Env, clientId: string): GatewayRpc {
    return env.CDB_GATEWAY.get(env.CDB_GATEWAY.idFromName(gatewayBucketName(clientId))) as unknown as GatewayRpc;
}

function placement(organizationId: string): number {
    return Number(vshardOf([organizationId]));
}

function vectorAuth(organizationId: string) {
    return {
        userId: "vector-e2e-user",
        tenantId: organizationId,
        role: "member",
        roles: ["member"],
        authEpochs: { global: 1, tenant: 1, principal: 1 },
        claims: {},
    };
}

export class VectorIndexProbe extends DurableObject<Record<string, never>> {
    constructor(state: DurableObjectState, env: Record<string, never>) {
        super(state, env);
        state.blockConcurrencyWhile(async () => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(`CREATE TABLE IF NOT EXISTS vector_probe_calls (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'get')),
              ids_json TEXT NOT NULL
            )`);
            sql.exec(`CREATE TABLE IF NOT EXISTS vector_probe_documents (
              id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL
            )`);
        });
    }

    upsert(records: readonly CdbVectorizeRecord[]): { readonly ids: readonly string[]; readonly count: number } {
        const ids = records.map(record => record.id);
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec("INSERT INTO vector_probe_calls (operation, ids_json) VALUES ('upsert', ?)", JSON.stringify(ids));
            for (const record of records) {
                sql.exec(
                    `INSERT INTO vector_probe_documents (id, payload_json) VALUES (?, ?)
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
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec("INSERT INTO vector_probe_calls (operation, ids_json) VALUES ('delete', ?)", JSON.stringify(ids));
            for (const id of ids) sql.exec("DELETE FROM vector_probe_documents WHERE id = ?", id);
        });
        return { ids: [...ids], count: ids.length };
    }

    getByIds(ids: readonly string[]): readonly CdbVectorizeRecord[] {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec("INSERT INTO vector_probe_calls (operation, ids_json) VALUES ('get', ?)", JSON.stringify(ids));
        const rows = ids.length
            ? sql.all<{ payload_json: string }>(
                  `SELECT payload_json FROM vector_probe_documents
                   WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`,
                  ...ids
              )
            : [];
        return rows.map(row => JSON.parse(row.payload_json) as CdbVectorizeRecord);
    }

    query(values: readonly number[], options: CdbVectorizeQueryOptions) {
        if (
            values.length !== 3 ||
            values.some(value => !Number.isFinite(value)) ||
            options.returnValues !== false ||
            options.returnMetadata !== "none" ||
            !Number.isSafeInteger(options.topK) ||
            options.topK < 1 ||
            options.topK > 100
        ) {
            throw new TypeError("invalid vector reshard query contract");
        }
        const magnitude = (items: readonly number[]) => Math.sqrt(items.reduce((sum, item) => sum + item * item, 0));
        const queryMagnitude = magnitude(values);
        const matches = adaptSqlStorage(this.ctx.storage.sql)
            .all<{ id: string; payload_json: string }>(
                "SELECT id, payload_json FROM vector_probe_documents ORDER BY id"
            )
            .flatMap(row => {
                const record = JSON.parse(row.payload_json) as CdbVectorizeRecord;
                if (
                    record.namespace !== options.namespace ||
                    record.metadata.cdb_resource !== options.filter.cdb_resource
                ) {
                    return [];
                }
                const stored = Array.from(record.values);
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

    inspect(): Record<string, unknown> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            calls: sql.all("SELECT sequence, operation, ids_json FROM vector_probe_calls ORDER BY sequence"),
            documents: sql.all("SELECT id FROM vector_probe_documents ORDER BY id"),
        };
    }
}

export class Catalog extends app.Catalog {
    seedJwkForTest(jwksUrl: string, kid: string, jwkJson: string, ttlMs: number): void {
        const now = Date.now();
        const cursor = this.ctx.storage.sql.exec(
            `INSERT INTO catalog_jwks_v2
             (jwks_url, kid, jwk_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(jwks_url, kid) DO UPDATE SET
               jwk_json = excluded.jwk_json,
               fetched_at = excluded.fetched_at,
               expires_at = excluded.expires_at`,
            jwksUrl,
            kid,
            jwkJson,
            now,
            now + ttlMs
        );
        for (const _ of cursor.raw()) {
            // Drain the write cursor.
        }
    }
}

export class Gateway extends app.Gateway {
    override async alarm(): Promise<void> {}

    fixtureRunRealAlarm(): Promise<void> {
        return super.alarm();
    }

    fixtureRegistrationState(input: { readonly subId: number }) {
        return adaptSqlStorage(this.ctx.storage.sql).one<{
            lifecycle: string;
            cdb_state: string;
            current_head: number;
            retry_error: string | null;
        }>(
            `SELECT g.lifecycle, g.cdb_state,
                    CASE WHEN h.registration_id IS NULL THEN 0 ELSE 1 END AS current_head,
                    g.retry_error
             FROM _gw_registration_generations AS g
             LEFT JOIN _gw_registration_heads AS h ON h.registration_id = g.registration_id
             WHERE g.sub_id = ? ORDER BY g.created_at DESC LIMIT 1`,
            input.subId
        );
    }
}

export class Cdb extends app.Cdb {
    private readonly proofEnv: Env;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        this.proofEnv = env;
    }

    protected override resolveVectorIndex(binding: string): CdbVectorizeMutationIndex {
        if (binding !== "CDB_PROOF_VECTORS") throw new Error("unexpected vector proof binding");
        return this.proofEnv.VECTOR_INDEX.get(
            this.proofEnv.VECTOR_INDEX.idFromName("vector-proof-index")
        ) as unknown as CdbVectorizeMutationIndex;
    }

    protected override resolveVectorSearchIndex(binding: string): CdbVectorizeSearchIndex {
        if (binding !== "CDB_PROOF_VECTORS") throw new Error("unexpected vector search binding");
        return this.proofEnv.VECTOR_INDEX.get(
            this.proofEnv.VECTOR_INDEX.idFromName("vector-proof-index")
        ) as unknown as CdbVectorizeSearchIndex;
    }

    override async alarm(): Promise<void> {}

    fixtureForceDue(input: { readonly organizationId: string }): void {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        this.ctx.storage.transactionSync(() =>
            withExternalReshardCapture(sql, placement(input.organizationId), () => {
                sql.exec(
                    "UPDATE _chardb_vector_outbox SET next_attempt_at = 0, leased_until = NULL, lease_token = NULL"
                );
                sql.exec("UPDATE _chardb_vector_attempts SET settle_after = first_sent_at");
            })
        );
    }

    async fixtureRunRealAlarm(): Promise<void> {
        await this.ctx.storage.deleteAlarm();
        await super.alarm();
    }

    fixtureSeed(input: { organizationId: string; count: number }): Record<string, unknown> {
        if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 501) {
            throw new Error("fixture vector count is invalid");
        }
        const vshard = placement(input.organizationId);
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        this.ctx.storage.transactionSync(() => {
            const vectors = new CdbVectorOutboxStore(sql);
            for (let index = 0; index < input.count; index++) {
                const id = `${input.organizationId}-row-${index.toString().padStart(4, "0")}`;
                const vectorId = cdbVectorLogicalId(resourceId, input.organizationId, id);
                vectors.stageUpsert({
                    vectorId,
                    organizationId: input.organizationId,
                    resourceId,
                    rowPk: id,
                    dimensions: 3,
                    values: [index + 0.25, index + 0.5, index + 0.75],
                    metadata: { seed: index },
                    nowMs: index + 1,
                });
                sql.exec(
                    `INSERT INTO vector_move_messages (id, organization_id, body, embedding)
                     VALUES (?, ?, ?, ?)`,
                    id,
                    input.organizationId,
                    `seed-${index}`,
                    vectorId
                );
                sql.exec(
                    `INSERT INTO _chardb_vector_attempts
                       (vector_id, physical_version, first_sent_at, settle_after)
                     VALUES (?, 1, ?, ?)`,
                    vectorId,
                    index + 1,
                    index + 1
                );
            }
        });
        return { count: input.count, vshard };
    }

    fixtureDeleteOrganization(input: { organizationId: string; domainSchemaEpoch: number }): Promise<unknown> {
        return this.deleteOrganizationFiles({
            organizationId: input.organizationId,
            nowMs: Date.now(),
            domainSchemaEpoch: input.domainSchemaEpoch,
        });
    }

    fixtureArmResponseLoss(input: { migId: string; operation: VectorResponseLossOperation }): void {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.migId)) throw new Error("fixture migration id is invalid");
        if (
            ![
                "apply_snapshot",
                "apply_tail",
                "read_tombstones_v2",
                "verify_parity",
                "finalize_dest",
                "drain_source",
            ].includes(input.operation)
        ) {
            throw new Error("fixture response-loss operation is invalid");
        }
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        this.ensureResponseLossTable(sql);
        sql.exec(
            `INSERT INTO fixture_vector_response_loss (mig_id, operation, fired, calls)
             VALUES (?, ?, 0, 0)`,
            input.migId,
            input.operation
        );
    }

    fixtureResponseLossState(input: { migId: string }): readonly Record<string, unknown>[] {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        this.ensureResponseLossTable(sql);
        return sql.all(
            `SELECT operation, fired, calls FROM fixture_vector_response_loss
             WHERE mig_id = ? ORDER BY operation`,
            input.migId
        );
    }

    override applyReshardVectorSnapshot(
        args: Parameters<InstanceType<typeof app.Cdb>["applyReshardVectorSnapshot"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["applyReshardVectorSnapshot"]> {
        const result = super.applyReshardVectorSnapshot(args);
        this.maybeLoseResponse(args.migId, "apply_snapshot");
        return result;
    }

    override readReshardFileTombstonesV2(
        args: Parameters<InstanceType<typeof app.Cdb>["readReshardFileTombstonesV2"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["readReshardFileTombstonesV2"]> {
        this.maybeLoseResponse(args.migId, "read_tombstones_v2");
        return super.readReshardFileTombstonesV2(args);
    }

    override async applyTailBatch(
        args: Parameters<InstanceType<typeof app.Cdb>["applyTailBatch"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["applyTailBatch"]> {
        const result = await super.applyTailBatch(args);
        this.maybeLoseResponse(args.migId, "apply_tail");
        return result;
    }

    override verifyReshardVectorParity(
        args: Parameters<InstanceType<typeof app.Cdb>["verifyReshardVectorParity"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["verifyReshardVectorParity"]> {
        const result = super.verifyReshardVectorParity(args);
        this.maybeLoseResponse(args.migId, "verify_parity");
        return result;
    }

    override finalizeReshardVectorDest(
        args: Parameters<InstanceType<typeof app.Cdb>["finalizeReshardVectorDest"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["finalizeReshardVectorDest"]> {
        const result = super.finalizeReshardVectorDest(args);
        this.maybeLoseResponse(args.migId, "finalize_dest");
        return result;
    }

    override drainReshardVectorSource(
        args: Parameters<InstanceType<typeof app.Cdb>["drainReshardVectorSource"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["drainReshardVectorSource"]> {
        const result = super.drainReshardVectorSource(args);
        this.maybeLoseResponse(args.migId, "drain_source");
        return result;
    }

    fixtureState(input: { organizationId: string; migId: string }): Record<string, unknown> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const hasDomainTable =
            sql.one<{ present: number }>(
                "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'vector_move_messages'"
            ) !== null;
        return {
            rows: hasDomainTable
                ? sql.all(
                      `SELECT id, organization_id, body, embedding FROM vector_move_messages
                       WHERE organization_id = ? ORDER BY id`,
                      input.organizationId
                  )
                : [],
            heads: sql.all(
                `SELECT vector_id, created_seq, organization_id, row_pk, version, delivered_version, state
                 FROM _chardb_vectors WHERE organization_id = ? ORDER BY vector_id`,
                input.organizationId
            ),
            outbox: sql.all(
                `SELECT outbox.vector_id, outbox.target_version, outbox.operation, outbox.phase, outbox.attempts
                 FROM _chardb_vector_outbox AS outbox
                 JOIN _chardb_vectors AS head ON head.vector_id = outbox.vector_id
                 WHERE head.organization_id = ? ORDER BY outbox.vector_id`,
                input.organizationId
            ),
            attempts: sql.all(
                `SELECT attempt.vector_id, attempt.physical_version
                 FROM _chardb_vector_attempts AS attempt
                 JOIN _chardb_vectors AS head ON head.vector_id = attempt.vector_id
                 WHERE head.organization_id = ? ORDER BY attempt.vector_id, attempt.physical_version`,
                input.organizationId
            ),
            capacity: sql.one("SELECT * FROM _chardb_vector_capacity WHERE singleton = 1"),
            scheduler: sql.one("SELECT * FROM _chardb_vector_scheduler WHERE singleton = 1"),
            sequence: sql.one("SELECT * FROM _chardb_vector_head_sequence WHERE singleton = 1"),
            tombstone: sql.one(
                `SELECT organization_id, deleted_at, placement_vshard FROM _chardb_deleted_organizations
                 WHERE organization_id = ?`,
                input.organizationId
            ),
            split: sql.one("SELECT * FROM _chardb_split_state WHERE mig_id = ?", input.migId),
            vectorSession: sql.one("SELECT * FROM _chardb_vector_reshard_dest_sessions WHERE mig_id = ?", input.migId),
            provenance: sql.one(
                "SELECT * FROM _chardb_vector_reshard_provenance_identity WHERE mig_id = ?",
                input.migId
            ),
            vectorTail: sql.all(
                `SELECT lsn, source_tx_id, op, table_name, pk FROM _chardb_split_log
                 WHERE mig_id = ? AND table_name LIKE '_chardb_vector%' ORDER BY lsn`,
                input.migId
            ),
            tailAccounting: sql.one(
                `SELECT COUNT(*) AS rows, COALESCE(SUM(${SPLIT_LOG_ACCOUNTED_BYTES_SQL}), 0) AS bytes
                 FROM _chardb_split_log WHERE mig_id = ?`,
                input.migId
            ),
            vectorCaptureTriggers: sql.one<{ count: number }>(
                `SELECT COUNT(*) AS count FROM sqlite_master
                 WHERE type = 'trigger' AND name GLOB '_chardb_vectorcapt_*'`
            )?.count,
            vectorMutationTriggers: sql.one<{ count: number }>(
                `SELECT COUNT(*) AS count FROM sqlite_master
                 WHERE type = 'trigger' AND name IN (${mutationTriggerNames.map(() => "?").join(", ")})`,
                ...mutationTriggerNames
            )?.count,
        };
    }

    private ensureResponseLossTable(sql: ReturnType<typeof adaptSqlStorage>): void {
        sql.exec(`CREATE TABLE IF NOT EXISTS fixture_vector_response_loss (
          mig_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          fired INTEGER NOT NULL CHECK (fired IN (0, 1)),
          calls INTEGER NOT NULL CHECK (calls >= 0),
          PRIMARY KEY (mig_id, operation)
        )`);
    }

    private maybeLoseResponse(migId: string, operation: VectorResponseLossOperation): void {
        let lose = false;
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            this.ensureResponseLossTable(sql);
            const armed = sql.one<{ fired: number }>(
                "SELECT fired FROM fixture_vector_response_loss WHERE mig_id = ? AND operation = ?",
                migId,
                operation
            );
            if (!armed) return;
            lose = armed.fired === 0;
            sql.exec(
                `UPDATE fixture_vector_response_loss
                 SET fired = CASE WHEN fired = 0 THEN 1 ELSE fired END, calls = calls + 1
                 WHERE mig_id = ? AND operation = ?`,
                migId,
                operation
            );
        });
        if (lose) throw new Error(`fixture response lost after ${operation} commit`);
    }
}

export class Resharder extends ProductionResharder {
    fixtureState(migId: string): Record<string, unknown> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            migration: sql.one("SELECT * FROM migration_state WHERE mig_id = ?", migId),
            work: sql.one("SELECT * FROM migration_work_cursor WHERE mig_id = ?", migId),
            file: sql.one("SELECT * FROM migration_file_cursor WHERE mig_id = ?", migId),
            vector: sql.one("SELECT * FROM migration_vector_cursor WHERE mig_id = ?", migId),
        };
    }
}

export const DB = app.DB;

async function activateSchema(env: Env): Promise<void> {
    const cat = catalog(env);
    if ((await cat.schemaState()).activeVersion !== 0) return;
    const migrationId = "vector-move-schema-v1";
    await cat.beginSchemaMigration({ migrationId, targetVersion: 1 });
    await cat.migrateSchemaShard({ migrationId, shardId: SOURCE });
    await cat.applyCatalogSchemaMigration({ migrationId, version: 1 });
    await cat.completeSchemaMigration({ migrationId });
}

async function setupPublicVector(
    env: Env,
    input: { organizationId: string; kid: string; jwk: JsonWebKey }
): Promise<Record<string, unknown>> {
    await activateSchema(env);
    const cat = catalog(env);
    const now = Date.now();
    const userId = "vector-e2e-public-user";
    await cat.seedJwkForTest(JWKS_URL, input.kid, JSON.stringify(input.jwk), 60_000);
    await cat.mutateAuth({
        model: "user",
        op: "create",
        payload: {
            id: userId,
            name: "Vector E2E Public User",
            email: "vector-public@example.com",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
        },
    });
    await cat.mutateAuth({
        model: "organization",
        op: "create",
        payload: {
            id: input.organizationId,
            name: input.organizationId,
            slug: input.organizationId,
            createdAt: now,
        },
    });
    await cat.mutateAuth({
        model: "member",
        op: "create",
        payload: {
            id: `member-${input.organizationId}`,
            organizationId: input.organizationId,
            userId,
            role: "member",
            createdAt: now,
        },
    });
    const vshard = placement(input.organizationId);
    return {
        userId,
        vshard,
        route: await cat.route(vshard),
        putRef: putMessage.__chardbRef,
        replaceRef: replaceMessage.__chardbRef,
        deleteRef: deleteMessage.__chardbRef,
        searchRef: searchMessages.__chardbRef,
    };
}

async function startPublicSplit(
    env: Env,
    input: { migId: string; destination: string; organizationId: string }
): Promise<Record<string, unknown>> {
    const cat = catalog(env);
    const vshard = placement(input.organizationId);
    const route = await cat.route(vshard);
    if (route.shardId !== SOURCE) throw new Error(`public fixture range is owned by ${route.shardId}`);
    await resharder(env).startSplit({
        migId: input.migId,
        srcShard: SOURCE,
        dstShard: input.destination,
        rangeLo: vshard,
        rangeHi: vshard,
        epochAtStart: route.schemaEpoch,
        tables: TABLES,
    });
    return { route, vshard };
}

async function setup(
    env: Env,
    input: { migId: string; destination: string; organizationId: string; count: number }
): Promise<Record<string, unknown>> {
    await activateSchema(env);
    const cat = catalog(env);
    const vshard = placement(input.organizationId);
    const route = await cat.route(vshard);
    if (route.shardId !== SOURCE) throw new Error(`fixture range is owned by ${route.shardId}`);
    await cat.mutateAuth({
        model: "organization",
        op: "create",
        payload: {
            id: input.organizationId,
            name: input.organizationId,
            slug: input.organizationId,
            createdAt: Date.now(),
        },
    });
    const seeded = await cdb(env, SOURCE).fixtureSeed({ organizationId: input.organizationId, count: input.count });
    await resharder(env).startSplit({
        migId: input.migId,
        srcShard: SOURCE,
        dstShard: input.destination,
        rangeLo: vshard,
        rangeHi: vshard,
        epochAtStart: route.schemaEpoch,
        tables: TABLES,
    });
    return { route, vshard, seeded };
}

async function mutate(
    env: Env,
    input: { shardId: string; organizationId: string; rowId: string; mutId: string; body: string; values: number[] }
): Promise<Record<string, unknown>> {
    const route = await catalog(env).route(placement(input.organizationId));
    return cdb(env, input.shardId).mutate({
        principalId: "vector-e2e-user",
        mutId: input.mutId,
        ref: replaceMessage.__chardbRef,
        args: {
            organizationId: input.organizationId,
            id: input.rowId,
            body: input.body,
            values: input.values,
        },
        placement: { authority: "organization", partitionKey: input.organizationId },
        auth: vectorAuth(input.organizationId),
        schemaEpoch: route.schemaEpoch,
        domainSchemaEpoch: route.domainSchemaEpoch,
    });
}

async function deleteOrganization(env: Env, input: { shardId: string; organizationId: string }): Promise<unknown> {
    const route = await catalog(env).route(placement(input.organizationId));
    return cdb(env, input.shardId).fixtureDeleteOrganization({
        organizationId: input.organizationId,
        domainSchemaEpoch: route.domainSchemaEpoch,
    });
}

function json(value: unknown, status = 200): Response {
    return Response.json(value, { status });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const operation = url.pathname.slice(1);
        if (operation === "ws") {
            const clientId = url.searchParams.get("clientId") ?? "missing-public-vector-client";
            return env.CDB_GATEWAY.get(env.CDB_GATEWAY.idFromName(gatewayBucketName(clientId))).fetch(request);
        }
        const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
        try {
            if (operation === "setupPublicVector") return json(await setupPublicVector(env, body as never));
            if (operation === "startPublicSplit") return json(await startPublicSplit(env, body as never));
            if (operation === "setup") return json(await setup(env, body as never));
            if (operation === "run") return json(await resharder(env).runSplit(String(body.migId)));
            if (operation === "abort") {
                await resharder(env).abort(String(body.migId));
                return json({ ok: true });
            }
            if (operation === "phase") {
                const migId = String(body.migId);
                return json({
                    phase: await resharder(env).getPhase(migId),
                    state: await resharder(env).fixtureState(migId),
                });
            }
            if (operation === "mutate") return json(await mutate(env, body as never));
            if (operation === "deleteOrganization") return json(await deleteOrganization(env, body as never));
            if (operation === "route") return json(await catalog(env).route(Number(body.vshard)));
            if (operation === "state") {
                const input = { organizationId: String(body.organizationId), migId: String(body.migId) };
                return json({
                    source: await cdb(env, SOURCE).fixtureState(input),
                    destination: await cdb(env, String(body.destination)).fixtureState(input),
                    resharder: await resharder(env).fixtureState(input.migId),
                });
            }
            if (operation === "armResponseLoss") {
                await cdb(env, String(body.shardId)).fixtureArmResponseLoss({
                    migId: String(body.migId),
                    operation: String(body.operation) as VectorResponseLossOperation,
                });
                return json({ ok: true });
            }
            if (operation === "responseLossState") {
                return json(
                    await cdb(env, String(body.shardId)).fixtureResponseLossState({ migId: String(body.migId) })
                );
            }
            if (operation === "runRealAlarm") {
                await cdb(env, String(body.shardId)).fixtureRunRealAlarm();
                return json({ ok: true });
            }
            if (operation === "forceVectorDue") {
                await cdb(env, String(body.shardId)).fixtureForceDue({ organizationId: String(body.organizationId) });
                return json({ ok: true });
            }
            if (operation === "runGatewayAlarm") {
                await gateway(env, String(body.clientId)).fixtureRunRealAlarm();
                return json({ ok: true });
            }
            if (operation === "gatewayRegistration") {
                return json(
                    await gateway(env, String(body.clientId)).fixtureRegistrationState({ subId: Number(body.subId) })
                );
            }
            const index = env.VECTOR_INDEX.get(
                env.VECTOR_INDEX.idFromName("vector-proof-index")
            ) as unknown as VectorIndexProbe;
            if (operation === "vectorCalls") return json(await index.inspect());
            if (operation === "constants") {
                return json({
                    source: SOURCE,
                    phases: RESHARDER_PHASE,
                    resourceId,
                    mutationTriggerCount: mutationTriggerNames.length,
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
