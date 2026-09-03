import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { cdbPolicyDigest } from "../../src/server/cdb-policy.ts";
import { api } from "../../src/server/define.ts";
import type {
    CdbVectorizeMutationIndex,
    CdbVectorizeQueryOptions,
    CdbVectorizeRecord,
    CdbVectorizeSearchIndex,
} from "../../src/server/do/cdb-vectorize-adapter.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { gatewayBucketName } from "../../src/server/gateway-bucket.ts";
import { forOrg } from "../../src/server/index.ts";
import { type ChardbManifest, manifestFromExports } from "../../src/server/manifest.ts";
import { stableHashHex } from "../../src/util/canonical.ts";
import { searchVector, vector } from "../../src/vector.ts";
import baseWorker, {
    Catalog as ProductionCatalog,
    Cdb as ProductionCdb,
    Gateway as ProductionGateway,
    Resharder as ProductionResharder,
} from "./gateway-jwt.entry.ts";

const VECTOR_BINDING = "CDB_PROOF_VECTORS";
const PUT_REF = "test/workerd/public-vector.entry.ts#putMessage";
const REPLACE_REF = "test/workerd/public-vector.entry.ts#replaceMessage";
const DELETE_REF = "test/workerd/public-vector.entry.ts#deleteMessage";
const SEARCH_REF = "test/workerd/public-vector.entry.ts#searchMessages";
const FUTURE_CLOCK_OFFSET_MS = 60 * 60 * 1_000;

const authOrganization = sqliteTable("organization", { id: text("id").primaryKey() });
const { cdbTable } = forOrg({ organization: authOrganization });
const messages = cdbTable(
    "public_vector_messages",
    {
        id: text("id").primaryKey(),
        body: text("body").notNull(),
        embedding: vector("embedding", { dim: 3, binding: VECTOR_BINDING, metric: "cosine" }),
    },
    { roles: { member: { create: "*", update: "*", delete: true, read: "*" } } }
);

const vectorArgs = z.object({
    organizationId: z.string(),
    id: z.string(),
    body: z.string(),
    values: z.array(z.number()).length(3),
});

const putMessage = api.mutation({
    ref: PUT_REF,
    args: vectorArgs,
    authority: "organization",
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        const embedding = ctx.vector.set(messages.embedding, args.id, args.values);
        ctx.db.insert(messages).values({ id: args.id, body: args.body, embedding }).run();
        return { id: args.id };
    },
});

const replaceMessage = api.mutation({
    ref: REPLACE_REF,
    args: vectorArgs,
    authority: "organization",
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        const embedding = ctx.vector.set(messages.embedding, args.id, args.values);
        ctx.db.update(messages).set({ body: args.body, embedding }).where(eq(messages.id, args.id)).run();
        return { id: args.id };
    },
});

const deleteMessage = api.mutation({
    ref: DELETE_REF,
    args: z.object({ organizationId: z.string(), id: z.string() }),
    authority: "organization",
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        ctx.vector.delete(messages.embedding, args.id);
        ctx.db.delete(messages).where(eq(messages.id, args.id)).run();
        return { id: args.id };
    },
});

const searchMessages = api.query({
    ref: SEARCH_REF,
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

const VECTOR_SCHEMA = Object.freeze({ messages });
const vectorManifest = manifestFromExports({ putMessage, replaceMessage, deleteMessage, searchMessages });

function withVectorApi(base: ChardbManifest): ChardbManifest {
    return {
        mutations: new Map([...base.mutations, ...vectorManifest.mutations]),
        queries: new Map([...base.queries, ...vectorManifest.queries]),
    };
}

export { ProductionCatalog as Catalog };
export class Resharder extends ProductionResharder {}

export class Gateway extends ProductionGateway {
    protected override runtimeManifest(): ChardbManifest {
        return withVectorApi(super.runtimeManifest());
    }

    protected override runtimePolicyDigest(tableNames: readonly string[]): string | null {
        if (tableNames.every(table => table === "public_vector_messages")) {
            return cdbPolicyDigest(VECTOR_SCHEMA, tableNames);
        }
        return super.runtimePolicyDigest(tableNames);
    }

    override async alarm(): Promise<void> {}

    fixtureDrain(): Promise<void> {
        return super.alarm();
    }

    fixtureRegistrationState(input: { readonly subId: number }) {
        return adaptSqlStorage(this.ctx.storage.sql).one<{
            lifecycle: string;
            cdb_state: string;
            current_head: number;
            retry_error: string | null;
            dirty_version: number;
            delivered_version: number;
            initial_snapshot_pending: number;
            last_cookie: string | null;
        }>(
            `SELECT g.lifecycle, g.cdb_state, g.dirty_version, g.delivered_version,
                    g.initial_snapshot_pending, g.last_cookie,
                    CASE WHEN h.registration_id IS NULL THEN 0 ELSE 1 END AS current_head,
                    g.retry_error
             FROM _gw_registration_generations AS g
             LEFT JOIN _gw_registration_heads AS h ON h.registration_id = g.registration_id
             WHERE g.sub_id = ? ORDER BY g.created_at DESC LIMIT 1`,
            input.subId
        );
    }
}

export class Cdb extends ProductionCdb {
    private readonly proofEnv: Env;
    private vectorSchema: Record<string, unknown> | undefined;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        this.proofEnv = env;
    }

    protected override mutationSchema(): Record<string, unknown> {
        this.vectorSchema ??= Object.freeze({ ...super.mutationSchema(), ...VECTOR_SCHEMA });
        return this.vectorSchema;
    }

    protected override mutationManifest(): ChardbManifest {
        return withVectorApi(super.mutationManifest());
    }

    protected override resolveVectorIndex(binding: string): CdbVectorizeMutationIndex {
        if (binding !== VECTOR_BINDING) throw new Error(`unexpected vector mutation binding ${binding}`);
        return this.proofEnv.CDB_PROOF_VECTORS.get(
            this.proofEnv.CDB_PROOF_VECTORS.idFromName("public-vector-index")
        ) as unknown as CdbVectorizeMutationIndex;
    }

    protected override resolveVectorSearchIndex(binding: string): CdbVectorizeSearchIndex {
        if (binding !== VECTOR_BINDING) throw new Error(`unexpected vector search binding ${binding}`);
        return this.proofEnv.CDB_PROOF_VECTORS.get(
            this.proofEnv.CDB_PROOF_VECTORS.idFromName("public-vector-index")
        ) as unknown as CdbVectorizeSearchIndex;
    }

    protected override invalidationNowMs(): number {
        return Date.now() + FUTURE_CLOCK_OFFSET_MS;
    }

    fixtureForceDue(): void {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        sql.exec("UPDATE _chardb_vector_outbox SET next_attempt_at = 0, leased_until = NULL, lease_token = NULL");
        sql.exec("UPDATE _chardb_vector_attempts SET settle_after = first_sent_at");
    }

    fixtureDrain(): Promise<void> {
        return super.alarm();
    }

    fixtureVectorState() {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            rows: sql.all<{ id: string; organization_id: string; body: string; embedding: string | null }>(
                "SELECT id, organization_id, body, embedding FROM public_vector_messages ORDER BY organization_id, id"
            ),
            heads: sql.all<{
                organization_id: string;
                row_pk: string;
                version: number;
                delivered_version: number;
                state: string;
            }>(
                `SELECT organization_id, row_pk, version, delivered_version, state
                 FROM _chardb_vectors ORDER BY organization_id, row_pk`
            ),
            liveVectorResources:
                sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_live_subscription_vectors")?.count ??
                0,
        };
    }
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
        });
    }

    upsert(records: readonly CdbVectorizeRecord[]): { readonly mutationId: string } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        let mutationId = "";
        this.ctx.storage.transactionSync(() => {
            const sequence =
                sql.one<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM vector_pending")
                    ?.sequence ?? 1;
            mutationId = `upsert-${sequence}-${stableHashHex(records).slice(0, 12)}`;
            sql.exec(
                "INSERT INTO vector_pending (mutation_id, operation, payload_json) VALUES (?, 'upsert', ?)",
                mutationId,
                JSON.stringify(records)
            );
        });
        return { mutationId };
    }

    deleteByIds(ids: readonly string[]): { readonly mutationId: string } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        let mutationId = "";
        this.ctx.storage.transactionSync(() => {
            const sequence =
                sql.one<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM vector_pending")
                    ?.sequence ?? 1;
            mutationId = `delete-${sequence}-${stableHashHex(ids).slice(0, 12)}`;
            sql.exec(
                "INSERT INTO vector_pending (mutation_id, operation, payload_json) VALUES (?, 'delete', ?)",
                mutationId,
                JSON.stringify(ids)
            );
        });
        return { mutationId };
    }

    getByIds(ids: readonly string[]) {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return ids.flatMap(id => {
            const row = sql.one<{ id: string; namespace: string; values_json: string; metadata_json: string }>(
                "SELECT id, namespace, values_json, metadata_json FROM vector_documents WHERE id = ?",
                id
            );
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
        if (!mutationId) throw new Error("the vector index has not processed a mutation");
        return { processedUpToMutation: mutationId };
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
            throw new TypeError("invalid public vector query contract");
        }
        const magnitude = (items: readonly number[]) => Math.sqrt(items.reduce((sum, item) => sum + item * item, 0));
        const queryMagnitude = magnitude(values);
        const matches = adaptSqlStorage(this.ctx.storage.sql)
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

    processPending(limit = 100): { readonly processed: number } {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("invalid process limit");
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

    fixtureState() {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            processedUpToMutation:
                sql.one<{ processed_up_to_mutation: string | null }>(
                    "SELECT processed_up_to_mutation FROM vector_progress WHERE singleton = 1"
                )?.processed_up_to_mutation ?? null,
            documents: sql.all<{ id: string; namespace: string }>(
                "SELECT id, namespace FROM vector_documents ORDER BY id"
            ),
            pending: sql.all<{ sequence: number; mutation_id: string; operation: string }>(
                "SELECT sequence, mutation_id, operation FROM vector_pending ORDER BY sequence"
            ),
        };
    }
}

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_PROOF_VECTORS: DurableObjectNamespace;
}

interface CatalogFixture {
    mutateAuth(
        args: {
            readonly model: string;
            readonly op: "delete";
            readonly where: Record<string, string>;
        },
        _recoveryGeneration: number
    ): Promise<unknown>;
}

interface CdbFixture {
    fixtureDrain(): Promise<void>;
    fixtureForceDue(): Promise<void>;
    fixtureVectorState(): Promise<unknown>;
}

interface GatewayFixture {
    fixtureDrain(): Promise<void>;
    fixtureRegistrationState(input: { readonly subId: number }): Promise<unknown>;
}

interface VectorFixture {
    processPending(limit?: number): Promise<{ readonly processed: number }>;
    fixtureState(): Promise<unknown>;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/seed") {
            const response = await baseWorker.fetch(request, env);
            if (!response.ok) return response;
            return Response.json({
                ...((await response.json()) as Record<string, unknown>),
                putRef: putMessage.__chardbRef,
                replaceRef: replaceMessage.__chardbRef,
                deleteRef: deleteMessage.__chardbRef,
                searchRef: searchMessages.__chardbRef,
            });
        }
        if (url.pathname === "/membership-delete") {
            const body = (await request.json()) as { readonly organizationId: string; readonly userId: string };
            const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogFixture;
            return Response.json(
                await catalog.mutateAuth(
                    {
                        model: "member",
                        op: "delete",
                        where: { organizationId: body.organizationId, userId: body.userId },
                    },
                    0
                )
            );
        }
        if (url.pathname === "/cdb-drain" || url.pathname === "/cdb-force-due" || url.pathname === "/cdb-state") {
            const shardId = url.searchParams.get("shardId");
            if (!shardId) return new Response("missing shardId", { status: 400 });
            const cdb = env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as CdbFixture;
            if (url.pathname === "/cdb-drain") {
                await cdb.fixtureDrain();
                return Response.json({ ok: true });
            }
            if (url.pathname === "/cdb-force-due") {
                await cdb.fixtureForceDue();
                return Response.json({ ok: true });
            }
            return Response.json(await cdb.fixtureVectorState());
        }
        if (url.pathname === "/gateway-drain" || url.pathname === "/gateway-registration") {
            const clientId = url.searchParams.get("clientId");
            if (!clientId) return new Response("missing clientId", { status: 400 });
            const gateway = env.CDB_GATEWAY.get(
                env.CDB_GATEWAY.idFromName(gatewayBucketName(clientId))
            ) as unknown as GatewayFixture;
            if (url.pathname === "/gateway-drain") {
                await gateway.fixtureDrain();
                return Response.json({ ok: true });
            }
            const subId = Number(url.searchParams.get("subId"));
            if (!Number.isSafeInteger(subId)) return new Response("invalid subId", { status: 400 });
            return Response.json({ state: await gateway.fixtureRegistrationState({ subId }) });
        }
        if (url.pathname === "/vector-process" || url.pathname === "/vector-state") {
            const index = env.CDB_PROOF_VECTORS.get(
                env.CDB_PROOF_VECTORS.idFromName("public-vector-index")
            ) as unknown as VectorFixture;
            if (url.pathname === "/vector-process") return Response.json(await index.processPending(100));
            return Response.json(await index.fixtureState());
        }
        if (url.pathname === "/ws") {
            const clientId = url.searchParams.get("clientId");
            const gateway = env.CDB_GATEWAY.get(
                env.CDB_GATEWAY.idFromName(gatewayBucketName(clientId ?? "missing-client-route"))
            );
            return gateway.fetch(request);
        }
        return new Response("not found", { status: 404 });
    },
};
