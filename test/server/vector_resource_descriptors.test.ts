import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineAuth } from "../../src/auth/synthesize.ts";
import { BINDING_SELECT_PLAN_PROFILE, resolveSelectPlan } from "../../src/server/binding-plan-server.ts";
import { forOrg, forUser } from "../../src/server/cdb-tenant.ts";
import { assertCatalogOrganizationDeletionSupported } from "../../src/server/do/catalog.ts";
import { canonicalRegisteredTableSpecs } from "../../src/server/do/cdb-reshard-identity-store.ts";
import { hasActiveCdbVectorResources } from "../../src/server/do/cdb-reshard-runtime.ts";
import { initializeCdbVectorOrganizationDeletionStore } from "../../src/server/do/cdb-vector-organization-deletion-store.ts";
import { CdbVectorOutboxStore, initializeCdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { configureResharderRuntime } from "../../src/server/do/resharder.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";
import {
    assertSchemaResourceJournal,
    cdbVectorResourceId,
    cdbVectorResourceIdentity,
    collectSchemaFileResourceDescriptors,
    collectSchemaResourceDescriptors,
    normalizeChardbResourceDescriptor,
} from "../../src/server/resource-descriptors.ts";
import { defineMigrations, defineSchemaBaseline, migrationDigestAt } from "../../src/server/schema-migrations.ts";
import { renderVectorMutationTriggerSet } from "../../src/server/vector-triggers.ts";
import { type VectorConfig, inlineVector, normalizeVectorConfig, vector } from "../../src/vector.ts";

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
        id: { toString: () => "vector-only-shard" },
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

const organization = sqliteTable("organization", { id: text("id").primaryKey() });
const user = sqliteTable("user", { id: text("id").primaryKey() });

function organizationVectors(config: VectorConfig = { dim: 3, binding: "CDB_MESSAGES", metric: "cosine" }) {
    const { cdbTable } = forOrg();
    return cdbTable(
        "vector_messages",
        {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => organization.id),
            embedding: vector("embedding", config),
        },
        { roles: { member: { read: "*" } } }
    );
}

describe("internal organization vector resource contract", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("normalizes one organization-owned VectorResourceV1 descriptor", () => {
        const messages = organizationVectors();

        expect(collectSchemaResourceDescriptors({ messages })).toEqual([
            {
                kind: "vector",
                version: 1,
                table: "vector_messages",
                column: "embedding",
                primaryKey: "id",
                organizationColumn: "organization_id",
                binding: "CDB_MESSAGES",
                dimensions: 3,
                metric: "cosine",
            },
        ]);
        expect(collectSchemaFileResourceDescriptors({ messages })).toEqual([]);
        const normalized = normalizeChardbResourceDescriptor({
            kind: "vector",
            version: 1,
            table: "vector_messages",
            column: "embedding",
            primaryKey: "id",
            organizationColumn: "organization_id",
            binding: "CDB_MESSAGES",
            dimensions: 3,
            metric: "cosine",
        });
        const [discovered] = collectSchemaResourceDescriptors({ messages });
        if (!discovered || discovered.kind !== "vector") throw new Error("vector descriptor fixture is missing");
        expect(normalized).toEqual(discovered);
        const identity = cdbVectorResourceIdentity(discovered);
        expect(identity).toEqual({
            resourceId: `vr1_${identity.resourceDigest}`,
            resourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(cdbVectorResourceId(discovered)).toBe(identity.resourceId);
        expect(identity.resourceId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
        const triggerPrefix = `_chardb_vector_${identity.resourceId.slice("vr1_".length, "vr1_".length + 16)}`;
        expect(renderVectorMutationTriggerSet(discovered).names.every(name => name.startsWith(triggerPrefix))).toBe(
            true
        );
    });

    test("detects vectors from schema at version zero and from the active migration prefix afterward", () => {
        const messages = organizationVectors();
        const resources = collectSchemaResourceDescriptors({ messages });
        const versionZero = defineMigrations([]);
        expect(hasActiveCdbVectorResources({ schema: { messages }, journal: versionZero, activeVersion: 0 })).toBe(
            true
        );

        const journal = defineMigrations([
            { version: 1, name: "relational", statements: ["CREATE TABLE relational_only (id TEXT PRIMARY KEY)"] },
            {
                version: 2,
                name: "vectors",
                statements: ["CREATE TABLE vector_marker (id TEXT PRIMARY KEY)"],
                resources,
            },
        ]);
        expect(hasActiveCdbVectorResources({ schema: { messages }, journal, activeVersion: 1 })).toBe(false);
        expect(hasActiveCdbVectorResources({ schema: {}, journal, activeVersion: 2 })).toBe(true);
    });

    test("rejects malformed dimensions, metrics, bindings, descriptors, and ownership", () => {
        for (const config of [
            { dim: 0, binding: "CDB_MESSAGES", metric: "cosine" },
            { dim: 1_537, binding: "CDB_MESSAGES", metric: "cosine" },
            { dim: 1.5, binding: "CDB_MESSAGES", metric: "cosine" },
        ]) {
            expect(() => normalizeVectorConfig(config as never)).toThrow(/integer from 1 through 1536/);
        }
        expect(() => normalizeVectorConfig({ dim: 3, binding: "bad-binding", metric: "cosine" })).toThrow(
            /Worker binding name/
        );
        expect(() => normalizeVectorConfig({ dim: 3, binding: "CDB_MESSAGES", metric: "manhattan" } as never)).toThrow(
            /metric/
        );

        const descriptor = {
            kind: "vector",
            version: 1,
            table: "vector_messages",
            column: "embedding",
            primaryKey: "id",
            organizationColumn: "organization_id",
            binding: "CDB_MESSAGES",
            dimensions: 3,
            metric: "cosine",
        } as const;
        expect(() => normalizeChardbResourceDescriptor({ ...descriptor, extra: true })).toThrow(/unexpected fields/);
        expect(() => normalizeChardbResourceDescriptor({ ...descriptor, dimensions: 0 })).toThrow(/dimensions/);
        expect(() => normalizeChardbResourceDescriptor({ ...descriptor, dimensions: 1_537 })).toThrow(
            /integer from 1 through 1536/
        );
        expect(() => normalizeChardbResourceDescriptor({ ...descriptor, metric: "manhattan" })).toThrow(/metric/);
        expect(() => normalizeChardbResourceDescriptor({ ...descriptor, binding: "bad-binding" })).toThrow(/binding/);

        const { cdbTable } = forUser();
        const userVectors = cdbTable("user_vectors", {
            id: text("id").primaryKey(),
            userId: text("user_id")
                .notNull()
                .references(() => user.id),
            embedding: vector("embedding", { dim: 3, binding: "CDB_USERS", metric: "dot-product" }),
        });
        expect(() => collectSchemaResourceDescriptors({ userVectors })).toThrow(/organization tenancy/);
    });

    test("binds vector identity and ownership into the exact migration digest", () => {
        const auth = defineAuth({});
        const baseline = (config: { dim: number; binding: string; metric: "cosine" | "euclidean" | "dot-product" }) =>
            defineSchemaBaseline({
                version: 1,
                name: "vectors",
                domainSchema: { messages: organizationVectors(config) },
                authOptions: auth.options,
            });
        const first = baseline({ dim: 3, binding: "CDB_MESSAGES", metric: "cosine" });
        const changedDimensions = baseline({ dim: 4, binding: "CDB_MESSAGES", metric: "cosine" });
        const variants = [
            changedDimensions,
            baseline({ dim: 3, binding: "CDB_MESSAGES_V2", metric: "cosine" }),
            baseline({ dim: 3, binding: "CDB_MESSAGES", metric: "euclidean" }),
        ];
        const firstJournal = defineMigrations([first]);

        const [firstResource] = first.resources ?? [];
        if (!firstResource || firstResource.kind !== "vector") {
            throw new Error("vector migration resource fixture is missing");
        }
        const firstIdentity = cdbVectorResourceIdentity(firstResource);

        expect(first.statements.some(statement => statement.includes("_chardb_file"))).toBe(false);
        expect(() => assertCatalogOrganizationDeletionSupported(firstJournal, [])).not.toThrow();
        expect(() => assertCatalogOrganizationDeletionSupported(firstJournal, ["org-vector"])).not.toThrow();
        for (const changed of variants) {
            expect(defineMigrations([changed]).digest).not.toBe(firstJournal.digest);
            const [changedResource] = changed.resources ?? [];
            if (!changedResource || changedResource.kind !== "vector") {
                throw new Error("changed vector migration resource fixture is missing");
            }
            expect(cdbVectorResourceIdentity(changedResource)).not.toEqual(firstIdentity);
        }
        expect(() =>
            assertSchemaResourceJournal({ messages: organizationVectors() }, firstJournal.migrations)
        ).not.toThrow();
        expect(() =>
            assertSchemaResourceJournal(
                { messages: organizationVectors({ dim: 3, binding: "CDB_MESSAGES", metric: "euclidean" }) },
                firstJournal.migrations
            )
        ).toThrow(/do not match the packaged migration journal/);

        const changedResources = changedDimensions.resources;
        if (!changedResources) throw new Error("changed vector migration resource fixture is missing");
        const evolvedJournal = defineMigrations([
            first,
            {
                version: 2,
                name: "resize_vectors",
                statements: ["SELECT 1"],
                resources: changedResources,
            },
        ]);
        expect(() =>
            assertSchemaResourceJournal(
                { messages: organizationVectors({ dim: 4, binding: "CDB_MESSAGES", metric: "cosine" }) },
                evolvedJournal.migrations
            )
        ).not.toThrow();
        expect(() =>
            assertSchemaResourceJournal({ messages: organizationVectors() }, evolvedJournal.migrations)
        ).toThrow(/do not match the packaged migration journal/);

        const [resource] = first.resources ?? [];
        if (!resource) throw new Error("vector migration resource fixture is missing");
        const movedOwnership = normalizeChardbResourceDescriptor({
            ...(resource as unknown as Record<string, unknown>),
            organizationColumn: "workspace_id",
        });
        const movedJournal = defineMigrations([{ ...first, resources: [movedOwnership] }]);
        expect(movedJournal.digest).not.toBe(firstJournal.digest);
    });

    test("keeps inline vectors out of native resources", () => {
        const { cdbTable } = forOrg();
        const messages = cdbTable("inline_vector_messages", {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => organization.id),
            embedding: inlineVector("embedding", { dim: 3 }),
        });

        expect(collectSchemaResourceDescriptors({ messages })).toEqual([]);
        expect(() =>
            sqliteTable("invalid_inline_vector", {
                embedding: inlineVector("embedding", { dim: 0 }),
            })
        ).toThrow(/integer from 1 through 4096/);
    });

    test("bootstraps movable deletion tombstones without file attachment triggers for a vector-only schema", async () => {
        const messages = organizationVectors();
        const ConfiguredCdb = configureCdbRuntime({
            schema: () => ({ messages }),
            manifest: () => manifestFromExports({}),
        });
        const db = new Database(":memory:");
        databases.push(db);
        const { cdb, ready } = construct(ConfiguredCdb, db);
        await ready;

        expect(
            db
                .query(
                    `SELECT name FROM sqlite_master
                     WHERE name IN (
                       '_chardb_files',
                       '_chardb_deleted_organizations',
                       '_chardb_split_file_cursor',
                       '_chardb_split_file_applied'
                     )
                     ORDER BY name`
                )
                .all()
        ).toEqual([
            { name: "_chardb_deleted_organizations" },
            { name: "_chardb_files" },
            { name: "_chardb_split_file_applied" },
            { name: "_chardb_split_file_cursor" },
        ]);
        expect(db.query("SELECT next_id, active_id, active_vshard FROM _chardb_split_capture_tx").get()).toEqual({
            next_id: 0,
            active_id: null,
            active_vshard: null,
        });
        expect(
            db
                .query(
                    `SELECT name FROM sqlite_master
                     WHERE type = 'trigger'
                       AND (name GLOB '_chardb_file_*' OR name GLOB '_chardb_filecapt_*')
                     ORDER BY name`
                )
                .all()
        ).toEqual([]);
        expect(
            cdb.prepareReshardFileSource({
                migId: "vector-only",
                rangeLo: 0,
                rangeHi: 0,
                schemaVersion: 0,
                schemaEpoch: 1,
                schemaDigest: defineMigrations([]).digest,
                tables: [],
                afterKind: "file",
                afterId: "",
                limit: 500,
            })
        ).toEqual({
            enabled: true,
            backfill: { files: 0, tombstones: 0, done: true },
            cursor: { kind: "organization_tombstone", afterId: "", done: false },
        });
        expect(
            cdb.prepareReshardFileSource({
                migId: "vector-only",
                rangeLo: 0,
                rangeHi: 0,
                schemaVersion: 0,
                schemaEpoch: 1,
                schemaDigest: defineMigrations([]).digest,
                tables: [],
                afterKind: "organization_tombstone",
                afterId: "",
                limit: 500,
            })
        ).toMatchObject({ enabled: true, cursor: { kind: "organization_tombstone", done: true } });
    });

    test("admits schema-derived vector tables to the native online reshard protocol", () => {
        const messages = organizationVectors();
        expect(
            canonicalRegisteredTableSpecs({ messages }, [
                {
                    name: "vector_messages",
                    partitionColumn: "organization_id",
                    columns: ["id", "organization_id", "embedding"],
                },
            ])
        ).toEqual({
            tables: [
                {
                    name: "vector_messages",
                    partitionColumn: "organization_id",
                    columns: ["id", "organization_id", "embedding"],
                },
            ],
            json: JSON.stringify([
                {
                    columns: ["id", "organization_id", "embedding"],
                    name: "vector_messages",
                    partitionColumn: "organization_id",
                },
            ]),
        });
    });

    test("configured Resharder binds vector movement before taking a Catalog lease", async () => {
        const messages = organizationVectors();
        const ConfiguredResharder = configureResharderRuntime({ schema: () => ({ messages }) });
        const db = new Database(":memory:");
        databases.push(db);
        let ready: Promise<unknown> = Promise.resolve();
        let catalogBegins = 0;
        const state = {
            id: { toString: () => "vector-resharder" },
            storage: {
                sql: sqlStorage(db),
                transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                ready = callback();
            },
        } as unknown as DurableObjectState;
        const catalogNamespace = {
            idFromName: (name: string) => ({ name }),
            get: () => ({
                beginTopologyOperation() {
                    catalogBegins++;
                    return {
                        status: "active" as const,
                        schemaVersion: 0,
                        schemaEpoch: 1,
                        schemaDigest: "a".repeat(64),
                    };
                },
            }),
        } as unknown as DurableObjectNamespace;
        const resharder = new ConfiguredResharder(state, { CDB_CATALOG: catalogNamespace });
        await ready;

        await resharder.startSplit({
            migId: "vector-move",
            srcShard: "ShardDO_0",
            dstShard: "ShardDO_1",
            rangeLo: 0,
            rangeHi: 100,
            epochAtStart: 1,
            tables: [
                {
                    name: "vector_messages",
                    partitionColumn: "organization_id",
                    columns: ["id", "organization_id", "embedding"],
                },
            ],
        });
        expect(catalogBegins).toBe(1);
        expect(db.query("SELECT COUNT(*) AS count FROM migration_state").get()).toEqual({ count: 1 });
        expect(db.query("SELECT COUNT(*) AS count FROM migration_start_intent").get()).toEqual({ count: 0 });
    });

    test("rebuilds a vector table under exact migration triggers and rolls back an orphaned head", async () => {
        const messagesV1 = organizationVectors();
        const auth = defineAuth({});
        const baseline = defineSchemaBaseline({
            version: 1,
            name: "vector_v1",
            domainSchema: { messages: messagesV1 },
            authOptions: auth.options,
        });
        const journalV1 = defineMigrations([baseline]);
        const db = new Database(":memory:");
        databases.push(db);
        const V1 = configureCdbRuntime({
            schema: () => ({ messages: messagesV1 }),
            manifest: () => manifestFromExports({}),
            migrations: () => journalV1,
        });
        const first = construct(V1, db);
        await first.ready;
        first.cdb.prepareSchemaMigration({
            migrationId: "vector-v1",
            activeVersion: 0,
            activeDigest: migrationDigestAt(journalV1, 0),
            targetVersion: 1,
            targetEpoch: 2,
            targetDigest: journalV1.digest,
        });
        first.cdb.applySchemaMigration({ migrationId: "vector-v1", version: 1 });
        await first.cdb.activateSchemaMigration({ migrationId: "vector-v1" });

        const [resource] = collectSchemaResourceDescriptors({ messages: messagesV1 });
        if (!resource || resource.kind !== "vector") throw new Error("vector rebuild resource is missing");
        const vectorSql = adaptSqlStorage(sqlStorage(db));
        initializeCdbVectorOutboxStore(vectorSql);
        const vectors = new CdbVectorOutboxStore(vectorSql);
        const resourceId = cdbVectorResourceId(resource);
        const vectorId = "vec_rebuild";
        db.transaction(() => {
            vectors.stageUpsert({
                vectorId,
                organizationId: "org-rebuild",
                resourceId,
                rowPk: "message-rebuild",
                dimensions: 3,
                values: [1, 2, 3],
                metadata: {},
                nowMs: 100,
            });
            db.run("INSERT INTO vector_messages (id, organization_id, embedding) VALUES (?, ?, ?)", [
                "message-rebuild",
                "org-rebuild",
                vectorId,
            ]);
        })();

        const { cdbTable } = forOrg();
        const messagesV2 = cdbTable(
            "vector_messages",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => organization.id),
                embedding: vector("embedding", { dim: 3, binding: "CDB_MESSAGES", metric: "cosine" }),
                note: text("note"),
            },
            { roles: { member: { read: "*" } } }
        );
        const rebuild = {
            version: 2,
            name: "rebuild_vectors",
            statements: [
                'ALTER TABLE "vector_messages" RENAME TO "_vector_messages_v1"',
                'CREATE TABLE "vector_messages" ("id" text PRIMARY KEY NOT NULL, "organization_id" text NOT NULL, "embedding" text, "note" text)',
                'INSERT INTO "vector_messages" ("id", "organization_id", "embedding", "note") SELECT "id", "organization_id", "embedding", NULL FROM "_vector_messages_v1"',
                'DROP TABLE "_vector_messages_v1"',
            ],
        } as const;
        const journalV2 = defineMigrations([baseline, rebuild]);
        const V2 = configureCdbRuntime({
            schema: () => ({ messages: messagesV2 }),
            manifest: () => manifestFromExports({}),
            migrations: () => journalV2,
        });
        const second = construct(V2, db);
        await second.ready;
        second.cdb.prepareSchemaMigration({
            migrationId: "vector-v2",
            activeVersion: 1,
            activeDigest: migrationDigestAt(journalV2, 1),
            targetVersion: 2,
            targetEpoch: 3,
            targetDigest: journalV2.digest,
        });
        second.cdb.applySchemaMigration({ migrationId: "vector-v2", version: 2 });
        expect(db.query("SELECT id, embedding, note FROM vector_messages").get()).toEqual({
            id: "message-rebuild",
            embedding: vectorId,
            note: null,
        });

        const corruptJournal = defineMigrations([
            baseline,
            rebuild,
            {
                version: 3,
                name: "orphan_vector",
                statements: ["UPDATE vector_messages SET embedding = 'forged_vector'"],
            },
        ]);
        await second.cdb.activateSchemaMigration({ migrationId: "vector-v2" });
        const Corrupt = configureCdbRuntime({
            schema: () => ({ messages: messagesV2 }),
            manifest: () => manifestFromExports({}),
            migrations: () => corruptJournal,
        });
        const third = construct(Corrupt, db);
        await third.ready;
        third.cdb.prepareSchemaMigration({
            migrationId: "vector-v3",
            activeVersion: 2,
            activeDigest: migrationDigestAt(corruptJournal, 2),
            targetVersion: 3,
            targetEpoch: 4,
            targetDigest: corruptJournal.digest,
        });
        expect(() => third.cdb.applySchemaMigration({ migrationId: "vector-v3", version: 3 })).toThrow(
            "without its exact vector head"
        );
        expect(db.query("SELECT embedding FROM vector_messages").get()).toEqual({ embedding: vectorId });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_schema_steps WHERE version = 3").get()).toEqual({
            count: 0,
        });
    });

    test("blocks an FK cascade until the exact vector head is durably deleting", () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec("PRAGMA foreign_keys = ON");
        db.exec("CREATE TABLE vector_parents (id TEXT PRIMARY KEY)");
        db.exec(
            "CREATE TABLE vector_children (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES vector_parents(id) ON DELETE CASCADE, embedding TEXT)"
        );
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCdbVectorOutboxStore(sql);
        const resource = normalizeChardbResourceDescriptor({
            kind: "vector",
            version: 1,
            table: "vector_children",
            column: "embedding",
            primaryKey: "id",
            organizationColumn: "organization_id",
            binding: "CDB_CHILDREN",
            dimensions: 3,
            metric: "cosine",
        });
        if (resource.kind !== "vector") throw new Error("cascade vector resource is missing");
        for (const statement of renderVectorMutationTriggerSet(resource).install) db.exec(statement);
        const vectors = new CdbVectorOutboxStore(sql);
        const vectorId = "vec_cascade";
        vectors.stageUpsert({
            vectorId,
            organizationId: "org-cascade",
            resourceId: cdbVectorResourceId(resource),
            rowPk: "child-1",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: {},
            nowMs: 100,
        });
        db.run("INSERT INTO vector_parents VALUES ('parent-1')");
        db.run("INSERT INTO vector_children VALUES ('child-1', 'org-cascade', 'parent-1', ?)", [vectorId]);

        expect(() => db.run("DELETE FROM vector_parents WHERE id = 'parent-1'")).toThrow(
            "CDB_VECTOR_MUTATION_REQUIRED"
        );
        expect(db.query("SELECT id FROM vector_parents").all()).toEqual([{ id: "parent-1" }]);
        expect(db.query("SELECT id FROM vector_children").all()).toEqual([{ id: "child-1" }]);
        expect(vectors.read(vectorId)).toMatchObject({ state: "pending" });

        vectors.stageDelete({ vectorId, organizationId: "org-cascade", nowMs: 101 });
        db.run("DELETE FROM vector_parents WHERE id = 'parent-1'");
        expect(db.query("SELECT id FROM vector_children").all()).toEqual([]);
        expect(vectors.read(vectorId)).toMatchObject({ state: "deleting" });
    });

    test("allows only an exact durable organization tombstone to delete an orphaned vector domain row", () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec("CREATE TABLE vector_documents (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, embedding TEXT)");
        const sql = adaptSqlStorage(sqlStorage(db));
        initializeCdbVectorOutboxStore(sql);
        initializeCdbVectorOrganizationDeletionStore(sql);
        const resource = normalizeChardbResourceDescriptor({
            kind: "vector",
            version: 1,
            table: "vector_documents",
            column: "embedding",
            primaryKey: "id",
            organizationColumn: "organization_id",
            binding: "CDB_DOCUMENTS",
            dimensions: 3,
            metric: "cosine",
        });
        if (resource.kind !== "vector") throw new Error("document vector resource is missing");
        db.run("INSERT INTO vector_documents VALUES ('document-1', 'org-deleted', 'vector-orphan')");
        for (const statement of renderVectorMutationTriggerSet(resource).install) db.exec(statement);

        expect(() => db.run("DELETE FROM vector_documents WHERE id = 'document-1'")).toThrow(
            "CDB_VECTOR_MUTATION_REQUIRED"
        );
        db.run(
            "INSERT INTO _chardb_deleted_organizations (organization_id, deleted_at, placement_vshard) VALUES ('org-other', 1, 7)"
        );
        expect(() => db.run("DELETE FROM vector_documents WHERE id = 'document-1'")).toThrow(
            "CDB_VECTOR_MUTATION_REQUIRED"
        );
        db.run(
            "INSERT INTO _chardb_deleted_organizations (organization_id, deleted_at, placement_vshard) VALUES ('org-deleted', 2, 7)"
        );
        db.run("INSERT INTO vector_documents VALUES ('document-2', 'org-deleted', NULL)");
        expect(() => db.run("UPDATE vector_documents SET embedding = 'vector-attach' WHERE id = 'document-2'")).toThrow(
            "CDB_VECTOR_MUTATION_REQUIRED"
        );
        expect(() =>
            db.run("UPDATE vector_documents SET embedding = 'vector-replace' WHERE id = 'document-1'")
        ).toThrow("CDB_VECTOR_MUTATION_REQUIRED");
        expect(() => db.run("UPDATE vector_documents SET embedding = NULL WHERE id = 'document-1'")).toThrow(
            "CDB_VECTOR_MUTATION_REQUIRED"
        );
        db.run("DELETE FROM vector_documents WHERE id = 'document-1'");
        expect(db.query("SELECT id, embedding FROM vector_documents").all()).toEqual([
            { id: "document-2", embedding: null },
        ]);
    });

    test("rejects a changed vector descriptor before fresh-shard bootstrap writes partial state", async () => {
        const auth = defineAuth({});
        const first = defineSchemaBaseline({
            version: 1,
            name: "vector_dim_three",
            domainSchema: { messages: organizationVectors() },
            authOptions: auth.options,
        });
        const messagesV2 = organizationVectors({ dim: 4, binding: "CDB_MESSAGES", metric: "cosine" });
        const changed = defineSchemaBaseline({
            version: 2,
            name: "vector_dim_four",
            domainSchema: { messages: messagesV2 },
            authOptions: auth.options,
        });
        if (!changed.resources) throw new Error("changed vector descriptor is missing");
        const journal = defineMigrations([
            first,
            {
                version: 2,
                name: changed.name,
                statements: ["SELECT 1"],
                resources: changed.resources,
            },
        ]);
        const Configured = configureCdbRuntime({
            schema: () => ({ messages: messagesV2 }),
            manifest: () => manifestFromExports({}),
            migrations: () => journal,
        });
        const db = new Database(":memory:");
        databases.push(db);
        const configured = construct(Configured, db);

        await expect(configured.ready).rejects.toMatchObject({
            code: "CDB_UNSUPPORTED_FEATURE",
            message: "vector resource vector_messages.embedding cannot change or disappear during schema migration",
        });
        expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE '_chardb_%'").all()).toEqual([]);
    });

    test("keeps full-row binding plans closed until vector reads are implemented", () => {
        const messages = organizationVectors();
        expect(() =>
            resolveSelectPlan(
                { messages },
                {
                    version: 1,
                    kind: "select",
                    table: "vector_messages",
                    selection: { kind: "all" },
                    where: {
                        kind: "compare",
                        op: "eq",
                        column: "organization_id",
                        value: "org-1",
                    },
                    cardinality: "many",
                },
                BINDING_SELECT_PLAN_PROFILE
            )
        ).toThrow("full-row output cannot encode");
    });
});
