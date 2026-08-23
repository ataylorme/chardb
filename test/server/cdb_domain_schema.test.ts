import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createApi } from "../../src/server/define.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { forOrg, forUser, globalScope } from "../../src/server/index.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            return {
                columnNames,
                raw: () => rawRows.values(),
                *[Symbol.iterator]() {
                    yield* rows as T[];
                },
            };
        },
    };
}

function construct(CdbClass: typeof Cdb, db: Database): { readonly cdb: Cdb; readonly ready: Promise<unknown> } {
    let ready: Promise<unknown> = Promise.resolve();
    const state = {
        id: { toString: () => "domain-shard-1" },
        storage: {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        },
        blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
            ready = callback();
        },
    } as unknown as DurableObjectState;
    return { cdb: new CdbClass(state, {}), ready };
}

function domainSchema() {
    const { cdbTable } = globalScope();
    const projects = cdbTable(
        "domain_projects",
        {
            id: text("id").primaryKey(),
            slug: text("slug").notNull().unique(),
            priority: integer("priority").notNull().default(3),
        },
        { partitionBy: "id" }
    );
    const tasks = cdbTable(
        "domain_tasks",
        {
            id: text("id").primaryKey(),
            projectId: text("project_id")
                .notNull()
                .references(() => projects.id, { onDelete: "cascade" }),
            title: text("title").notNull(),
        },
        { partitionBy: "projectId" }
    );
    return { projects, tasks };
}

describe("configured Cdb domain schema", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("creates cdbTables with constraints and runs a registered mutation without setup SQL", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const schema = domainSchema();
        const api = createApi(schema);
        const createProject = api.mutation({
            handler: (ctx, args: { id: string; slug: string }) => {
                ctx.db.insert(schema.projects).values(args).run();
                return args.id;
            },
        });
        const ConfiguredCdb = configureCdbRuntime({
            schema: () => schema,
            manifest: () => manifestFromExports({ createProject }),
        });
        const first = construct(ConfiguredCdb, db);
        await first.ready;
        const reconstructed = construct(ConfiguredCdb, db);
        await reconstructed.ready;

        const projectColumns = db.query('PRAGMA table_info("domain_projects")').all() as {
            readonly name: string;
            readonly type: string;
            readonly notnull: number;
            readonly dflt_value: string | null;
            readonly pk: number;
        }[];
        expect(projectColumns.find(column => column.name === "id")).toMatchObject({ type: "TEXT", pk: 1 });
        expect(projectColumns.find(column => column.name === "slug")).toMatchObject({ type: "TEXT", notnull: 1 });
        expect(projectColumns.find(column => column.name === "priority")).toMatchObject({
            type: "INTEGER",
            notnull: 1,
            dflt_value: "3",
        });
        expect(db.query('PRAGMA index_list("domain_projects")').all()).toEqual(
            expect.arrayContaining([expect.objectContaining({ unique: 1 })])
        );
        expect(db.query('PRAGMA foreign_key_list("domain_tasks")').all()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    table: "domain_projects",
                    from: "project_id",
                    to: "id",
                    on_delete: "CASCADE",
                }),
            ])
        );
        expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('user', 'session', 'account')").all()).toEqual(
            []
        );

        const result = reconstructed.cdb.mutate({
            principalId: "user-1",
            mutId: "create-project-1",
            ref: createProject.__chardbRef,
            args: { id: "project-1", slug: "alpha" },
            auth: { userId: "user-1", roles: [], claims: {} },
            schemaEpoch: 1,
        });
        expect(result).toMatchObject({ ok: true, ran: true, result: "project-1" });
        expect(db.query('SELECT id, slug, priority FROM "domain_projects"').all()).toEqual([
            { id: "project-1", slug: "alpha", priority: 3 },
        ]);
        expect(() =>
            db.run('INSERT INTO "domain_projects" ("id", "slug") VALUES (\'project-2\', \'alpha\')')
        ).toThrow();
        expect(() =>
            db.run(
                'INSERT INTO "domain_tasks" ("id", "project_id", "title") VALUES (\'task-1\', \'missing\', \'No parent\')'
            )
        ).toThrow();
    });

    test("refuses unsigned and changed domain tables with migration guidance", async () => {
        const unsignedDb = new Database(":memory:");
        databases.push(unsignedDb);
        unsignedDb.run('CREATE TABLE "domain_projects" ("id" TEXT PRIMARY KEY)');
        const unsigned = construct(
            configureCdbRuntime({ schema: domainSchema, manifest: () => manifestFromExports({}) }),
            unsignedDb
        );
        await expect(unsigned.ready).rejects.toMatchObject({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            hint: expect.stringContaining("explicit shard schema migration"),
        });

        const changedDb = new Database(":memory:");
        databases.push(changedDb);
        const initial = construct(
            configureCdbRuntime({ schema: domainSchema, manifest: () => manifestFromExports({}) }),
            changedDb
        );
        await initial.ready;
        const { cdbTable: changedTable } = globalScope();
        const changedProjects = changedTable(
            "domain_projects",
            { id: text("id").primaryKey(), slug: text("slug").notNull(), description: text("description") },
            { partitionBy: "id" }
        );
        const changed = construct(
            configureCdbRuntime({
                schema: () => ({ projects: changedProjects }),
                manifest: () => manifestFromExports({}),
            }),
            changedDb
        );
        await expect(changed.ready).rejects.toMatchObject({
            code: "CDB_PARTITION_CONTRACT_CHANGED",
            hint: expect.stringContaining("explicit shard schema migration"),
        });

        const nonlocalDb = new Database(":memory:");
        databases.push(nonlocalDb);
        const external = sqliteTable("external_lookup", { id: text("id").primaryKey() });
        const { cdbTable: nonlocalTable } = globalScope();
        const records = nonlocalTable(
            "domain_records",
            {
                id: text("id").primaryKey(),
                externalId: text("external_id")
                    .notNull()
                    .references(() => external.id),
            },
            { partitionBy: "id" }
        );
        const nonlocal = construct(
            configureCdbRuntime({
                schema: () => ({ external, records }),
                manifest: () => manifestFromExports({}),
            }),
            nonlocalDb
        );
        await expect(nonlocal.ready).rejects.toMatchObject({ code: "CDB_NONLOCAL_FK" });
    });

    test("omits Catalog authority FKs and autofills an org-scoped insert", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const organization = sqliteTable("organization", { id: text("id").primaryKey() });
        const user = sqliteTable("user", { id: text("id").primaryKey() });
        const { cdbTable } = forOrg();
        const messages = cdbTable(
            "domain_messages",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => organization.id),
                authorId: text("author_id")
                    .notNull()
                    .references(() => user.id),
                body: text("body").notNull(),
            },
            { selfBy: "authorId", roles: { member: { create: "*" } } }
        );
        const { cdbTable: userTable } = forUser();
        const notes = userTable("domain_notes", {
            id: text("id").primaryKey(),
            userId: text("user_id")
                .notNull()
                .references(() => user.id),
            body: text("body").notNull(),
        });
        const schema = { organization, user, messages, notes };
        const api = createApi(schema);
        const postMessage = api.mutation({
            handler: (ctx, args: { id: string; body: string }) => {
                ctx.db.insert(messages).values(args).run();
                return args.id;
            },
        });
        const configured = construct(
            configureCdbRuntime({
                schema: () => schema,
                manifest: () => manifestFromExports({ postMessage }),
            }),
            db
        );
        await configured.ready;

        expect(db.query('PRAGMA foreign_key_list("domain_messages")').all()).toEqual([]);
        expect(db.query('PRAGMA foreign_key_list("domain_notes")').all()).toEqual([]);
        expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('organization', 'user')").all()).toEqual([]);
        expect(
            configured.cdb.mutate({
                principalId: "user-1",
                mutId: "post-message-1",
                ref: postMessage.__chardbRef,
                args: { id: "message-1", body: "hello" },
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
                schemaEpoch: 1,
            })
        ).toMatchObject({ ok: true, ran: true, result: "message-1" });
        expect(db.query('SELECT * FROM "domain_messages"').all()).toEqual([
            { id: "message-1", organization_id: "org-1", author_id: "user-1", body: "hello" },
        ]);
    });
});
