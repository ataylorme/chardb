import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { organization } from "better-auth/plugins/organization";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
    canonicalizeSqliteTableDdlDescriptor,
    describeSqliteTableDdl,
    renderSqliteTableDdlDescriptor,
} from "../../src/auth/ddl.ts";
import { synthesizeAuthSchema } from "../../src/auth/synthesize.ts";
import * as rootSurface from "../../src/index.ts";
import * as serverSurface from "../../src/server/index.ts";
import { defineMigrations } from "../../src/server/schema-migrations.ts";
import {
    type ChardbSchemaSnapshotContent,
    defineSchemaSnapshot,
    inspectInitialSchemaSnapshot,
    schemaSnapshotDigest,
} from "../../src/server/schema-snapshot.ts";
import { forOrgUser } from "../helpers/cdb-table.ts";

const projects = sqliteTable(
    "projects",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        sequence: integer("sequence").notNull().default(0),
    },
    table => [index("projects_name_idx").on(table.name)]
);

const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
});

const assets = sqliteTable("assets", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    attachment: text("attachment"),
    embedding: text("embedding"),
});

const memberships = sqliteTable("memberships", {
    id: text("id").primaryKey(),
    projectId: text("project_id")
        .notNull()
        .references(() => projects.id),
    userId: text("user_id")
        .notNull()
        .references(() => users.id),
});

function tableDescriptor(table: Parameters<typeof describeSqliteTableDdl>[0]) {
    return canonicalizeSqliteTableDdlDescriptor(describeSqliteTableDdl(table));
}

function content(overrides: Partial<ChardbSchemaSnapshotContent> = {}): ChardbSchemaSnapshotContent {
    return {
        format: "chardb.schema-snapshot.v1",
        version: 1,
        name: "initial_schema",
        previousDigest: null,
        cdbTables: [tableDescriptor(projects)],
        catalogTables: [tableDescriptor(users)],
        resources: [],
        ...overrides,
    };
}

function define(input: ChardbSchemaSnapshotContent = content()) {
    const snapshot = defineSchemaSnapshot({ ...input, digest: schemaSnapshotDigest(input) });
    if (!snapshot.initialMigration) throw new Error("test helper requires an initial snapshot migration");
    return snapshot as typeof snapshot & {
        readonly initialMigration: NonNullable<typeof snapshot.initialMigration>;
    };
}

describe("immutable schema snapshots", () => {
    test("omits every configured auth FK from an organization-user shard snapshot", () => {
        const authOptions = { plugins: [organization()] };
        const auth = synthesizeAuthSchema(authOptions);
        const { cdbTable } = forOrgUser();
        const documents = cdbTable(
            "snapshot_org_user_documents",
            {
                id: text("id").primaryKey(),
                organizationId: text("organization_id")
                    .notNull()
                    .references(() => auth.organization.id),
                ownerId: text("owner_id")
                    .notNull()
                    .references(() => auth.user.id),
                reviewerId: text("reviewer_id")
                    .notNull()
                    .references(() => auth.user.id),
            },
            { selfBy: "ownerId", roles: { self: { read: "*" } } }
        );

        const inspected = inspectInitialSchemaSnapshot({
            name: "org_user_snapshot",
            domainSchema: { documents },
            authOptions,
        });
        const snapshot = defineSchemaSnapshot(inspected);
        if (!snapshot.initialMigration) throw new Error("expected an initial migration");
        expect(snapshot.cdbTables[0]?.constraints.filter(constraint => constraint.kind === "foreign-key")).toEqual([]);

        const shard = new Database(":memory:");
        for (const statement of snapshot.initialMigration.statements) shard.run(statement);
        expect(shard.query('PRAGMA foreign_key_list("snapshot_org_user_documents")').all()).toEqual([]);
        shard.close();
    });

    test("owns, freezes, hashes, and converts a canonical snapshot into executable migration data", () => {
        const cdbTables = [tableDescriptor(projects)];
        const catalogTables = [tableDescriptor(users)];
        const input = content({ cdbTables, catalogTables });
        const snapshot = define(input);

        cdbTables[0] = tableDescriptor(users);
        catalogTables.length = 0;

        expect(snapshot).toMatchObject({
            format: "chardb.schema-snapshot.v1",
            version: 1,
            name: "initial_schema",
            previousDigest: null,
        });
        expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(snapshot.initialMigration.statements).toEqual([
            'CREATE TABLE "projects" ("id" text PRIMARY KEY NOT NULL, "name" text NOT NULL, "sequence" integer NOT NULL DEFAULT 0)',
            'CREATE INDEX "projects_name_idx" ON "projects" ("name")',
        ]);
        expect(snapshot.initialMigration.catalogStatements).toEqual([
            'CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL, "email" text NOT NULL CONSTRAINT "users_email_unique" UNIQUE)',
        ]);
        expect(defineMigrations([snapshot.initialMigration])).toMatchObject({ version: 1 });
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.cdbTables)).toBe(true);
        expect(Object.isFrozen(snapshot.cdbTables[0]?.columns)).toBe(true);
        expect(Object.isFrozen(snapshot.initialMigration.statements)).toBe(true);
    });

    test("installs equivalent Cdb and Catalog schemas from the converted migration", () => {
        const snapshot = define();
        const cdb = new Database(":memory:");
        const catalog = new Database(":memory:");
        for (const statement of snapshot.initialMigration.statements) cdb.run(statement);
        for (const statement of snapshot.initialMigration.catalogStatements ?? []) catalog.run(statement);

        const cdbColumns = cdb.query('PRAGMA table_info("projects")').all() as { name: string }[];
        const catalogColumns = catalog.query('PRAGMA table_info("users")').all() as { name: string }[];
        expect(cdbColumns.map(column => column.name)).toEqual(["id", "name", "sequence"]);
        expect(catalogColumns.map(column => column.name)).toEqual(["id", "email"]);
        expect((cdb.query('PRAGMA index_list("projects")').all() as { name: string }[]).map(row => row.name)).toContain(
            "projects_name_idx"
        );
        cdb.close();
        catalog.close();
    });

    test("preserves constraint definition order so generated DDL matches the runtime auth renderer", () => {
        const descriptor = tableDescriptor(memberships);
        const input = content({ catalogTables: [descriptor] });
        const migration = define(input).initialMigration;

        expect(migration.catalogStatements).toEqual([renderSqliteTableDdlDescriptor(descriptor).createTable]);
        expect(descriptor.constraints.map(constraint => constraint.name)).toEqual([
            "memberships_project_id_projects_id_fk",
            "memberships_user_id_users_id_fk",
        ]);
    });

    test("binds native resources to real snapshot columns and derives their trigger programs", () => {
        const fileResource = {
            kind: "file" as const,
            version: 1 as const,
            table: "assets",
            column: "attachment",
            primaryKey: "id",
            organizationColumn: "organization_id",
            maxSize: 1_024,
            contentTypes: ["image/png"],
        };
        const input = content({
            cdbTables: [tableDescriptor(assets)],
            resources: [
                fileResource,
                {
                    kind: "vector",
                    version: 1,
                    table: "assets",
                    column: "embedding",
                    primaryKey: "id",
                    organizationColumn: "organization_id",
                    binding: "ASSET_VECTORS",
                    dimensions: 3,
                    metric: "cosine",
                },
            ],
        });
        const snapshot = define(input);

        expect(snapshot.initialMigration.resources).toEqual(input.resources);
        expect(snapshot.initialMigration.statements.some(statement => statement.includes("_chardb_file_"))).toBe(true);
        expect(snapshot.initialMigration.statements.some(statement => statement.includes("_chardb_vector_"))).toBe(
            true
        );
        expect(() =>
            schemaSnapshotDigest(
                content({
                    cdbTables: [tableDescriptor(assets)],
                    resources: [{ ...fileResource, column: "missing" }],
                })
            )
        ).toThrow(/references missing column missing/);
    });

    test("rejects content tampering and invalid digest chains", () => {
        const input = content();
        const digest = schemaSnapshotDigest(input);
        expect(() => defineSchemaSnapshot({ ...input, name: "changed", digest })).toThrow(/digest does not match/);
        expect(() => defineSchemaSnapshot({ ...input, digest: "0".repeat(64) })).toThrow(/digest does not match/);
        expect(() => schemaSnapshotDigest(content({ previousDigest: "a".repeat(64) }))).toThrow(
            /version 1 previousDigest must be null/
        );
        expect(() => schemaSnapshotDigest(content({ version: 2, previousDigest: null }))).toThrow(
            /previousDigest must be a SHA-256 digest/
        );
        expect(() => schemaSnapshotDigest(content({ version: 2, previousDigest: digest }))).not.toThrow();
        const evolved = content({ version: 2, previousDigest: digest });
        expect(defineSchemaSnapshot({ ...evolved, digest: schemaSnapshotDigest(evolved) }).initialMigration).toBeNull();
    });

    test("rejects noncanonical ordering, duplicate identities, sparse arrays, accessors, and unknown fields", () => {
        const alpha = tableDescriptor(sqliteTable("alpha", { id: text("id").primaryKey() }));
        const omega = tableDescriptor(sqliteTable("omega", { id: text("id").primaryKey() }));
        expect(() => schemaSnapshotDigest(content({ cdbTables: [omega, alpha] }))).toThrow(/canonical order/);

        const descriptor = tableDescriptor(projects);
        const firstColumn = descriptor.columns[0];
        if (!firstColumn) throw new Error("projects descriptor is missing its first column");
        expect(() =>
            schemaSnapshotDigest(content({ cdbTables: [{ ...descriptor, columns: [firstColumn, firstColumn] }] }))
        ).toThrow(/columns must be unique/);
        expect(() =>
            schemaSnapshotDigest(
                content({
                    cdbTables: [
                        {
                            ...descriptor,
                            indexes: [
                                { name: "z_idx", unique: false, sql: 'CREATE INDEX "z_idx" ON "projects" ("name")' },
                                { name: "a_idx", unique: false, sql: 'CREATE INDEX "a_idx" ON "projects" ("id")' },
                            ],
                        },
                    ],
                })
            )
        ).toThrow(/indexes must be in canonical order/);

        const sparse = new Array(1);
        expect(() => schemaSnapshotDigest(content({ cdbTables: sparse as never }))).toThrow(/dense data/);
        const accessor = Object.defineProperty({}, "format", {
            enumerable: true,
            get: () => "chardb.schema-snapshot.v1",
        });
        Object.assign(accessor, {
            version: 1,
            name: "initial_schema",
            previousDigest: null,
            cdbTables: [descriptor],
            catalogTables: [],
            resources: [],
        });
        expect(() => schemaSnapshotDigest(accessor as never)).toThrow(/data properties/);
        expect(() => schemaSnapshotDigest({ ...content(), extra: true } as never)).toThrow(/contain only/);
        const inherited = Object.assign(Object.create({ hidden: true }), content());
        expect(() => schemaSnapshotDigest(inherited as never)).toThrow(/plain data/);
        const symbolTables = [descriptor] as unknown[] & { [key: symbol]: boolean };
        symbolTables[Symbol("hidden")] = true;
        expect(() => schemaSnapshotDigest(content({ cdbTables: symbolTables as never }))).toThrow(/symbol fields/);
    });

    test("exports the authoring constructor from @chardb/core/server only", () => {
        expect(serverSurface.defineSchemaSnapshot).toBe(defineSchemaSnapshot);
        expect("defineSchemaSnapshot" in rootSurface).toBe(false);
        expect("schemaSnapshotDigest" in serverSurface).toBe(false);
    });
});
