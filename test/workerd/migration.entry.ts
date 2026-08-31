import { DurableObject } from "cloudflare:workers";
import { jwt } from "better-auth/plugins/jwt";
import { eq } from "drizzle-orm";
import { text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { renderSqliteTableDdl } from "../../src/auth/ddl.ts";
import { synthesizeAuthSchema } from "../../src/auth/synthesize.ts";
import { cdbPolicyDigest } from "../../src/server/cdb-policy.ts";
import { globalScope } from "../../src/server/cdb-tenant.ts";
import { api } from "../../src/server/define.ts";
import { cdbSubscriptionRequest } from "../../src/server/do/gateway.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { chardb, defineAuth, defineMigrations } from "../../src/server/index.ts";
import { routeValidatedQuery } from "../../src/server/manifest.ts";
import type { GatewayInvalidationRequest, GatewayInvalidationResponse } from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";
import { VSHARD_COUNT, vshardOf } from "../../src/vshard.ts";

declare const CHARDB_MIGRATION_RELEASE: "v1" | "v2" | "v3" | "fresh" | "fresh3" | "legacy";

const MUTATION_REF = "test/workerd/migration.entry.ts#createMigrationRow";
const LIVE_QUERY_REF = "test/workerd/migration.entry.ts#listMigrationRows";
const { cdbTable } = globalScope();
const rowsV1 = cdbTable(
    "migration_rows",
    { id: text("id").primaryKey(), value: text("value").notNull() },
    { partitionBy: "id", roles: { member: { create: "*", read: "*" } } }
);
const rowsV2 = cdbTable(
    "migration_rows",
    { id: text("id").primaryKey(), value: text("value").notNull(), note: text("note") },
    { partitionBy: "id", roles: { member: { create: "*", read: "*" } } }
);
const rowsV3 = cdbTable(
    "migration_rows",
    {
        id: text("id").primaryKey(),
        value: text("value").notNull(),
        note: text("note"),
        label: text("label"),
    },
    { partitionBy: "id", roles: { member: { create: "*", read: "*" } } }
);

const createV1 = api.mutation({
    ref: MUTATION_REF,
    args: z.object({ id: z.string(), value: z.string() }),
    handler: (ctx, args: { id: string; value: string }) => {
        ctx.db.insert(rowsV1).values(args).run();
        return args;
    },
});
const createV2 = api.mutation({
    ref: MUTATION_REF,
    args: z.object({ id: z.string(), value: z.string(), note: z.string().nullable().optional() }),
    handler: (ctx, args: { id: string; value: string; note?: string | null | undefined }) => {
        ctx.db
            .insert(rowsV2)
            .values({ ...args, note: args.note ?? null })
            .run();
        return args;
    },
});
const createV3 = api.mutation({
    ref: MUTATION_REF,
    args: z.object({
        id: z.string(),
        value: z.string(),
        note: z.string().nullable().optional(),
        label: z.string().nullable().optional(),
    }),
    handler: (
        ctx,
        args: { id: string; value: string; note?: string | null | undefined; label?: string | null | undefined }
    ) => {
        ctx.db
            .insert(rowsV3)
            .values({ ...args, note: args.note ?? null, label: args.label ?? null })
            .run();
        return args;
    },
});
const listV1 = api.query({
    ref: LIVE_QUERY_REF,
    args: z.object({ id: z.string() }),
    authority: "global",
    partitionKey: "id",
    intent: args => ({
        kind: "select",
        tables: ["migration_rows"],
        partitionKey: { table: "migration_rows", column: "id", values: [args.id] },
        joinShape: "colocated",
        intervals: [{ table: "migration_rows", indexName: "id", intervals: [{ kind: "full" }] }],
    }),
    handler: async (ctx, args) => ctx.db.select().from(rowsV1).where(eq(rowsV1.id, args.id)).all(),
});
const listV2 = api.query({
    ref: LIVE_QUERY_REF,
    args: z.object({ id: z.string() }),
    authority: "global",
    partitionKey: "id",
    intent: args => ({
        kind: "select",
        tables: ["migration_rows"],
        partitionKey: { table: "migration_rows", column: "id", values: [args.id] },
        joinShape: "colocated",
        intervals: [{ table: "migration_rows", indexName: "id", intervals: [{ kind: "full" }] }],
    }),
    handler: async (ctx, args) => ctx.db.select().from(rowsV2).where(eq(rowsV2.id, args.id)).all(),
});
const listV3 = api.query({
    ref: LIVE_QUERY_REF,
    args: z.object({ id: z.string() }),
    authority: "global",
    partitionKey: "id",
    intent: args => ({
        kind: "select",
        tables: ["migration_rows"],
        partitionKey: { table: "migration_rows", column: "id", values: [args.id] },
        joinShape: "colocated",
        intervals: [{ table: "migration_rows", indexName: "id", intervals: [{ kind: "full" }] }],
    }),
    handler: async (ctx, args) => ctx.db.select().from(rowsV3).where(eq(rowsV3.id, args.id)).all(),
});

const authV1 = defineAuth({ plugins: [jwt()] });
const authV2 = defineAuth({
    plugins: [jwt()],
    user: { additionalFields: { nickname: { type: "string", required: false } } },
});
const authV3 = defineAuth({
    plugins: [jwt()],
    user: {
        additionalFields: {
            nickname: { type: "string", required: false },
            timezone: { type: "string", required: false },
        },
    },
});
const addNoteMigration = {
    version: 1,
    name: "add_migration_note",
    statements: [
        'ALTER TABLE "migration_rows" ADD COLUMN "note" text',
        'UPDATE "migration_rows" SET "note" = \'migrated\' WHERE "note" IS NULL',
    ],
    catalogStatements: ['ALTER TABLE "user" ADD COLUMN "nickname" text'],
} as const;
const addLabelMigration = {
    version: 2,
    name: "add_migration_label",
    statements: [
        'ALTER TABLE "migration_rows" ADD COLUMN "label" text',
        'UPDATE "migration_rows" SET "label" = \'migrated-v3\' WHERE "label" IS NULL',
    ],
    catalogStatements: ['ALTER TABLE "user" ADD COLUMN "timezone" text'],
} as const;
const migrationJournal = defineMigrations([addNoteMigration]);
const rowsV1Ddl = renderSqliteTableDdl(rowsV1);
const authV1Ddl = Object.values(synthesizeAuthSchema(authV1.options as never) as Record<string, unknown>).flatMap(
    table => {
        const ddl = renderSqliteTableDdl(table as never);
        return [ddl.createTable, ...ddl.indexes];
    }
);
const freshJournal = defineMigrations([
    {
        version: 1,
        name: "create_initial_schema",
        statements: [rowsV1Ddl.createTable, ...rowsV1Ddl.indexes],
        catalogStatements: authV1Ddl,
    },
    {
        version: 2,
        name: "add_migration_note",
        statements: addNoteMigration.statements,
        catalogStatements: addNoteMigration.catalogStatements,
    },
]);
const migrationJournalV3 = defineMigrations([addNoteMigration, addLabelMigration]);
const freshJournalV3 = defineMigrations([
    {
        version: 1,
        name: "create_initial_schema",
        statements: [rowsV1Ddl.createTable, ...rowsV1Ddl.indexes],
        catalogStatements: authV1Ddl,
    },
    { ...addNoteMigration, version: 2 },
    { ...addLabelMigration, version: 3 },
]);
const usesV2Schema = CHARDB_MIGRATION_RELEASE !== "v1";
const usesV3Schema = CHARDB_MIGRATION_RELEASE === "v3" || CHARDB_MIGRATION_RELEASE === "fresh3";
const app =
    CHARDB_MIGRATION_RELEASE === "v3"
        ? chardb({
              auth: authV3,
              schema: { rows: rowsV3 },
              api: { createMigrationRow: createV3, listMigrationRows: listV3 },
              migrations: migrationJournalV3,
          })
        : CHARDB_MIGRATION_RELEASE === "fresh3"
          ? chardb({
                auth: authV3,
                schema: { rows: rowsV3 },
                api: { createMigrationRow: createV3, listMigrationRows: listV3 },
                migrations: freshJournalV3,
            })
          : CHARDB_MIGRATION_RELEASE === "v2"
            ? chardb({
                  auth: authV2,
                  schema: { rows: rowsV2 },
                  api: { createMigrationRow: createV2, listMigrationRows: listV2 },
                  migrations: migrationJournal,
              })
            : CHARDB_MIGRATION_RELEASE === "fresh"
              ? chardb({
                    auth: authV2,
                    schema: { rows: rowsV2 },
                    api: { createMigrationRow: createV2, listMigrationRows: listV2 },
                    migrations: freshJournal,
                })
              : CHARDB_MIGRATION_RELEASE === "legacy"
                ? chardb({
                      auth: authV2,
                      schema: { rows: rowsV2 },
                      api: { createMigrationRow: createV2, listMigrationRows: listV2 },
                  })
                : chardb({
                      auth: authV1,
                      schema: { rows: rowsV1 },
                      api: { createMigrationRow: createV1, listMigrationRows: listV1 },
                  });

interface Env {
    readonly CDB_ADMIN_TOKEN: string;
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
}

interface MutationInput {
    readonly mutId: string;
    readonly domainSchemaEpoch: number;
    readonly id: string;
    readonly value: string;
    readonly note?: string | null;
    readonly label?: string | null;
}

export class Cdb extends app.Cdb {
    async fixtureRegisterIdleSubscription(gatewayId: string): Promise<unknown> {
        const args = { id: "row-before-upgrade" };
        const routed = routeValidatedQuery(this.mutationManifest(), { ref: LIVE_QUERY_REF, args }, tables =>
            cdbPolicyDigest(this.mutationSchema(), tables)
        );
        if (routed.authority === null) throw new Error("migration live query fixture omitted authority");
        const organizationId = TenantId(args.id);
        return await this.subscribe(
            cdbSubscriptionRequest({
                gatewayId,
                registrationId: "migration-idle-registration",
                connectionId: "migration-idle-connection",
                clientId: ClientId("migration-idle-client"),
                subId: SubId(1),
                principalId: PrincipalId("migration-user"),
                organizationId,
                authority: routed.authority,
                schemaEpoch: 1,
                vshard: Number(vshardOf([organizationId])),
                domainSchemaEpoch: this.schemaState().activeEpoch,
                ref: ChardbRef(LIVE_QUERY_REF),
                args: routed.args,
                queryHash: routed.queryHash,
                intent: routed.intent,
            })
        );
    }

    fixtureLiveState(): {
        readonly activeRegistrations: number;
        readonly outbox: readonly Record<string, unknown>[];
    } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        return {
            activeRegistrations:
                sql.one<{ count: number }>(
                    "SELECT COUNT(*) AS count FROM _chardb_live_subscriptions WHERE state = 'active'"
                )?.count ?? 0,
            outbox: sql.all(
                `SELECT registration_id, change_seq, attempts, last_error
                 FROM _chardb_invalidation_outbox ORDER BY registration_id`
            ),
        };
    }

    fixtureState(): {
        readonly schema: ReturnType<Cdb["schemaState"]>;
        readonly rows: readonly Record<string, unknown>[];
        readonly opLogRows: number;
        readonly appliedSteps: number;
    } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const columns = sql.all<{ name: string }>('PRAGMA table_info("migration_rows")');
        const hasNote = columns.some(column => column.name === "note");
        const hasLabel = columns.some(column => column.name === "label");
        return {
            schema: this.schemaState(),
            rows: hasLabel
                ? sql.all('SELECT "id", "value", "note", "label" FROM "migration_rows" ORDER BY "id"')
                : hasNote
                  ? sql.all('SELECT "id", "value", "note" FROM "migration_rows" ORDER BY "id"')
                  : sql.all('SELECT "id", "value" FROM "migration_rows" ORDER BY "id"'),
            opLogRows: sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_op_log")?.count ?? 0,
            appliedSteps: sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_schema_steps")?.count ?? 0,
        };
    }
}

export class Gateway extends DurableObject<Env> {
    async invalidateSubscriptions(request: GatewayInvalidationRequest): Promise<GatewayInvalidationResponse> {
        const attempts = ((await this.ctx.storage.get<number>("attempts")) ?? 0) + 1;
        const priorChangeSeq = (await this.ctx.storage.get<number>("acceptedChangeSeq")) ?? 0;
        const acceptedChangeSeq = Math.max(
            priorChangeSeq,
            ...request.invalidations.map(invalidation => invalidation.changeSeq)
        );
        await this.ctx.storage.put({ attempts, acceptedChangeSeq });
        if (attempts === 1) throw new Error("fixture dropped the first invalidation response after durable acceptance");
        return {
            gatewayId: request.gatewayId,
            acknowledgements: request.invalidations.map(invalidation => ({
                registrationId: invalidation.subscription.registrationId,
                changeSeq: invalidation.changeSeq,
                status: invalidation.changeSeq <= priorChangeSeq ? "stale" : "accepted",
            })),
        };
    }

    async fixtureState(): Promise<{ readonly attempts: number; readonly acceptedChangeSeq: number }> {
        return {
            attempts: (await this.ctx.storage.get<number>("attempts")) ?? 0,
            acceptedChangeSeq: (await this.ctx.storage.get<number>("acceptedChangeSeq")) ?? 0,
        };
    }
}

export class Catalog extends app.Catalog {
    fixtureUseTwoShards(): { readonly shardIds: readonly string[] } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const split = VSHARD_COUNT / 2;
        sql.exec("DELETE FROM catalog_ranges");
        sql.exec("INSERT INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)", 0, split - 1, "ShardDO_0");
        sql.exec(
            "INSERT INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)",
            split,
            VSHARD_COUNT - 1,
            "ShardDO_1"
        );
        return { shardIds: ["ShardDO_0", "ShardDO_1"] };
    }

    fixtureState(): {
        readonly schema: ReturnType<Catalog["schemaState"]>;
        readonly users: readonly Record<string, unknown>[];
        readonly appliedSteps: number;
    } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const columns = sql.all<{ name: string }>('PRAGMA table_info("user")');
        const hasNickname = columns.some(column => column.name === "nickname");
        const hasTimezone = columns.some(column => column.name === "timezone");
        return {
            schema: this.schemaState(),
            users: hasTimezone
                ? sql.all('SELECT "id", "email", "nickname", "timezone" FROM "user" ORDER BY "id"')
                : hasNickname
                  ? sql.all('SELECT "id", "email", "nickname" FROM "user" ORDER BY "id"')
                  : sql.all('SELECT "id", "email" FROM "user" ORDER BY "id"'),
            appliedSteps: sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM catalog_schema_steps")?.count ?? 0,
        };
    }
}

async function catalogAndCdb(env: Env): Promise<{
    readonly catalog: InstanceType<typeof Catalog>;
    readonly cdb: InstanceType<typeof Cdb>;
    readonly route: { readonly shardId: string; readonly domainSchemaEpoch: number; readonly schemaEpoch: number };
}> {
    const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as InstanceType<
        typeof Catalog
    >;
    const route = await catalog.route(0);
    const cdb = env.CDB_SHARD.get(env.CDB_SHARD.idFromName(route.shardId)) as unknown as InstanceType<typeof Cdb>;
    return { catalog, cdb, route };
}

async function mutate(cdb: InstanceType<typeof Cdb>, input: MutationInput): Promise<unknown> {
    const args = usesV3Schema
        ? {
              id: input.id,
              value: input.value,
              ...(input.note === undefined ? {} : { note: input.note }),
              ...(input.label === undefined ? {} : { label: input.label }),
          }
        : usesV2Schema
          ? { id: input.id, value: input.value, ...(input.note === undefined ? {} : { note: input.note }) }
          : { id: input.id, value: input.value };
    return cdb.mutate({
        principalId: "migration-user",
        mutId: input.mutId,
        ref: MUTATION_REF as never,
        args,
        auth: { userId: "migration-user", role: "member", roles: ["member"], claims: {} },
        schemaEpoch: 1,
        domainSchemaEpoch: input.domainSchemaEpoch,
    });
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/_chardb/")) {
            return app.fetch(request, env as never, ctx);
        }
        if (url.pathname === "/fixture/seed") {
            const { catalog, cdb, route } = await catalogAndCdb(env);
            await catalog.mutateAuth({
                model: "user",
                op: "create",
                payload: {
                    id: "migration-user",
                    name: "Migration User",
                    email: "migration@example.com",
                    emailVerified: true,
                    createdAt: 1,
                    updatedAt: 1,
                },
            });
            const result = await mutate(cdb, {
                mutId: "seed-mutation",
                domainSchemaEpoch: route.domainSchemaEpoch,
                id: "row-before-upgrade",
                value: "before",
            });
            return Response.json({ route, result });
        }
        if (url.pathname === "/fixture/two-shards") {
            const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as InstanceType<
                typeof Catalog
            >;
            return Response.json(await catalog.fixtureUseTwoShards());
        }
        if (url.pathname === "/fixture/mutate") {
            const input = (await request.json()) as MutationInput;
            const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as InstanceType<
                typeof Catalog
            >;
            const shardId = "ShardDO_0";
            const cdb = env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as InstanceType<typeof Cdb>;
            const result = await mutate(cdb, input);
            return Response.json({ result, catalog: await catalog.schemaState() });
        }
        if (url.pathname === "/fixture/register-live") {
            const { cdb } = await catalogAndCdb(env);
            const gatewayId = env.CDB_GATEWAY.idFromName("migration-gateway").toString();
            return Response.json({ gatewayId, result: await cdb.fixtureRegisterIdleSubscription(gatewayId) });
        }
        if (url.pathname === "/fixture/live-state") {
            const cdb = env.CDB_SHARD.get(env.CDB_SHARD.idFromName("ShardDO_0")) as unknown as InstanceType<typeof Cdb>;
            const gateway = env.CDB_GATEWAY.get(
                env.CDB_GATEWAY.idFromName("migration-gateway")
            ) as unknown as InstanceType<typeof Gateway>;
            return Response.json({ cdb: await cdb.fixtureLiveState(), gateway: await gateway.fixtureState() });
        }
        if (url.pathname === "/fixture/route") {
            const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as InstanceType<
                typeof Catalog
            >;
            return Response.json(await catalog.route(0));
        }
        if (url.pathname === "/fixture/state") {
            const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as InstanceType<
                typeof Catalog
            >;
            const cdb = env.CDB_SHARD.get(env.CDB_SHARD.idFromName("ShardDO_0")) as unknown as InstanceType<typeof Cdb>;
            return Response.json({ catalog: await catalog.fixtureState(), cdb: await cdb.fixtureState() });
        }
        return new Response("not found", { status: 404 });
    },
};
