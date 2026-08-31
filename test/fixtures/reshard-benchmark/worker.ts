import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { and, eq } from "drizzle-orm";
import { text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { TableSpec } from "../../../src/reshard/triggers.ts";
import { forOrg } from "../../../src/server/cdb-tenant.ts";
import { api } from "../../../src/server/define.ts";
import type { CatalogAuthMutationRequest } from "../../../src/server/do/catalog-authority-store.ts";
import type { OrganizationAuthorityRouteResult, RouteResult } from "../../../src/server/do/catalog.ts";
import type { CdbRoutingFenceIdentity } from "../../../src/server/do/cdb-routing-fence-store.ts";
import { dispatchTrustedMutation } from "../../../src/server/do/gateway-auth-dispatch.ts";
import { Resharder as ProductionResharder, RESHARDER_PHASE } from "../../../src/server/do/resharder.ts";
import { adaptSqlStorage } from "../../../src/server/do/sql_adapter.ts";
import { gatewayBucketName } from "../../../src/server/gateway-bucket.ts";
import { chardb, defineAuth, defineMigrations, defineSchemaBaseline } from "../../../src/server/index.ts";
import { manifestFromExports, routeMutation } from "../../../src/server/manifest.ts";
import type { CdbMutationRequest, CdbMutationResponse } from "../../../src/server/rpc.ts";
import { PrincipalId, type RawJson, ShardId, TenantId } from "../../../src/types.ts";
import { stableJson } from "../../../src/util/canonical.ts";
import { vshardOf } from "../../../src/vshard.ts";

const ISSUER = "https://reshard-benchmark.invalid";
const AUDIENCE = "chardb-reshard-benchmark";
const JWKS_URL = "https://reshard-benchmark.invalid/jwks";
const ORGANIZATION_ID = TenantId("benchmark-organization-0001");
const USER_ID = PrincipalId("benchmark-user-0001");
const MEMBER_ID = "benchmark-member-0001";
const SOURCE_SHARD = ShardId("ShardDO_0");
const DESTINATION_SHARD = ShardId("ShardDO_1");
const MIGRATION_ID = "benchmark_range_move_v1";
const MUTATION_REF = "test/fixtures/reshard-benchmark/worker.ts#touchParent";
const QUERY_REF = "test/fixtures/reshard-benchmark/worker.ts#benchmarkParent";
const PARENT_ROWS = 1_024;
const CHILD_ROWS = 4_096;
const CAPTURE_TRANSACTIONS = 256;
const RESTART_AFTER_APPLIES = 3;
let workerInstanceId = "";

const auth = defineAuth({
    appName: "chardb-reshard-benchmark",
    baseURL: ISSUER,
    plugins: [
        organization(),
        jwt({
            jwt: { issuer: ISSUER, audience: AUDIENCE },
            jwks: { remoteUrl: JWKS_URL, keyPairConfig: { alg: "ES256" } },
        }),
    ],
});

const { cdbTable } = forOrg();
const benchmarkParents = cdbTable(
    "benchmark_parents",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        label: text("label").notNull(),
    },
    { roles: { member: { read: "*", update: ["label"] } } }
);
const benchmarkChildren = cdbTable(
    "benchmark_children",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        parentId: text("parent_id")
            .notNull()
            .references(() => benchmarkParents.id),
        body: text("body").notNull(),
    },
    { roles: { member: { read: "*", update: ["body"] } } }
);

const touchParent = api.mutation({
    ref: MUTATION_REF,
    authority: "organization",
    partitionKey: "organizationId",
    args: z.object({ organizationId: z.string(), id: z.string(), label: z.string() }),
    handler: (ctx, args) => {
        ctx.db.update(benchmarkParents).set({ label: args.label }).where(eq(benchmarkParents.id, args.id)).run();
        return { id: args.id, label: args.label };
    },
});

const touchChild = api.mutation({
    ref: "test/fixtures/reshard-benchmark/worker.ts#touchChild",
    authority: "organization",
    partitionKey: "organizationId",
    args: z.object({ organizationId: z.string(), id: z.string(), body: z.string() }),
    handler: (ctx, args) => {
        ctx.db.update(benchmarkChildren).set({ body: args.body }).where(eq(benchmarkChildren.id, args.id)).run();
        return { id: args.id };
    },
});

const benchmarkParent = api.query({
    ref: QUERY_REF,
    authority: "organization",
    partitionKey: "organizationId",
    args: z.object({ organizationId: z.string(), id: z.string() }),
    intent: args => ({
        kind: "select",
        tables: ["benchmark_parents"],
        partitionKey: {
            table: "benchmark_parents",
            column: "organization_id",
            values: [args.organizationId],
        },
        joinShape: "colocated",
        intervals: [{ table: "benchmark_parents", indexName: "organization_id", intervals: [{ kind: "full" }] }],
    }),
    handler: async (ctx, args) =>
        ctx.db
            .select()
            .from(benchmarkParents)
            .where(and(eq(benchmarkParents.organizationId, args.organizationId), eq(benchmarkParents.id, args.id)))
            .limit(1)
            .all(),
});

const BENCHMARK_MANIFEST = manifestFromExports({ touchParent, touchChild, benchmarkParent });

const migrations = defineMigrations([
    defineSchemaBaseline({
        version: 1,
        name: "benchmark_parent_child",
        domainSchema: { benchmarkParents, benchmarkChildren },
        authOptions: auth.options,
    }),
]);

const app = chardb({
    auth,
    schema: { benchmarkParents, benchmarkChildren },
    api: { touchParent, touchChild, benchmarkParent },
    migrations,
});

const TABLES = Object.freeze([
    {
        name: "benchmark_parents",
        partitionColumn: "organization_id",
        columns: ["id", "organization_id", "label"],
    },
    {
        name: "benchmark_children",
        partitionColumn: "organization_id",
        columns: ["id", "organization_id", "parent_id", "body"],
    },
]) satisfies readonly TableSpec[];

interface BenchmarkEnv {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_RESHARD: DurableObjectNamespace;
    readonly BETTER_AUTH_SECRET?: string;
    readonly CDB_ADMIN_TOKEN?: string;
    readonly CDB_PROOF_RUN_ID?: string;
    readonly CDB_RELEASE_SHA256?: string;
}

interface CatalogRpc {
    schemaState(): Promise<{
        activeVersion: number;
        activeEpoch: number;
        activeDigest: string;
        status: "active" | "migrating";
    }>;
    beginSchemaMigration(args: { migrationId: string; targetVersion: number }): Promise<unknown>;
    migrateSchemaShard(args: { migrationId: string; shardId: string }): Promise<unknown>;
    applyCatalogSchemaMigration(args: { migrationId: string; version: number }): Promise<unknown>;
    completeSchemaMigration(args: { migrationId: string }): Promise<unknown>;
    recordBenchmarkBulkApply(): Promise<void>;
    benchmarkBulkApplies(): Promise<number>;
    mutateAuth(args: CatalogAuthMutationRequest): Promise<unknown>;
    route(vshard: number): Promise<RouteResult>;
    resolveOrganizationAuthorityRoute(args: {
        principalId: PrincipalId;
        organizationId: TenantId;
        vshard: number;
    }): Promise<OrganizationAuthorityRouteResult>;
    seedJwkForBenchmark(kid: string, jwkJson: string): Promise<void>;
    allowBenchmarkCutover(): Promise<void>;
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
    benchmarkState(migId: string): Promise<{
        phase: number | null;
        bulkCursor: Record<string, number> | null;
        tailCursor: number | null;
        workTurn: number | null;
        bulkTableIndex: number | null;
    }>;
}

interface BenchmarkCdbRpc {
    schemaState(): Promise<{ activeVersion: number; activeEpoch: number; activeDigest: string }>;
    benchmarkSeed(): Promise<{ parents: number; children: number }>;
    benchmarkAllowBulkResume(): Promise<void>;
    benchmarkAllowDrain(): Promise<void>;
    benchmarkCapture(route: RouteResult): Promise<{ transactions: number; entries: number; bytes: number }>;
    benchmarkMetrics(): Promise<Record<string, number>>;
    benchmarkDigest(): Promise<{ digest: string; rows: number; orderedSentinelBody: string | null }>;
    benchmarkMutationCount(mutId: string): Promise<number>;
    mutate(request: CdbMutationRequest): Promise<CdbMutationResponse>;
}

function drain(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): void {
    for (const _ of cursor.raw()) {
        // Drain the native cursor.
    }
}

function textBytes(value: unknown): number {
    return new TextEncoder().encode(stableJson(value)).byteLength;
}

function tailAccountedBytes(
    migId: string,
    transactions: Parameters<InstanceType<typeof app.Cdb>["applyTailBatch"]>[0]["transactions"]
): number {
    const encoder = new TextEncoder();
    const bytes = (value: string): number => encoder.encode(value).byteLength;
    return transactions.reduce(
        (total, transaction) =>
            total +
            transaction.entries.reduce(
                (sum, entry) =>
                    sum +
                    32 +
                    bytes(migId) +
                    bytes(entry.op) +
                    bytes(entry.table_name) +
                    bytes(JSON.stringify(entry.pk)) +
                    bytes(entry.before ?? "") +
                    bytes(entry.after ?? ""),
                0
            ),
        0
    );
}

interface BenchmarkDoAccess {
    readonly ctx: { readonly storage: DurableObjectStorage };
}

function benchmarkSql(instance: BenchmarkDoAccess) {
    return adaptSqlStorage(instance.ctx.storage.sql);
}

function initializeBenchmarkMetrics(instance: BenchmarkDoAccess): void {
    const sql = benchmarkSql(instance);
    sql.exec(
        `CREATE TABLE IF NOT EXISTS _benchmark_metrics (
           key TEXT PRIMARY KEY,
           value INTEGER NOT NULL CHECK (value >= 0)
         )`
    );
}

function metric(instance: BenchmarkDoAccess, key: string, delta: number): void {
    if (!Number.isSafeInteger(delta) || delta < 0) throw new Error(`invalid benchmark metric ${key}`);
    initializeBenchmarkMetrics(instance);
    benchmarkSql(instance).exec(
        `INSERT INTO _benchmark_metrics (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
        key,
        delta
    );
}

function control(instance: BenchmarkDoAccess, key: string): number {
    initializeBenchmarkMetrics(instance);
    return (
        benchmarkSql(instance).one<{ value: number }>("SELECT value FROM _benchmark_metrics WHERE key = ?", key)
            ?.value ?? 0
    );
}

function setControl(instance: BenchmarkDoAccess, key: string, value: number): void {
    initializeBenchmarkMetrics(instance);
    benchmarkSql(instance).exec(
        `INSERT INTO _benchmark_metrics (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value
    );
}

export class Catalog extends app.Catalog {
    recordBenchmarkBulkApply(): void {
        metric(this as unknown as BenchmarkDoAccess, "bulk_apply_batches", 1);
    }

    benchmarkBulkApplies(): number {
        return control(this as unknown as BenchmarkDoAccess, "bulk_apply_batches");
    }

    seedJwkForBenchmark(kid: string, jwkJson: string): void {
        const now = Date.now();
        drain(
            this.ctx.storage.sql.exec(
                `INSERT INTO catalog_jwks_v2 (jwks_url, kid, jwk_json, fetched_at, expires_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(jwks_url, kid) DO UPDATE SET jwk_json = excluded.jwk_json,
                   fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
                JWKS_URL,
                kid,
                jwkJson,
                now,
                now + 3_600_000
            )
        );
    }

    allowBenchmarkCutover(): void {
        setControl(this as unknown as BenchmarkDoAccess, "allow_cutover", 1);
    }

    override async cutover(args: {
        migId: string;
        lo: number;
        hi: number;
        fromShard: string;
        toShard: string;
        startEpoch?: number;
    }): Promise<{ applied: boolean; newEpoch: number }> {
        if (args.migId === MIGRATION_ID && control(this as unknown as BenchmarkDoAccess, "allow_cutover") !== 1) {
            throw new Error("benchmark cutover checkpoint");
        }
        return super.cutover(args);
    }
}

export class Cdb extends app.Cdb {
    benchmarkSeed(): { parents: number; children: number } {
        initializeBenchmarkMetrics(this as unknown as BenchmarkDoAccess);
        this.ctx.storage.transactionSync(() => {
            const sql = adaptSqlStorage(this.ctx.storage.sql);
            for (let index = 0; index < PARENT_ROWS; index++) {
                sql.exec(
                    "INSERT INTO benchmark_parents (id, organization_id, label) VALUES (?, ?, ?)",
                    `parent-${String(index).padStart(4, "0")}`,
                    ORGANIZATION_ID,
                    `parent label ${index}`
                );
            }
            for (let index = 0; index < CHILD_ROWS; index++) {
                sql.exec(
                    `INSERT INTO benchmark_children (id, organization_id, parent_id, body)
                     VALUES (?, ?, ?, ?)`,
                    `child-${String(index).padStart(4, "0")}`,
                    ORGANIZATION_ID,
                    `parent-${String(index % PARENT_ROWS).padStart(4, "0")}`,
                    `child body ${index}`
                );
            }
        });
        return { parents: PARENT_ROWS, children: CHILD_ROWS };
    }

    benchmarkAllowBulkResume(): void {
        setControl(this as unknown as BenchmarkDoAccess, "allow_bulk_resume", 1);
    }

    benchmarkAllowDrain(): void {
        setControl(this as unknown as BenchmarkDoAccess, "allow_drain", 1);
    }

    async benchmarkCapture(route: RouteResult): Promise<{ transactions: number; entries: number; bytes: number }> {
        for (let index = 0; index < CAPTURE_TRANSACTIONS; index++) {
            const id = "child-0000";
            const result = await this.mutate({
                principalId: USER_ID,
                mutId: `capture-${String(index).padStart(4, "0")}`,
                ref: touchChild.__chardbRef,
                args: { organizationId: ORGANIZATION_ID, id, body: `captured body ${index}` },
                placement: { authority: "organization", partitionKey: ORGANIZATION_ID },
                auth: {
                    userId: USER_ID,
                    tenantId: ORGANIZATION_ID,
                    role: "member",
                    roles: ["member"],
                    authEpochs: { global: 1, tenant: 1, principal: 1 },
                    claims: {},
                },
                schemaEpoch: route.schemaEpoch,
                domainSchemaEpoch: route.domainSchemaEpoch,
            });
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        }
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const state = sql.one<{ rows: number; bytes: number }>(
            `SELECT split_log_rows AS rows, split_log_bytes AS bytes
             FROM _chardb_split_state WHERE mig_id = ? AND role = 'source'`,
            MIGRATION_ID
        );
        const groups = sql.one<{ groups: number }>(
            "SELECT COUNT(DISTINCT source_tx_id) AS groups FROM _chardb_split_log WHERE mig_id = ?",
            MIGRATION_ID
        );
        return { transactions: groups?.groups ?? 0, entries: state?.rows ?? 0, bytes: state?.bytes ?? 0 };
    }

    benchmarkMetrics(): Record<string, number> {
        initializeBenchmarkMetrics(this as unknown as BenchmarkDoAccess);
        return Object.fromEntries(
            benchmarkSql(this as unknown as BenchmarkDoAccess)
                .all<{ key: string; value: number }>("SELECT key, value FROM _benchmark_metrics ORDER BY key")
                .map(row => [row.key, row.value])
        );
    }

    async benchmarkDigest(): Promise<{ digest: string; rows: number; orderedSentinelBody: string | null }> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const parents = sql.all<Record<string, RawJson>>(
            "SELECT id, organization_id, label FROM benchmark_parents WHERE organization_id = ? ORDER BY id",
            ORGANIZATION_ID
        );
        const children = sql.all<Record<string, RawJson>>(
            `SELECT id, organization_id, parent_id, body FROM benchmark_children
             WHERE organization_id = ? ORDER BY id`,
            ORGANIZATION_ID
        );
        const canonical = stableJson([
            ["benchmark_parents", parents],
            ["benchmark_children", children],
        ]);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
        return {
            digest: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
            rows: parents.length + children.length,
            orderedSentinelBody: children.find(row => row.id === "child-0000")?.body?.toString() ?? null,
        };
    }

    benchmarkMutationCount(mutId: string): number {
        return (
            adaptSqlStorage(this.ctx.storage.sql).one<{ count: number }>(
                "SELECT COUNT(*) AS count FROM _chardb_op_log WHERE mut_id = ?",
                mutId
            )?.count ?? 0
        );
    }

    override async bulkCopyBatch(args: {
        migId: string;
        table: TableSpec;
        range: { lo: number; hi: number };
        afterRowid: number;
        limit: number;
    }) {
        const started = performance.now();
        const result = await super.bulkCopyBatch(args);
        metric(this as unknown as BenchmarkDoAccess, "bulk_read_batches", 1);
        metric(this as unknown as BenchmarkDoAccess, "bulk_rows", result.rows.length);
        metric(this as unknown as BenchmarkDoAccess, "bulk_bytes", textBytes(result.rows));
        metric(
            this as unknown as BenchmarkDoAccess,
            "bulk_micros",
            Math.max(1, Math.round((performance.now() - started) * 1_000))
        );
        return result;
    }

    override async applyBulkBatch(args: {
        migId: string;
        table: TableSpec;
        range: { lo: number; hi: number };
        rows: readonly Record<string, RawJson>[];
    }) {
        const self = this as unknown as BenchmarkDoAccess;
        if (
            args.migId === MIGRATION_ID &&
            control(self, "bulk_apply_batches") >= RESTART_AFTER_APPLIES &&
            control(self, "allow_bulk_resume") !== 1
        ) {
            // Keep the fourth destination RPC open so the harness can terminate
            // Wrangler after exactly three committed batches. Throwing would let
            // Workerd roll the caller's Resharder event back to its input gate,
            // erasing the cursor whose crash durability this fixture measures.
            await new Promise<never>(() => {});
        }
        const started = performance.now();
        const result = await super.applyBulkBatch(args);
        metric(self, "bulk_apply_batches", 1);
        metric(self, "bulk_apply_micros", Math.max(1, Math.round((performance.now() - started) * 1_000)));
        const env = this.env as unknown as BenchmarkEnv;
        await catalog(env).recordBenchmarkBulkApply();
        return result;
    }

    override async readTailBatch(args: { migId: string; afterLsn: number; limit: number }) {
        const started = performance.now();
        const result = await super.readTailBatch(args);
        metric(this as unknown as BenchmarkDoAccess, "tail_read_batches", 1);
        metric(
            this as unknown as BenchmarkDoAccess,
            "tail_micros",
            Math.max(1, Math.round((performance.now() - started) * 1_000))
        );
        return result;
    }

    override async applyTailBatch(args: Parameters<InstanceType<typeof app.Cdb>["applyTailBatch"]>[0]) {
        const started = performance.now();
        const result = await super.applyTailBatch(args);
        metric(this as unknown as BenchmarkDoAccess, "tail_apply_batches", args.transactions.length > 0 ? 1 : 0);
        metric(this as unknown as BenchmarkDoAccess, "tail_groups", args.transactions.length);
        metric(
            this as unknown as BenchmarkDoAccess,
            "tail_entries",
            args.transactions.reduce((sum, transaction) => sum + transaction.entries.length, 0)
        );
        metric(this as unknown as BenchmarkDoAccess, "tail_bytes", tailAccountedBytes(args.migId, args.transactions));
        metric(
            this as unknown as BenchmarkDoAccess,
            "tail_apply_micros",
            Math.max(1, Math.round((performance.now() - started) * 1_000))
        );
        return result;
    }

    override async readSplitOpLogBatch(args: { migId: string; afterLsn: number; limit: number }) {
        const started = performance.now();
        const result = await super.readSplitOpLogBatch(args);
        metric(this as unknown as BenchmarkDoAccess, "oplog_read_batches", 1);
        metric(
            this as unknown as BenchmarkDoAccess,
            "oplog_micros",
            Math.max(1, Math.round((performance.now() - started) * 1_000))
        );
        return result;
    }

    override async applySplitOpLogBatch(args: Parameters<InstanceType<typeof app.Cdb>["applySplitOpLogBatch"]>[0]) {
        const started = performance.now();
        const result = await super.applySplitOpLogBatch(args);
        metric(this as unknown as BenchmarkDoAccess, "oplog_apply_batches", args.entries.length > 0 ? 1 : 0);
        metric(
            this as unknown as BenchmarkDoAccess,
            "oplog_apply_micros",
            Math.max(1, Math.round((performance.now() - started) * 1_000))
        );
        return result;
    }

    override prepareRoutingFence(args: CdbRoutingFenceIdentity) {
        const started = performance.now();
        const result = super.prepareRoutingFence(args);
        metric(
            this as unknown as BenchmarkDoAccess,
            "fence_micros",
            Math.max(1, Math.round((performance.now() - started) * 1_000))
        );
        return result;
    }

    override async activateRoutingFence(args: CdbRoutingFenceIdentity) {
        const started = performance.now();
        const result = await super.activateRoutingFence(args);
        metric(
            this as unknown as BenchmarkDoAccess,
            "fence_micros",
            Math.max(1, Math.round((performance.now() - started) * 1_000))
        );
        return result;
    }

    override async stopReshardCapture(args: Parameters<InstanceType<typeof app.Cdb>["stopReshardCapture"]>[0]) {
        if (args.migId === MIGRATION_ID && control(this as unknown as BenchmarkDoAccess, "allow_drain") !== 1) {
            throw new Error("benchmark source digest checkpoint");
        }
        return super.stopReshardCapture(args);
    }

    override async dropMigratedRange(args: Parameters<InstanceType<typeof app.Cdb>["dropMigratedRange"]>[0]) {
        const started = performance.now();
        const result = await super.dropMigratedRange({ ...args, batchSize: Math.min(args.batchSize, 128) });
        metric(this as unknown as BenchmarkDoAccess, "drain_batches", 1);
        metric(this as unknown as BenchmarkDoAccess, "drain_rows", result.deleted);
        metric(
            this as unknown as BenchmarkDoAccess,
            "drain_micros",
            Math.max(1, Math.round((performance.now() - started) * 1_000))
        );
        return result;
    }
}

export class Resharder extends ProductionResharder {
    benchmarkState(migId: string): {
        phase: number | null;
        bulkCursor: Record<string, number> | null;
        tailCursor: number | null;
        workTurn: number | null;
        bulkTableIndex: number | null;
    } {
        const row = adaptSqlStorage(this.ctx.storage.sql).one<{
            phase: number;
            bulk_cursor: string;
            tail_cursor: number;
            turn: number;
            bulk_table_index: number;
        }>(
            `SELECT state.phase, state.bulk_cursor, state.tail_cursor, work.turn, work.bulk_table_index
             FROM migration_state AS state
             LEFT JOIN migration_work_cursor AS work ON work.mig_id = state.mig_id
             WHERE state.mig_id = ?`,
            migId
        );
        return {
            phase: row?.phase ?? null,
            bulkCursor: row ? JSON.parse(row.bulk_cursor) : null,
            tailCursor: row?.tail_cursor ?? null,
            workTurn: row?.turn ?? null,
            bulkTableIndex: row?.bulk_table_index ?? null,
        };
    }
}

export class Gateway extends app.Gateway {
    async benchmarkStaleRetry(args: { clientId: string; mutId: string }): Promise<{
        attempts: number;
        cutoverMs: number;
        result: CdbMutationResponse;
    }> {
        const env = this.env as unknown as BenchmarkEnv;
        const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogRpc;
        const vshard = Number(vshardOf([ORGANIZATION_ID]));
        const first = await catalog.resolveOrganizationAuthorityRoute({
            principalId: USER_ID,
            organizationId: ORGANIZATION_ID,
            vshard,
        });
        if (!first.authority || !first.route || first.route.shardId !== SOURCE_SHARD) {
            throw new Error("benchmark stale retry did not begin on the source route");
        }
        let catalogAttempts = 0;
        let mutationAttempts = 0;
        let cutoverMs = 0;
        const result = await dispatchTrustedMutation(
            {
                routeMutation: input => routeMutation(BENCHMARK_MANIFEST, input, vshardOf),
                catalog: {
                    resolveOrganizationAuthority: input =>
                        catalog.resolveOrganizationAuthorityRoute({ ...input, vshard }).then(value => value.authority),
                    route: input => catalog.route(input),
                    async resolveOrganizationAuthorityRoute(input) {
                        catalogAttempts++;
                        if (catalogAttempts === 1) return first;
                        return catalog.resolveOrganizationAuthorityRoute(input);
                    },
                },
                cdb: shardId => ({
                    mutate: async request => {
                        mutationAttempts++;
                        if (mutationAttempts === 1) {
                            const started = performance.now();
                            const resharder = env.CDB_RESHARD.get(
                                env.CDB_RESHARD.idFromName("global")
                            ) as unknown as ResharderRpc;
                            let previousState = "";
                            let unchangedTurns = 0;
                            let reachedCutover = false;
                            for (let turn = 0; turn < 1_024; turn++) {
                                try {
                                    await resharder.runSplit(MIGRATION_ID);
                                } catch (error) {
                                    if ((await resharder.getPhase(MIGRATION_ID)) !== RESHARDER_PHASE.DUAL_WRITE_OPEN) {
                                        throw error;
                                    }
                                }
                                const state = await resharder.benchmarkState(MIGRATION_ID);
                                if (state.phase === RESHARDER_PHASE.DUAL_WRITE_OPEN) {
                                    reachedCutover = true;
                                    break;
                                }
                                if (state.phase !== RESHARDER_PHASE.TAIL_CAUGHT_UP) {
                                    throw new Error(`benchmark cutover left phase ${String(state.phase)}`);
                                }
                                const signature = stableJson(state as unknown as RawJson);
                                unchangedTurns = signature === previousState ? unchangedTurns + 1 : 0;
                                if (unchangedTurns >= 32) throw new Error("benchmark cutover made no durable progress");
                                previousState = signature;
                            }
                            if (!reachedCutover) throw new Error("benchmark cutover exceeded its bounded turn budget");
                            cutoverMs = performance.now() - started;
                        }
                        const cdb = env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as BenchmarkCdbRpc;
                        return cdb.mutate(request);
                    },
                }),
            },
            {
                principalId: USER_ID,
                mutId: args.mutId,
                ref: MUTATION_REF,
                args: {
                    organizationId: ORGANIZATION_ID,
                    id: "parent-0000",
                    label: "parent label 0",
                },
            }
        );
        return { attempts: mutationAttempts, cutoverMs, result };
    }
}

export const DB = app.DB;

function catalog(env: BenchmarkEnv): CatalogRpc {
    return env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogRpc;
}

function cdb(env: BenchmarkEnv, shardId: string): BenchmarkCdbRpc {
    return env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as BenchmarkCdbRpc;
}

function resharder(env: BenchmarkEnv): ResharderRpc {
    return env.CDB_RESHARD.get(env.CDB_RESHARD.idFromName("global")) as unknown as ResharderRpc;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
    return value as Record<string, unknown>;
}

async function prepareBenchmark(env: BenchmarkEnv, request: Request): Promise<unknown> {
    const body = await jsonBody(request);
    if (typeof body.kid !== "string" || !body.jwk || typeof body.jwk !== "object") {
        throw new Error("benchmark prepare requires kid and jwk");
    }
    const cat = catalog(env);
    const before = await cdb(env, DESTINATION_SHARD).schemaState();
    const state = await cat.schemaState();
    if (state.activeVersion === 0) {
        const migrationId = "benchmark_initial_schema_v1";
        await cat.beginSchemaMigration({ migrationId, targetVersion: 1 });
        await cat.migrateSchemaShard({ migrationId, shardId: SOURCE_SHARD });
        await cat.applyCatalogSchemaMigration({ migrationId, version: 1 });
        await cat.completeSchemaMigration({ migrationId });
    }
    await cat.seedJwkForBenchmark(body.kid, JSON.stringify(body.jwk));
    const now = Date.parse("2026-08-28T00:00:00.000Z");
    for (const mutation of [
        {
            model: "user",
            op: "create",
            payload: {
                id: USER_ID,
                name: "Reshard Benchmark User",
                email: "reshard-benchmark@example.invalid",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
            },
        },
        {
            model: "organization",
            op: "create",
            payload: {
                id: ORGANIZATION_ID,
                name: "Reshard Benchmark Organization",
                slug: "reshard-benchmark-organization",
                createdAt: now,
            },
        },
        {
            model: "member",
            op: "create",
            payload: {
                id: MEMBER_ID,
                organizationId: ORGANIZATION_ID,
                userId: USER_ID,
                role: "member",
                createdAt: now,
            },
        },
    ] as const) {
        await cat.mutateAuth(mutation);
    }
    const seeded = await cdb(env, SOURCE_SHARD).benchmarkSeed();
    const route = await cat.route(Number(vshardOf([ORGANIZATION_ID])));
    if (route.shardId !== SOURCE_SHARD) throw new Error("benchmark source route drifted");
    await resharder(env).startSplit({
        migId: MIGRATION_ID,
        srcShard: SOURCE_SHARD,
        dstShard: DESTINATION_SHARD,
        rangeLo: Number(vshardOf([ORGANIZATION_ID])),
        rangeHi: Number(vshardOf([ORGANIZATION_ID])),
        epochAtStart: route.schemaEpoch,
        tables: TABLES,
    });
    return { organizationId: ORGANIZATION_ID, userId: USER_ID, route, seeded, destinationBefore: before };
}

async function runToCheckpoint(env: BenchmarkEnv, expectedPhase: number): Promise<unknown> {
    try {
        const completed = await resharder(env).runSplit(MIGRATION_ID);
        return { ...(await resharder(env).benchmarkState(MIGRATION_ID)), completed };
    } catch (error) {
        const state = await resharder(env).benchmarkState(MIGRATION_ID);
        const message = error instanceof Error ? error.message : String(error);
        const intendedCheckpoint =
            (expectedPhase === RESHARDER_PHASE.TAIL_CAUGHT_UP && message === "benchmark cutover checkpoint") ||
            (expectedPhase === RESHARDER_PHASE.DUAL_WRITE_OPEN && message === "benchmark source digest checkpoint");
        if (state.phase !== expectedPhase || !intendedCheckpoint) throw error;
        return state;
    }
}

export default {
    async fetch(request: Request, env: BenchmarkEnv, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        try {
            if (url.pathname === "/health") {
                workerInstanceId ||= crypto.randomUUID();
                return Response.json({
                    ok: true,
                    releaseSha256: env.CDB_RELEASE_SHA256 ?? null,
                    workerInstanceId,
                    proofConfigured:
                        typeof env.BETTER_AUTH_SECRET === "string" &&
                        env.BETTER_AUTH_SECRET.length > 0 &&
                        typeof env.CDB_ADMIN_TOKEN === "string" &&
                        env.CDB_ADMIN_TOKEN.length > 0 &&
                        typeof env.CDB_PROOF_RUN_ID === "string" &&
                        env.CDB_PROOF_RUN_ID.length > 0,
                });
            }
            if (url.pathname === "/benchmark/prepare") return Response.json(await prepareBenchmark(env, request));
            if (url.pathname === "/benchmark/bulk") {
                return Response.json(await runToCheckpoint(env, RESHARDER_PHASE.TAIL_CAPTURE_ENABLED));
            }
            if (url.pathname === "/benchmark/bulk-checkpoint") {
                return Response.json({ appliedBatches: await catalog(env).benchmarkBulkApplies() });
            }
            if (url.pathname === "/benchmark/reshard-state") {
                return Response.json(await resharder(env).benchmarkState(MIGRATION_ID));
            }
            if (url.pathname === "/benchmark/capture") {
                const route = await catalog(env).route(Number(vshardOf([ORGANIZATION_ID])));
                return Response.json(await cdb(env, SOURCE_SHARD).benchmarkCapture(route));
            }
            if (url.pathname === "/benchmark/resume") {
                await cdb(env, DESTINATION_SHARD).benchmarkAllowBulkResume();
                return Response.json(await runToCheckpoint(env, RESHARDER_PHASE.TAIL_CAUGHT_UP));
            }
            if (url.pathname === "/benchmark/allow-cutover") {
                await catalog(env).allowBenchmarkCutover();
                return Response.json({ ok: true });
            }
            if (url.pathname === "/benchmark/stale-retry") {
                const body = await jsonBody(request);
                if (typeof body.clientId !== "string" || typeof body.mutId !== "string") {
                    throw new Error("stale retry requires clientId and mutId");
                }
                const gateway = env.CDB_GATEWAY.get(
                    env.CDB_GATEWAY.idFromName(gatewayBucketName(body.clientId))
                ) as unknown as Gateway;
                return Response.json(await gateway.benchmarkStaleRetry({ clientId: body.clientId, mutId: body.mutId }));
            }
            if (url.pathname === "/benchmark/digests") {
                return Response.json({
                    source: await cdb(env, SOURCE_SHARD).benchmarkDigest(),
                    destination: await cdb(env, DESTINATION_SHARD).benchmarkDigest(),
                });
            }
            if (url.pathname === "/benchmark/drain") {
                await cdb(env, SOURCE_SHARD).benchmarkAllowDrain();
                await resharder(env).runSplit(MIGRATION_ID);
                return Response.json(await resharder(env).benchmarkState(MIGRATION_ID));
            }
            if (url.pathname === "/benchmark/verify") {
                const mutId = "stale-route-exact-retry";
                return Response.json({
                    route: await catalog(env).route(Number(vshardOf([ORGANIZATION_ID]))),
                    source: await cdb(env, SOURCE_SHARD).benchmarkDigest(),
                    destination: await cdb(env, DESTINATION_SHARD).benchmarkDigest(),
                    sourceMetrics: await cdb(env, SOURCE_SHARD).benchmarkMetrics(),
                    destinationMetrics: await cdb(env, DESTINATION_SHARD).benchmarkMetrics(),
                    sourceMutationCount: await cdb(env, SOURCE_SHARD).benchmarkMutationCount(mutId),
                    destinationMutationCount: await cdb(env, DESTINATION_SHARD).benchmarkMutationCount(mutId),
                    sourceSchema: await cdb(env, SOURCE_SHARD).schemaState(),
                    destinationSchema: await cdb(env, DESTINATION_SHARD).schemaState(),
                    reshard: await resharder(env).benchmarkState(MIGRATION_ID),
                });
            }
            return app.fetch(request, env as never, ctx);
        } catch (error) {
            return Response.json(
                {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                },
                { status: 500 }
            );
        }
    },
};
