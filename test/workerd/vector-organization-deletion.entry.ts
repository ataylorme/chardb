import { DurableObject } from "cloudflare:workers";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { isCdbError, rehydrateCdbRpcError } from "../../src/errors.ts";
import { FileId, file } from "../../src/files/index.ts";
import { forOrg } from "../../src/server/cdb-tenant.ts";
import { api } from "../../src/server/define.ts";
import { CatalogOrganizationDeletionStore } from "../../src/server/do/catalog-organization-deletion-store.ts";
import { cdbVectorLogicalId, stageCdbVector } from "../../src/server/do/cdb-vector-mutation.ts";
import { CDB_VECTOR_MAX_OUTBOX_ROWS, CdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import type { CdbVectorizeMutationIndex, CdbVectorizeRecord } from "../../src/server/do/cdb-vectorize-adapter.ts";
import type { CdbEnv } from "../../src/server/do/cdb.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { chardb, defineAuth, defineMigrations, defineSchemaBaseline } from "../../src/server/index.ts";
import { cdbVectorResourceId } from "../../src/server/resource-descriptors.ts";
import { PrincipalId, TenantId } from "../../src/types.ts";
import { vector } from "../../src/vector.ts";
import { vshardOf } from "../../src/vshard.ts";

const USER_ID = "vector-delete-user";
const OWNER_SHARD = "ShardDO_vector_owner";
const OTHER_SHARD = "ShardDO_not_owner";
const VECTOR_BINDING = "CDB_DELETE_VECTORS";
const FILE_ID = "combined_delete_file";
const FILE_BODY = "combined file and vector deletion proof";
const FILE_SHA256 = "14be4b1897e1f20bdd321f439c5ae68a83b4881d9a23f4b234001e5349a9e539";
const SURVIVOR_KEY = "v1/safe-organization/survivor";

const auth = defineAuth({
    appName: "vector-organization-deletion-proof",
    baseURL: "https://vector-organization-deletion.invalid",
    plugins: [
        organization(),
        jwt({
            jwt: {
                issuer: "https://vector-organization-deletion.invalid",
                audience: "vector-organization-deletion-proof",
            },
            jwks: {
                remoteUrl: "https://vector-organization-deletion.invalid/jwks",
                keyPairConfig: { alg: "ES256" },
            },
        }),
    ],
});
const { cdbTable } = forOrg();
const documents = cdbTable(
    "vector_delete_documents",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        body: text("body").notNull(),
        attachment: file("attachment", { maxSize: 1_024, contentTypes: ["text/plain"] }),
        embedding: vector("embedding", { dim: 3, binding: VECTOR_BINDING, metric: "cosine" }),
    },
    { roles: { member: { create: "*", read: "*" } } }
);
const DOCUMENT_VECTOR_RESOURCE_ID = cdbVectorResourceId({
    kind: "vector",
    version: 1,
    table: "vector_delete_documents",
    column: "embedding",
    primaryKey: "id",
    organizationColumn: "organization_id",
    binding: VECTOR_BINDING,
    dimensions: 3,
    metric: "cosine",
});
const putDocument = api.mutation({
    ref: "test/workerd/vector-organization-deletion.entry.ts#putDocument",
    authority: "organization",
    partitionKey: "organizationId",
    args: z.object({
        organizationId: z.string(),
        id: z.string(),
        body: z.string(),
        fileId: z.string().optional(),
        values: z.array(z.number()).length(3),
    }),
    handler: (ctx, args) => {
        const embedding = stageCdbVector(ctx, {
            column: documents.embedding,
            rowPk: args.id,
            values: args.values,
            metadata: { body: args.body },
        });
        ctx.db
            .insert(documents)
            .values({
                id: args.id,
                organizationId: args.organizationId,
                body: args.body,
                attachment: args.fileId ? FileId(args.fileId) : null,
                embedding,
            })
            .run();
        return { id: args.id, vectorId: embedding.id };
    },
});

const schema = { documents };
const migrations = defineMigrations([
    defineSchemaBaseline({
        version: 1,
        name: "vector_organization_deletion",
        domainSchema: schema,
        authOptions: auth.options,
    }),
]);
const app = chardb({ auth, schema, api: { putDocument }, migrations });

interface Env extends CdbEnv {
    readonly CDB_ADMIN_TOKEN: string;
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_FILES: R2Bucket;
    readonly VECTOR_INDEX: DurableObjectNamespace;
}

interface CatalogRpc {
    fixtureConfigureOwner(input: { organizationId: string }): Promise<Record<string, unknown>>;
    fixtureActivate(): Promise<unknown>;
    fixtureRunRealAlarm(): Promise<void>;
    fixtureState(input: { organizationId: string }): Promise<Record<string, unknown>>;
    mutateAuth(input: Record<string, unknown>): Promise<unknown>;
    resolveOrganizationAuthorityRoute(input: {
        principalId: string;
        organizationId: string;
        vshard: number;
    }): Promise<Record<string, unknown>>;
    route(vshard: number): Promise<{ shardId: string; schemaEpoch: number; domainSchemaEpoch: number }>;
    fixtureBeginTopology(input: { organizationId: string; migrationId: string }): Promise<Record<string, unknown>>;
    fixtureBeginDeletionBarrier(input: {
        organizationId: string;
        migrationId: string;
    }): Promise<Record<string, unknown>>;
    fixtureCutover(input: { organizationId: string; migrationId: string }): Promise<Record<string, unknown>>;
    fixtureAbortTopology(input: { organizationId: string; migrationId: string }): Promise<Record<string, unknown>>;
    fixtureClearAlarm(): Promise<void>;
    fixtureMakeDeletionDue(input: { organizationId: string; shardId: string }): Promise<void>;
    organizationDeletionPurgeStatus(input: { organizationId: string }): Promise<Record<string, unknown>>;
}

interface CdbRpc {
    vectorOrganizationPurgeStatus(input: {
        organizationId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
    }): Promise<Record<string, unknown> | null>;
    mutate(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    fixturePrepareFile(input: {
        organizationId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
        auth: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
    fixtureDeletionRollback(input: {
        organizationId: string;
        domainSchemaEpoch: number;
    }): Promise<Record<string, unknown>>;
    fixtureResolveFile(input: {
        organizationId: string;
        rowId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
        auth: Record<string, unknown>;
    }): Promise<Record<string, unknown> | null>;
    fixtureForceDueAndSettled(): Promise<void>;
    fixtureRunRealAlarm(): Promise<void>;
    fixtureState(input: { organizationId: string }): Promise<Record<string, unknown>>;
    fixtureSeedVectorHeads(input: { organizationId: string; count: number }): Promise<Record<string, unknown>>;
    fixtureLoseNextDeletionResponse(): Promise<void>;
    fixturePoisonPurgeStatus(): Promise<void>;
    fixtureActivateRoutingFence(input: {
        organizationId: string;
        migrationId: string;
        sourceGeneration: number;
    }): Promise<unknown>;
}

interface VectorIndexProbeRpc {
    fixtureArmNextUpsert(): Promise<void>;
    fixtureReleaseHeldUpsert(input: { loseResponse: boolean }): Promise<void>;
    fixtureState(): Promise<Record<string, unknown>>;
}

function catalog(env: Env): CatalogRpc {
    return env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogRpc;
}

function cdb(env: Env, shardId: string): CdbRpc {
    return env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as CdbRpc;
}

function placement(organizationId: string): number {
    return Number(vshardOf([organizationId]));
}

export class VectorIndexProbe extends DurableObject<Record<string, never>> {
    private readonly fixtureInstanceId = crypto.randomUUID();
    private holdNextUpsert = false;
    private heldUpsert:
        | {
              readonly ids: readonly string[];
              readonly released: Promise<void>;
              release: () => void;
              loseResponse: boolean;
          }
        | undefined;

    constructor(state: DurableObjectState, env: Record<string, never>) {
        super(state, env);
        state.blockConcurrencyWhile(async () => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(`CREATE TABLE IF NOT EXISTS vector_delete_probe_calls (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'get')),
              ids_json TEXT NOT NULL
            )`);
            sql.exec(`CREATE TABLE IF NOT EXISTS vector_delete_probe_documents (
              id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL
            )`);
        });
    }

    async upsert(
        records: readonly CdbVectorizeRecord[]
    ): Promise<{ readonly ids: readonly string[]; readonly count: number }> {
        const ids = records.map(record => record.id);
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                "INSERT INTO vector_delete_probe_calls (operation, ids_json) VALUES ('upsert', ?)",
                JSON.stringify(ids)
            );
            for (const record of records) {
                sql.exec(
                    `INSERT INTO vector_delete_probe_documents (id, payload_json) VALUES (?, ?)
                     ON CONFLICT (id) DO UPDATE SET payload_json = excluded.payload_json`,
                    record.id,
                    JSON.stringify(record)
                );
            }
        });
        if (this.holdNextUpsert) {
            this.holdNextUpsert = false;
            let release = () => {};
            const released = new Promise<void>(resolve => {
                release = resolve;
            });
            const held = { ids, released, release, loseResponse: false };
            this.heldUpsert = held;
            await released;
            this.heldUpsert = undefined;
            if (held.loseResponse) throw new Error("fixture lost the held Vectorize upsert response");
        }
        return { ids, count: ids.length };
    }

    fixtureArmNextUpsert(): void {
        if (this.holdNextUpsert || this.heldUpsert) throw new Error("a Vectorize upsert hold is already armed");
        this.holdNextUpsert = true;
    }

    fixtureReleaseHeldUpsert(input: { loseResponse: boolean }): void {
        const held = this.heldUpsert;
        if (!held) throw new Error("no Vectorize upsert is held");
        held.loseResponse = input.loseResponse;
        held.release();
    }

    deleteByIds(ids: readonly string[]): { readonly ids: readonly string[]; readonly count: number } {
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            sql.exec(
                "INSERT INTO vector_delete_probe_calls (operation, ids_json) VALUES ('delete', ?)",
                JSON.stringify(ids)
            );
            for (const id of ids) sql.exec("DELETE FROM vector_delete_probe_documents WHERE id = ?", id);
        });
        return { ids: [...ids], count: ids.length };
    }

    getByIds(ids: readonly string[]): readonly CdbVectorizeRecord[] {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec("INSERT INTO vector_delete_probe_calls (operation, ids_json) VALUES ('get', ?)", JSON.stringify(ids));
        if (ids.length === 0) return [];
        return sql
            .all<{ payload_json: string }>(
                `SELECT payload_json FROM vector_delete_probe_documents
                 WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`,
                ...ids
            )
            .map(row => JSON.parse(row.payload_json) as CdbVectorizeRecord);
    }

    fixtureState(): Record<string, unknown> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            instanceId: this.fixtureInstanceId,
            calls: sql.all("SELECT sequence, operation, ids_json FROM vector_delete_probe_calls ORDER BY sequence"),
            documents: sql.all("SELECT id FROM vector_delete_probe_documents ORDER BY id"),
            hold: {
                armed: this.holdNextUpsert,
                activeIds: this.heldUpsert?.ids ?? [],
            },
        };
    }
}

export class Catalog extends app.Catalog {
    private readonly fixtureInstanceId = crypto.randomUUID();

    fixtureConfigureOwner(input: { organizationId: string }): Record<string, unknown> {
        const vshard = placement(input.organizationId);
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        this.ctx.storage.transactionSync(() => {
            sql.exec("DELETE FROM catalog_ranges");
            if (vshard > 0) {
                sql.exec("INSERT INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)", 0, vshard - 1, OTHER_SHARD);
            }
            sql.exec("INSERT INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)", vshard, vshard, OWNER_SHARD);
            if (vshard < 16_383) {
                sql.exec(
                    "INSERT INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)",
                    vshard + 1,
                    16_383,
                    OTHER_SHARD
                );
            }
        });
        return { vshard, ownerShardId: OWNER_SHARD, otherShardId: OTHER_SHARD };
    }

    async fixtureActivate(): Promise<unknown> {
        const migrationId = "vector-organization-deletion-v1";
        this.beginSchemaMigration({ migrationId, targetVersion: 1 });
        for (const shardId of await this.listShardIds()) await this.migrateSchemaShard({ migrationId, shardId });
        this.applyCatalogSchemaMigration({ migrationId, version: 1 });
        return this.completeSchemaMigration({ migrationId });
    }

    async fixtureBeginTopology(input: {
        organizationId: string;
        migrationId: string;
    }): Promise<Record<string, unknown>> {
        const vshard = placement(input.organizationId);
        const route = await this.route(vshard);
        const request = {
            migId: input.migrationId,
            sourceShard: route.shardId,
            destinationShard: OTHER_SHARD,
            rangeLo: vshard,
            rangeHi: vshard,
            startEpoch: route.schemaEpoch,
        };
        return { request, operation: this.beginTopologyOperation(request) };
    }

    async fixtureBeginDeletionBarrier(input: {
        organizationId: string;
        migrationId: string;
    }): Promise<Record<string, unknown>> {
        const vshard = placement(input.organizationId);
        const request = { migId: input.migrationId, rangeLo: vshard, rangeHi: vshard };
        await this.beginOrganizationDeletionBarrier(request);
        return { ...this.organizationDeletionBarrierStatus(request) };
    }

    async fixtureCutover(input: {
        organizationId: string;
        migrationId: string;
    }): Promise<Record<string, unknown>> {
        const vshard = placement(input.organizationId);
        const route = await this.route(vshard);
        const topology = {
            migId: input.migrationId,
            sourceShard: OWNER_SHARD,
            destinationShard: OTHER_SHARD,
            rangeLo: vshard,
            rangeHi: vshard,
            startEpoch: route.schemaEpoch,
        };
        const cutover = await this.cutover({
            migId: input.migrationId,
            lo: vshard,
            hi: vshard,
            fromShard: OWNER_SHARD,
            toShard: OTHER_SHARD,
            startEpoch: route.schemaEpoch,
        });
        const operation = this.completeTopologyOperation(topology);
        return { cutover, operation, route: await this.route(vshard) };
    }

    async fixtureAbortTopology(input: {
        organizationId: string;
        migrationId: string;
    }): Promise<Record<string, unknown>> {
        const vshard = placement(input.organizationId);
        const route = await this.route(vshard);
        return {
            ...this.abortTopologyOperation({
                migId: input.migrationId,
                sourceShard: OWNER_SHARD,
                destinationShard: OTHER_SHARD,
                rangeLo: vshard,
                rangeHi: vshard,
                startEpoch: route.schemaEpoch,
            }),
        };
    }

    async fixtureClearAlarm(): Promise<void> {
        await this.ctx.storage.deleteAlarm();
    }

    fixtureMakeDeletionDue(input: { organizationId: string; shardId: string }): void {
        adaptSqlStorage(this.ctx.storage.sql).exec(
            `UPDATE catalog_organization_deletion_shards
             SET next_attempt_at = 0
             WHERE organization_id = ? AND shard_id = ? AND status = 'pending'`,
            input.organizationId,
            input.shardId
        );
    }

    override async alarm(): Promise<void> {}

    async fixtureRunRealAlarm(): Promise<void> {
        await this.ctx.storage.deleteAlarm();
        await super.alarm();
    }

    async fixtureState(input: { organizationId: string }): Promise<Record<string, unknown>> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const deletions = new CatalogOrganizationDeletionStore(sql);
        return {
            instanceId: this.fixtureInstanceId,
            organizationPresent:
                sql.one<{ present: number }>(
                    "SELECT 1 AS present FROM organization WHERE id = ?",
                    input.organizationId
                ) !== null,
            memberPresent:
                sql.one<{ present: number }>(
                    'SELECT 1 AS present FROM member WHERE "organizationId" = ? AND "userId" = ?',
                    input.organizationId,
                    USER_ID
                ) !== null,
            deletion: deletions.read(input.organizationId),
            shards: deletions.shards(input.organizationId),
            route: await this.route(placement(input.organizationId)),
            alarm: await this.ctx.storage.getAlarm(),
        };
    }
}

export class Cdb extends app.Cdb {
    private readonly fixtureInstanceId = crypto.randomUUID();
    private readonly proofEnv: Env;
    private loseNextDeletionResponse = false;
    private poisonPurgeStatus = false;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        this.proofEnv = env;
    }

    protected override resolveVectorIndex(binding: string): CdbVectorizeMutationIndex {
        if (binding !== VECTOR_BINDING) throw new Error("unexpected vector deletion proof binding");
        return this.proofEnv.VECTOR_INDEX.get(
            this.proofEnv.VECTOR_INDEX.idFromName("vector-delete-index")
        ) as unknown as CdbVectorizeMutationIndex;
    }

    override async alarm(): Promise<void> {}

    async fixtureRunRealAlarm(): Promise<void> {
        await this.ctx.storage.deleteAlarm();
        await super.alarm();
    }

    fixtureSeedVectorHeads(input: { organizationId: string; count: number }): Record<string, unknown> {
        if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 1_001) {
            throw new Error("fixture vector count is invalid");
        }
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        this.ctx.storage.transactionSync(() => {
            const vectors = new CdbVectorOutboxStore(sql);
            for (let index = 0; index < input.count; index++) {
                const rowId = `barrier-row-${index.toString().padStart(4, "0")}`;
                vectors.stageUpsert({
                    vectorId: cdbVectorLogicalId(DOCUMENT_VECTOR_RESOURCE_ID, input.organizationId, rowId),
                    organizationId: input.organizationId,
                    resourceId: DOCUMENT_VECTOR_RESOURCE_ID,
                    rowPk: rowId,
                    dimensions: 3,
                    values: [index + 0.25, index + 0.5, index + 0.75],
                    metadata: { barrierSeed: index },
                    nowMs: index + 1,
                });
            }
        });
        return { organizationId: input.organizationId, count: input.count };
    }

    fixtureLoseNextDeletionResponse(): void {
        if (this.loseNextDeletionResponse) throw new Error("deletion response loss is already armed");
        this.loseNextDeletionResponse = true;
    }

    fixturePoisonPurgeStatus(): void {
        this.poisonPurgeStatus = true;
    }

    override vectorOrganizationPurgeStatus(
        input: Parameters<InstanceType<typeof app.Cdb>["vectorOrganizationPurgeStatus"]>[0]
    ): ReturnType<InstanceType<typeof app.Cdb>["vectorOrganizationPurgeStatus"]> {
        if (this.poisonPurgeStatus) throw new Error("fixture poisoned retired-owner purge status");
        return super.vectorOrganizationPurgeStatus(input);
    }

    async fixtureActivateRoutingFence(input: {
        organizationId: string;
        migrationId: string;
        sourceGeneration: number;
    }): Promise<unknown> {
        const vshard = placement(input.organizationId);
        const identity = {
            migrationId: input.migrationId,
            rangeLo: vshard,
            rangeHi: vshard,
            sourceGeneration: input.sourceGeneration,
            destinationGeneration: input.sourceGeneration + 1,
        };
        this.prepareRoutingFence(identity);
        return this.activateRoutingFence(identity);
    }

    override async deleteOrganizationFiles(
        args: Parameters<InstanceType<typeof app.Cdb>["deleteOrganizationFiles"]>[0]
    ): Promise<Awaited<ReturnType<InstanceType<typeof app.Cdb>["deleteOrganizationFiles"]>>> {
        const result = await super.deleteOrganizationFiles(args);
        if (this.loseNextDeletionResponse) {
            this.loseNextDeletionResponse = false;
            throw new Error("fixture lost the accepted organization deletion response");
        }
        return result;
    }

    async fixturePrepareFile(input: {
        organizationId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
        auth: Record<string, unknown>;
    }): Promise<Record<string, unknown>> {
        const authContext = mutationAuth(input.auth, input.organizationId);
        const reserved = await this.reserveFile({
            fileId: FILE_ID,
            organizationId: input.organizationId,
            table: "vector_delete_documents",
            column: "attachment",
            contentType: "text/plain",
            size: FILE_BODY.length,
            nowMs: Date.now(),
            domainSchemaEpoch: input.domainSchemaEpoch,
            schemaEpoch: input.schemaEpoch,
            auth: authContext,
        });
        if (!this.proofEnv.CDB_FILES) throw new Error("CDB_FILES binding is missing");
        await Promise.all([
            this.proofEnv.CDB_FILES.put(reserved.objectKey, FILE_BODY, {
                httpMetadata: { contentType: "text/plain" },
                customMetadata: { chardbFileId: FILE_ID, chardbSha256: FILE_SHA256 },
            }),
            this.proofEnv.CDB_FILES.put(SURVIVOR_KEY, "survivor", {
                httpMetadata: { contentType: "text/plain" },
            }),
        ]);
        const ready = this.markFileReady({
            fileId: FILE_ID,
            organizationId: input.organizationId,
            sha256: FILE_SHA256,
            size: FILE_BODY.length,
            nowMs: Date.now(),
            domainSchemaEpoch: input.domainSchemaEpoch,
            schemaEpoch: input.schemaEpoch,
            auth: authContext,
        });
        return { fileId: ready.fileId, objectKey: ready.objectKey, status: ready.status };
    }

    async fixtureDeletionRollback(input: {
        organizationId: string;
        domainSchemaEpoch: number;
    }): Promise<Record<string, unknown>> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec("UPDATE _chardb_vector_capacity SET outbox_rows = ?", CDB_VECTOR_MAX_OUTBOX_ROWS);
        let rejection: Record<string, unknown> | null = null;
        try {
            await this.deleteOrganizationFiles({
                organizationId: input.organizationId,
                nowMs: Date.now(),
                domainSchemaEpoch: input.domainSchemaEpoch,
            });
        } catch (error) {
            rejection = {
                message: error instanceof Error ? error.message : String(error),
                ...(isCdbError(error) ? { code: error.code } : {}),
            };
        } finally {
            sql.exec(
                `UPDATE _chardb_vector_capacity
                 SET outbox_rows = (SELECT COUNT(*) FROM _chardb_vector_outbox)
                 WHERE singleton = 1`
            );
        }
        if (!rejection) throw new Error("full vector outbox unexpectedly accepted organization deletion");
        return { rejection, state: await this.fixtureState(input) };
    }

    fixtureResolveFile(input: {
        organizationId: string;
        rowId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
        auth: Record<string, unknown>;
    }): Promise<Record<string, unknown> | null> {
        return this.resolveFileDownload({
            organizationId: input.organizationId,
            table: "vector_delete_documents",
            column: "attachment",
            rowId: input.rowId,
            schemaEpoch: input.schemaEpoch,
            domainSchemaEpoch: input.domainSchemaEpoch,
            auth: mutationAuth(input.auth, input.organizationId),
        }) as Promise<Record<string, unknown> | null>;
    }

    fixtureForceDueAndSettled(): void {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec("UPDATE _chardb_vector_outbox SET next_attempt_at = 0, leased_until = NULL, lease_token = NULL");
        sql.exec("UPDATE _chardb_vector_attempts SET settle_after = first_sent_at");
    }

    async fixtureState(input: { organizationId: string }): Promise<Record<string, unknown>> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            instanceId: this.fixtureInstanceId,
            rows: sql.all(
                `SELECT id, organization_id, body, attachment, embedding FROM vector_delete_documents
                 WHERE organization_id = ? ORDER BY id`,
                input.organizationId
            ),
            files: sql.all(
                `SELECT file_id, object_key, status, row_id FROM _chardb_files
                 WHERE organization_id = ? ORDER BY file_id`,
                input.organizationId
            ),
            heads: sql.all(
                `SELECT vector_id, version, delivered_version, state FROM _chardb_vectors
                 WHERE organization_id = ? ORDER BY vector_id`,
                input.organizationId
            ),
            outbox: sql.all(
                `SELECT outbox.vector_id, outbox.target_version, outbox.operation, outbox.phase, outbox.attempts,
                        outbox.leased_until, outbox.lease_token, outbox.terminal_failure, outbox.last_error
                 FROM _chardb_vector_outbox AS outbox
                 JOIN _chardb_vectors AS head ON head.vector_id = outbox.vector_id
                 WHERE head.organization_id = ? ORDER BY outbox.vector_id`,
                input.organizationId
            ),
            attempts: sql.all(
                `SELECT attempt.vector_id, attempt.physical_version, attempt.visibility_confirmed,
                        attempt.response_ambiguous, attempt.delete_confirmed
                 FROM _chardb_vector_attempts AS attempt
                 JOIN _chardb_vectors AS head ON head.vector_id = attempt.vector_id
                 WHERE head.organization_id = ? ORDER BY attempt.vector_id, attempt.physical_version`,
                input.organizationId
            ),
            tombstone: sql.one(
                `SELECT organization_id, deleted_at, placement_vshard FROM _chardb_deleted_organizations
                 WHERE organization_id = ?`,
                input.organizationId
            ),
            routingFences: sql.all(
                `SELECT migration_id, range_lo, range_hi, source_generation, destination_generation, status
                 FROM _chardb_routing_fences WHERE ? BETWEEN range_lo AND range_hi ORDER BY migration_id`,
                placement(input.organizationId)
            ),
            alarm: await this.ctx.storage.getAlarm(),
        };
    }
}

export const DB = app.DB;

function mutationAuth(authority: Record<string, unknown>, organizationId: string) {
    const epochs = authority.authEpochs as Record<string, number>;
    return {
        userId: USER_ID,
        tenantId: organizationId,
        role: String(authority.role),
        roles: authority.roles as string[],
        authEpochs: {
            global: Number(epochs.global),
            tenant: Number(epochs.tenant),
            principal: Number(epochs.principal),
        },
        claims: {},
    };
}

async function resolve(env: Env, organizationId: string): Promise<Record<string, unknown>> {
    return catalog(env).resolveOrganizationAuthorityRoute({
        principalId: PrincipalId(USER_ID),
        organizationId: TenantId(organizationId),
        vshard: placement(organizationId),
    });
}

async function setup(env: Env, organizationId: string): Promise<Record<string, unknown>> {
    const cat = catalog(env);
    const placementState = await cat.fixtureConfigureOwner({ organizationId });
    await cat.fixtureActivate();
    const now = Date.now();
    await cat.mutateAuth({
        model: "user",
        op: "create",
        payload: {
            id: USER_ID,
            name: "Vector Delete User",
            email: "vector-delete@example.com",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
        },
    });
    await cat.mutateAuth({
        model: "organization",
        op: "create",
        payload: { id: organizationId, name: organizationId, slug: organizationId, createdAt: now },
    });
    await cat.mutateAuth({
        model: "member",
        op: "create",
        payload: {
            id: "vector-delete-member",
            organizationId,
            userId: USER_ID,
            role: "member",
            createdAt: now,
        },
    });
    const resolved = await resolve(env, organizationId);
    const route = await cat.route(placement(organizationId));
    return {
        ...placementState,
        authority: resolved.authority,
        shardId: route.shardId,
        schemaEpoch: route.schemaEpoch,
        domainSchemaEpoch: route.domainSchemaEpoch,
        mutationRef: putDocument.__chardbRef,
    };
}

async function mutateVector(
    env: Env,
    input: { organizationId: string; mutId: string; id: string; body: string; fileId?: string; values: number[] }
): Promise<Record<string, unknown>> {
    const resolved = await resolve(env, input.organizationId);
    const authority = resolved.authority as Record<string, unknown> | null;
    const route = await catalog(env).route(placement(input.organizationId));
    if (!authority) throw new Error("organization authority is unavailable");
    return cdb(env, route.shardId).mutate({
        principalId: USER_ID,
        mutId: input.mutId,
        ref: putDocument.__chardbRef,
        args: {
            organizationId: input.organizationId,
            id: input.id,
            body: input.body,
            ...(input.fileId ? { fileId: input.fileId } : {}),
            values: input.values,
        },
        placement: { authority: "organization", partitionKey: input.organizationId },
        auth: mutationAuth(authority, input.organizationId),
        schemaEpoch: route.schemaEpoch,
        domainSchemaEpoch: route.domainSchemaEpoch,
    });
}

async function mutateVectorWithStaleAuthority(
    env: Env,
    input: {
        organizationId: string;
        mutId: string;
        id: string;
        body: string;
        fileId?: string;
        values: number[];
        authority: Record<string, unknown>;
    }
): Promise<Record<string, unknown>> {
    const route = await catalog(env).route(placement(input.organizationId));
    return cdb(env, route.shardId).mutate({
        principalId: USER_ID,
        mutId: input.mutId,
        ref: putDocument.__chardbRef,
        args: {
            organizationId: input.organizationId,
            id: input.id,
            body: input.body,
            ...(input.fileId ? { fileId: input.fileId } : {}),
            values: input.values,
        },
        placement: { authority: "organization", partitionKey: input.organizationId },
        auth: mutationAuth(input.authority, input.organizationId),
        schemaEpoch: route.schemaEpoch,
        domainSchemaEpoch: route.domainSchemaEpoch,
    });
}

function json(value: unknown, status = 200): Response {
    return Response.json(value, { status });
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/_chardb/organizations/deletion/")) {
            return app.fetch(request, env, ctx);
        }
        const operation = url.pathname.slice(1);
        const input = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
        try {
            if (operation === "setup") return json(await setup(env, String(input.organizationId)));
            if (operation === "prepare-file") {
                const organizationId = String(input.organizationId);
                const resolved = await resolve(env, organizationId);
                const authority = resolved.authority as Record<string, unknown> | null;
                const route = await catalog(env).route(placement(organizationId));
                if (!authority) throw new Error("organization authority is unavailable");
                return json(
                    await cdb(env, route.shardId).fixturePrepareFile({
                        organizationId,
                        schemaEpoch: route.schemaEpoch,
                        domainSchemaEpoch: route.domainSchemaEpoch,
                        auth: authority,
                    })
                );
            }
            if (operation === "mutate") return json(await mutateVector(env, input as never));
            if (operation === "mutate-stale") return json(await mutateVectorWithStaleAuthority(env, input as never));
            if (operation === "seed-vector-heads") {
                return json(
                    await cdb(env, String(input.shardId)).fixtureSeedVectorHeads({
                        organizationId: String(input.organizationId),
                        count: Number(input.count),
                    })
                );
            }
            if (operation === "lose-next-deletion-response") {
                await cdb(env, String(input.shardId)).fixtureLoseNextDeletionResponse();
                return json({ ok: true });
            }
            if (operation === "activate-routing-fence") {
                return json(
                    await cdb(env, String(input.shardId)).fixtureActivateRoutingFence({
                        organizationId: String(input.organizationId),
                        migrationId: String(input.migrationId),
                        sourceGeneration: Number(input.sourceGeneration),
                    })
                );
            }
            if (operation === "deletion-rollback") {
                const organizationId = String(input.organizationId);
                const route = await catalog(env).route(placement(organizationId));
                return json(
                    await cdb(env, route.shardId).fixtureDeletionRollback({
                        organizationId,
                        domainSchemaEpoch: route.domainSchemaEpoch,
                    })
                );
            }
            if (operation === "resolve-file") {
                const organizationId = String(input.organizationId);
                const route = await catalog(env).route(placement(organizationId));
                try {
                    return json(
                        await cdb(env, route.shardId).fixtureResolveFile({
                            organizationId,
                            rowId: String(input.rowId),
                            schemaEpoch: route.schemaEpoch,
                            domainSchemaEpoch: route.domainSchemaEpoch,
                            auth: input.authority as Record<string, unknown>,
                        })
                    );
                } catch (error) {
                    throw rehydrateCdbRpcError(error);
                }
            }
            if (operation === "delete-auth-organization") {
                await catalog(env).mutateAuth({
                    model: "member",
                    op: "delete",
                    where: { organizationId: String(input.organizationId) },
                });
                return json(
                    await catalog(env).mutateAuth({
                        model: "organization",
                        op: "delete",
                        where: { id: String(input.organizationId) },
                        limitOne: true,
                    })
                );
            }
            if (operation === "delete-auth-members") {
                return json(
                    await catalog(env).mutateAuth({
                        model: "member",
                        op: "delete",
                        where: { organizationId: String(input.organizationId) },
                    })
                );
            }
            if (operation === "delete-auth-organization-only") {
                return json(
                    await catalog(env).mutateAuth({
                        model: "organization",
                        op: "delete",
                        where: { id: String(input.organizationId) },
                        limitOne: true,
                    })
                );
            }
            if (operation === "begin-topology") {
                return json(
                    await catalog(env).fixtureBeginTopology({
                        organizationId: String(input.organizationId),
                        migrationId: String(input.migrationId),
                    })
                );
            }
            if (operation === "begin-deletion-barrier") {
                return json(
                    await catalog(env).fixtureBeginDeletionBarrier({
                        organizationId: String(input.organizationId),
                        migrationId: String(input.migrationId),
                    })
                );
            }
            if (operation === "cutover") {
                return json(
                    await catalog(env).fixtureCutover({
                        organizationId: String(input.organizationId),
                        migrationId: String(input.migrationId),
                    })
                );
            }
            if (operation === "abort-topology") {
                return json(
                    await catalog(env).fixtureAbortTopology({
                        organizationId: String(input.organizationId),
                        migrationId: String(input.migrationId),
                    })
                );
            }
            if (operation === "catalog-clear-alarm") {
                await catalog(env).fixtureClearAlarm();
                return json({ ok: true });
            }
            if (operation === "make-deletion-due") {
                await catalog(env).fixtureMakeDeletionDue({
                    organizationId: String(input.organizationId),
                    shardId: String(input.shardId),
                });
                return json({ ok: true });
            }
            if (operation === "resolve") return json(await resolve(env, String(input.organizationId)));
            if (operation === "catalog-alarm") {
                await catalog(env).fixtureRunRealAlarm();
                return json({ ok: true });
            }
            if (operation === "cdb-alarm") {
                const shard = cdb(env, String(input.shardId));
                await shard.fixtureForceDueAndSettled();
                await shard.fixtureRunRealAlarm();
                return json({ ok: true });
            }
            if (operation === "catalog-state") {
                return json(await catalog(env).fixtureState({ organizationId: String(input.organizationId) }));
            }
            if (operation === "catalog-deletion-status") {
                return json(
                    await catalog(env).organizationDeletionPurgeStatus({
                        organizationId: String(input.organizationId),
                    })
                );
            }
            if (operation === "poison-cdb-purge-status") {
                await cdb(env, String(input.shardId)).fixturePoisonPurgeStatus();
                return json({ ok: true });
            }
            if (operation === "cdb-state") {
                return json(
                    await cdb(env, String(input.shardId)).fixtureState({ organizationId: String(input.organizationId) })
                );
            }
            if (operation === "cdb-vector-purge-status") {
                const route = await catalog(env).route(placement(String(input.organizationId)));
                return json(
                    await cdb(env, String(input.shardId)).vectorOrganizationPurgeStatus({
                        organizationId: String(input.organizationId),
                        schemaEpoch: route.schemaEpoch,
                        domainSchemaEpoch: route.domainSchemaEpoch,
                    })
                );
            }
            const index = env.VECTOR_INDEX.get(
                env.VECTOR_INDEX.idFromName("vector-delete-index")
            ) as unknown as VectorIndexProbeRpc;
            if (operation === "vector-arm-upsert-hold") {
                await index.fixtureArmNextUpsert();
                return json({ ok: true });
            }
            if (operation === "vector-release-upsert-hold") {
                await index.fixtureReleaseHeldUpsert({ loseResponse: input.loseResponse === true });
                return json({ ok: true });
            }
            if (operation === "vector-state") return json(await index.fixtureState());
            if (operation === "bucket-state") {
                const listed = await env.CDB_FILES.list({ prefix: "v1/", limit: 1_000 });
                return json({ keys: listed.objects.map(object => object.key).sort() });
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
