import { text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { renderSqliteTableDdl } from "../../src/auth/ddl.ts";
import { synthesizeAuthSchema } from "../../src/auth/synthesize.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { api, chardb, defineAuth, defineMigrations, globalScope } from "../../src/server/index.ts";

declare const CHARDB_MIGRATION_RELEASE: "v1" | "v2" | "fresh" | "legacy";

const MUTATION_REF = "test/workerd/migration.entry.ts#createMigrationRow";
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

const authV1 = defineAuth({});
const authV2 = defineAuth({
    user: { additionalFields: { nickname: { type: "string", required: false } } },
});
const migrationJournal = defineMigrations([
    {
        version: 1,
        name: "add_migration_note",
        statements: [
            'ALTER TABLE "migration_rows" ADD COLUMN "note" text',
            'UPDATE "migration_rows" SET "note" = \'migrated\' WHERE "note" IS NULL',
        ],
        catalogStatements: ['ALTER TABLE "user" ADD COLUMN "nickname" text'],
    },
]);
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
        statements: migrationJournal.migrations[0]?.statements ?? [],
        catalogStatements: migrationJournal.migrations[0]?.catalogStatements ?? [],
    },
]);
const usesV2Schema = CHARDB_MIGRATION_RELEASE !== "v1";
const app =
    CHARDB_MIGRATION_RELEASE === "v2"
        ? chardb({
              auth: authV2,
              schema: { rows: rowsV2 },
              api: { createMigrationRow: createV2 },
              migrations: migrationJournal,
          })
        : CHARDB_MIGRATION_RELEASE === "fresh"
          ? chardb({
                auth: authV2,
                schema: { rows: rowsV2 },
                api: { createMigrationRow: createV2 },
                migrations: freshJournal,
            })
          : CHARDB_MIGRATION_RELEASE === "legacy"
            ? chardb({ auth: authV2, schema: { rows: rowsV2 }, api: { createMigrationRow: createV2 } })
            : chardb({ auth: authV1, schema: { rows: rowsV1 }, api: { createMigrationRow: createV1 } });

interface Env {
    readonly CDB_ADMIN_TOKEN: string;
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
}

interface MutationInput {
    readonly mutId: string;
    readonly domainSchemaEpoch: number;
    readonly id: string;
    readonly value: string;
    readonly note?: string | null;
}

export class Cdb extends app.Cdb {
    fixtureState(): {
        readonly schema: ReturnType<Cdb["schemaState"]>;
        readonly rows: readonly Record<string, unknown>[];
        readonly opLogRows: number;
        readonly appliedSteps: number;
    } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const columns = sql.all<{ name: string }>('PRAGMA table_info("migration_rows")');
        const hasNote = columns.some(column => column.name === "note");
        return {
            schema: this.schemaState(),
            rows: hasNote
                ? sql.all('SELECT "id", "value", "note" FROM "migration_rows" ORDER BY "id"')
                : sql.all('SELECT "id", "value" FROM "migration_rows" ORDER BY "id"'),
            opLogRows: sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_op_log")?.count ?? 0,
            appliedSteps: sql.one<{ count: number }>("SELECT COUNT(*) AS count FROM _chardb_schema_steps")?.count ?? 0,
        };
    }
}

export class Catalog extends app.Catalog {
    fixtureState(): {
        readonly schema: ReturnType<Catalog["schemaState"]>;
        readonly users: readonly Record<string, unknown>[];
        readonly appliedSteps: number;
    } {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const columns = sql.all<{ name: string }>('PRAGMA table_info("user")');
        const hasNickname = columns.some(column => column.name === "nickname");
        return {
            schema: this.schemaState(),
            users: hasNickname
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
    const args = usesV2Schema
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
