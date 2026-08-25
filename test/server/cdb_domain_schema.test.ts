import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { renderSqliteTableDdl } from "../../src/auth/ddl.ts";
import { createApi } from "../../src/server/define.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { forOrg, forUser, globalScope } from "../../src/server/index.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";
import { defineMigrations, migrationDigestAt } from "../../src/server/schema-migrations.ts";

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
            setAlarm: async (): Promise<void> => {},
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
        { partitionBy: "id", roles: { member: { create: ["id", "slug"] } } }
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

function migrationSchemaV1() {
    const { cdbTable } = globalScope();
    return {
        projects: cdbTable(
            "domain_migration_projects",
            { id: text("id").primaryKey(), slug: text("slug").notNull().unique() },
            { partitionBy: "id", roles: { member: { read: "*" } } }
        ),
    };
}

function migrationSchemaV2() {
    const { cdbTable } = globalScope();
    return {
        projects: cdbTable(
            "domain_migration_projects",
            {
                id: text("id").primaryKey(),
                slug: text("slug").notNull().unique(),
                description: text("description").notNull(),
            },
            { partitionBy: "id", roles: { member: { read: "*" } } }
        ),
    };
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

        const result = await reconstructed.cdb.mutate({
            principalId: "user-1",
            mutId: "create-project-1",
            ref: createProject.__chardbRef,
            args: { id: "project-1", slug: "alpha" },
            auth: { userId: "user-1", role: "member", roles: ["member"], claims: {} },
            schemaEpoch: 1,
            domainSchemaEpoch: 1,
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

    test("applies ordered migration SQL, survives reconstruction, and activates one exact epoch", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const schema = domainSchema();
        const api = createApi(schema);
        let handlerRuns = 0;
        const createProject = api.mutation({
            handler: (ctx, args: { id: string; slug: string }) => {
                handlerRuns += 1;
                ctx.db.insert(schema.projects).values(args).run();
                return args.id;
            },
        });
        const manifest = manifestFromExports({ createProject });
        const initialJournal = defineMigrations([]);
        const InitialCdb = configureCdbRuntime({
            schema: () => schema,
            manifest: () => manifest,
            migrations: () => initialJournal,
        });
        const initial = construct(InitialCdb, db);
        await initial.ready;
        expect(initial.cdb.schemaState()).toMatchObject({
            activeVersion: 0,
            activeEpoch: 1,
            activeDigest: initialJournal.digest,
            status: "active",
        });

        const futureJournal = defineMigrations([
            {
                version: 1,
                name: "transactional_probe",
                statements: [
                    'CREATE TABLE "migration_probe" ("id" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL)',
                    'DROP TABLE "migration_probe"',
                ],
            },
        ]);
        const FutureCdb = configureCdbRuntime({
            schema: () => schema,
            manifest: () => manifest,
            migrations: () => futureJournal,
        });
        const pending = construct(FutureCdb, db);
        await pending.ready;
        expect(pending.cdb.schemaState()).toMatchObject({ activeVersion: 0, activeEpoch: 1, status: "active" });
        await expect(
            pending.cdb.mutate({
                principalId: "user-1",
                mutId: "stale-before-prepare",
                ref: createProject.__chardbRef,
                args: { id: "pre-prepare-project", slug: "pre-prepare" },
                auth: { userId: "user-1", role: "member", roles: ["member"], claims: {} },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH", retryable: true } });
        expect(handlerRuns).toBe(0);

        const prepared = pending.cdb.prepareSchemaMigration({
            migrationId: "deploy-2",
            activeVersion: 0,
            activeDigest: initialJournal.digest,
            targetVersion: 1,
            targetEpoch: 2,
            targetDigest: futureJournal.digest,
        });
        expect(prepared).toMatchObject({
            activeVersion: 0,
            activeEpoch: 1,
            status: "migrating",
            migrationId: "deploy-2",
            targetVersion: 1,
            targetEpoch: 2,
        });
        await expect(
            pending.cdb.mutate({
                principalId: "user-1",
                mutId: "stale-before-activation",
                ref: createProject.__chardbRef,
                args: { id: "stale-project", slug: "stale" },
                auth: { userId: "user-1", role: "member", roles: ["member"], claims: {} },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH", retryable: true } });
        expect(handlerRuns).toBe(0);
        expect(db.query("SELECT COUNT(*) AS count FROM domain_projects").get()).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_op_log").get()).toEqual({ count: 0 });
        expect(() => pending.cdb.activateSchemaMigration({ migrationId: "deploy-2" })).toThrow(/incomplete/);
        expect(pending.cdb.applySchemaMigration({ migrationId: "deploy-2", version: 1 })).toMatchObject({
            status: "migrating",
        });
        expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'migration_probe'").get()).toBeNull();
        expect(pending.cdb.applySchemaMigration({ migrationId: "deploy-2", version: 1 })).toMatchObject({
            status: "migrating",
        });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_schema_steps").get()).toEqual({ count: 1 });

        const reconstructed = construct(FutureCdb, db);
        await reconstructed.ready;
        expect(reconstructed.cdb.schemaState()).toMatchObject({ status: "migrating", migrationId: "deploy-2" });
        db.run('CREATE TABLE "unexpected_migration_table" ("id" TEXT PRIMARY KEY)');
        expect(() => reconstructed.cdb.activateSchemaMigration({ migrationId: "deploy-2" })).toThrow(
            /unexpected_migration_table/
        );
        expect(reconstructed.cdb.schemaState()).toMatchObject({ status: "migrating", migrationId: "deploy-2" });
        db.run('DROP TABLE "unexpected_migration_table"');
        expect(reconstructed.cdb.activateSchemaMigration({ migrationId: "deploy-2" })).toMatchObject({
            activeVersion: 1,
            activeEpoch: 2,
            activeDigest: futureJournal.digest,
            lastMigrationId: "deploy-2",
            status: "active",
        });
        expect(reconstructed.cdb.activateSchemaMigration({ migrationId: "deploy-2" })).toMatchObject({
            activeVersion: 1,
            activeEpoch: 2,
        });
        expect(migrationDigestAt(futureJournal, 1)).toBe(futureJournal.digest);
        await expect(
            reconstructed.cdb.mutate({
                principalId: "user-1",
                mutId: "old-epoch-after-activation",
                ref: createProject.__chardbRef,
                args: { id: "old-project", slug: "old" },
                auth: { userId: "user-1", role: "member", roles: ["member"], claims: {} },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH", retryable: true } });
        await expect(
            reconstructed.cdb.mutate({
                principalId: "user-1",
                mutId: "fresh-after-activation",
                ref: createProject.__chardbRef,
                args: { id: "fresh-project", slug: "fresh" },
                auth: { userId: "user-1", role: "member", roles: ["member"], claims: {} },
                schemaEpoch: 1,
                domainSchemaEpoch: 2,
            })
        ).resolves.toMatchObject({ ok: true, ran: true, result: "fresh-project" });
        expect(handlerRuns).toBe(1);

        const activeAgain = construct(FutureCdb, db);
        await activeAgain.ready;
        expect(activeAgain.cdb.schemaState()).toMatchObject({ activeVersion: 1, activeEpoch: 2, status: "active" });
    });

    test("rebuilds a changed domain table, preserves rows, and fences old requests", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const schemaV1 = migrationSchemaV1();
        const journalV1 = defineMigrations([]);
        const CdbV1 = configureCdbRuntime({
            schema: () => schemaV1,
            manifest: () => manifestFromExports({}),
            migrations: () => journalV1,
        });
        const initial = construct(CdbV1, db);
        await initial.ready;
        db.run(
            `INSERT INTO "domain_migration_projects" ("id", "slug")
             VALUES ('project-1', 'retained')`
        );

        const schemaV2 = migrationSchemaV2();
        const apiV2 = createApi(schemaV2);
        let queryRuns = 0;
        const listProjects = apiV2.query({
            handler: async ctx => {
                queryRuns += 1;
                return ctx.db.select().from(schemaV2.projects).all();
            },
        });
        const ddlV2 = renderSqliteTableDdl(schemaV2.projects);
        const journalV2 = defineMigrations([
            {
                version: 1,
                name: "add_project_description",
                statements: [
                    `ALTER TABLE "domain_migration_projects" RENAME TO "_domain_migration_projects_v1"`,
                    ddlV2.createTable,
                    `INSERT INTO "domain_migration_projects" ("id", "slug", "description")
                     SELECT "id", "slug", 'migrated' FROM "_domain_migration_projects_v1"`,
                    `DROP TABLE "_domain_migration_projects_v1"`,
                    ...ddlV2.indexes,
                ],
            },
        ]);
        const CdbV2 = configureCdbRuntime({
            schema: () => schemaV2,
            manifest: () => manifestFromExports({ listProjects }),
            migrations: () => journalV2,
        });
        const upgrading = construct(CdbV2, db);
        await upgrading.ready;
        await expect(
            upgrading.cdb.query({
                domainSchemaEpoch: 1,
                ref: listProjects.__chardbRef,
                args: {},
                auth: { userId: "user-1", role: "member", roles: ["member"], claims: {} },
            })
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH" } });
        expect(queryRuns).toBe(0);

        upgrading.cdb.prepareSchemaMigration({
            migrationId: "rebuild-projects-v2",
            activeVersion: 0,
            activeDigest: journalV1.digest,
            targetVersion: 1,
            targetEpoch: 2,
            targetDigest: journalV2.digest,
        });
        upgrading.cdb.applySchemaMigration({ migrationId: "rebuild-projects-v2", version: 1 });
        expect(db.query('SELECT id, slug, description FROM "domain_migration_projects"').all()).toEqual([
            { id: "project-1", slug: "retained", description: "migrated" },
        ]);

        const reconstructed = construct(CdbV2, db);
        await reconstructed.ready;
        expect(reconstructed.cdb.activateSchemaMigration({ migrationId: "rebuild-projects-v2" })).toMatchObject({
            activeVersion: 1,
            activeEpoch: 2,
            status: "active",
        });
        const activeAgain = construct(CdbV2, db);
        await activeAgain.ready;
        await expect(
            activeAgain.cdb.query({
                domainSchemaEpoch: 1,
                ref: listProjects.__chardbRef,
                args: {},
                auth: { userId: "user-1", role: "member", roles: ["member"], claims: {} },
            })
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH" } });
        await expect(
            activeAgain.cdb.query({
                domainSchemaEpoch: 2,
                ref: listProjects.__chardbRef,
                args: {},
                auth: { userId: "user-1", role: "member", roles: ["member"], claims: {} },
            })
        ).resolves.toMatchObject({
            ok: true,
            result: [{ id: "project-1", slug: "retained", description: "migrated" }],
        });
        expect(queryRuns).toBe(1);
    });

    test("starts a fresh journal at version zero and applies every schema step before serving", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const schema = migrationSchemaV2();
        const ddl = renderSqliteTableDdl(schema.projects);
        const journal = defineMigrations([
            {
                version: 1,
                name: "create_projects",
                statements: [ddl.createTable, ...ddl.indexes],
            },
        ]);
        const FreshCdb = configureCdbRuntime({
            schema: () => schema,
            manifest: () => manifestFromExports({}),
            migrations: () => journal,
        });
        const fresh = construct(FreshCdb, db);
        await fresh.ready;
        expect(fresh.cdb.schemaState()).toMatchObject({ activeVersion: 0, activeEpoch: 1, status: "active" });
        expect(db.query("SELECT name FROM sqlite_master WHERE name = 'domain_migration_projects'").get()).toBeNull();

        fresh.cdb.prepareSchemaMigration({
            migrationId: "fresh-v1",
            activeVersion: 0,
            activeDigest: migrationDigestAt(journal, 0),
            targetVersion: 1,
            targetEpoch: 2,
            targetDigest: journal.digest,
        });
        fresh.cdb.applySchemaMigration({ migrationId: "fresh-v1", version: 1 });
        expect(fresh.cdb.activateSchemaMigration({ migrationId: "fresh-v1" })).toMatchObject({
            activeVersion: 1,
            activeEpoch: 2,
            status: "active",
        });
        expect(db.query('PRAGMA table_info("domain_migration_projects")').all()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: "id" }),
                expect.objectContaining({ name: "slug" }),
                expect.objectContaining({ name: "description" }),
            ])
        );
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_schema_steps").get()).toEqual({ count: 1 });

        const reconstructed = construct(FreshCdb, db);
        await reconstructed.ready;
        expect(reconstructed.cdb.schemaState()).toMatchObject({ activeVersion: 1, activeEpoch: 2 });
    });

    test("baselines existing version-zero storage without replaying packaged SQL", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const schema = domainSchema();
        const EmptyJournalCdb = configureCdbRuntime({
            schema: () => schema,
            manifest: () => manifestFromExports({}),
            migrations: () => defineMigrations([]),
        });
        const legacy = construct(EmptyJournalCdb, db);
        await legacy.ready;
        db.run(`INSERT INTO "domain_projects" ("id", "slug") VALUES ('legacy-project', 'retained')`);
        db.run(`CREATE TABLE "__miniflare_do_name" ("name" TEXT NOT NULL)`);

        const journal = defineMigrations([
            { version: 1, name: "adopt_existing_schema", statements: ["THIS SQL MUST NOT EXECUTE"] },
        ]);
        const JournalCdb = configureCdbRuntime({
            schema: () => schema,
            manifest: () => manifestFromExports({}),
            migrations: () => journal,
        });
        const adopting = construct(JournalCdb, db);
        await adopting.ready;
        expect(adopting.cdb.schemaState()).toMatchObject({ activeVersion: 0, activeEpoch: 1, status: "active" });
        expect(
            adopting.cdb.baselineSchemaMigration({
                migrationId: "baseline-v1",
                targetVersion: 1,
                targetEpoch: 2,
                targetDigest: journal.digest,
            })
        ).toMatchObject({
            activeVersion: 1,
            activeEpoch: 2,
            activeDigest: journal.digest,
            lastMigrationId: "baseline-v1",
            status: "active",
        });
        expect(db.query('SELECT "id", "slug" FROM "domain_projects"').all()).toEqual([
            { id: "legacy-project", slug: "retained" },
        ]);
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_schema_steps").get()).toEqual({ count: 0 });
        expect(
            adopting.cdb.baselineSchemaMigration({
                migrationId: "baseline-v1",
                targetVersion: 1,
                targetEpoch: 2,
                targetDigest: journal.digest,
            })
        ).toMatchObject({ activeVersion: 1, activeEpoch: 2 });

        const reconstructed = construct(JournalCdb, db);
        await reconstructed.ready;
        expect(reconstructed.cdb.schemaState()).toMatchObject({ activeVersion: 1, activeEpoch: 2 });
    });

    test("rolls back a failed migration step before recording it", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const schema = domainSchema();
        const initialJournal = defineMigrations([]);
        const InitialCdb = configureCdbRuntime({
            schema: () => schema,
            manifest: () => manifestFromExports({}),
            migrations: () => initialJournal,
        });
        const initial = construct(InitialCdb, db);
        await initial.ready;
        const brokenJournal = defineMigrations([
            {
                version: 1,
                name: "broken",
                statements: ['CREATE TABLE "rolled_back_probe" ("id" TEXT PRIMARY KEY)', "INVALID SQL"],
            },
        ]);
        const BrokenCdb = configureCdbRuntime({
            schema: () => schema,
            manifest: () => manifestFromExports({}),
            migrations: () => brokenJournal,
        });
        const broken = construct(BrokenCdb, db);
        await broken.ready;
        broken.cdb.prepareSchemaMigration({
            migrationId: "broken-2",
            activeVersion: 0,
            activeDigest: initialJournal.digest,
            targetVersion: 1,
            targetEpoch: 2,
            targetDigest: brokenJournal.digest,
        });
        expect(() => broken.cdb.applySchemaMigration({ migrationId: "broken-2", version: 1 })).toThrow();
        expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'rolled_back_probe'").get()).toBeNull();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_schema_steps").get()).toEqual({ count: 0 });
        expect(broken.cdb.schemaState()).toMatchObject({ activeVersion: 0, status: "migrating" });
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
            await configured.cdb.mutate({
                principalId: "user-1",
                mutId: "post-message-1",
                ref: postMessage.__chardbRef,
                args: { id: "message-1", body: "hello" },
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).toMatchObject({ ok: true, ran: true, result: "message-1" });
        expect(db.query('SELECT * FROM "domain_messages"').all()).toEqual([
            { id: "message-1", organization_id: "org-1", author_id: "user-1", body: "hello" },
        ]);
    });
});
