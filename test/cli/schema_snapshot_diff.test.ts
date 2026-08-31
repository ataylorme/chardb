import { describe, expect, test } from "bun:test";
import { SCAFFOLD_INITIAL_SNAPSHOT } from "../../src/cli/scaffold-initial-snapshot.ts";
import { diffAdditiveSchemaSnapshots } from "../../src/cli/schema-snapshot-diff.ts";
import {
    type ChardbSchemaSnapshotContent,
    type ChardbSchemaSnapshotInput,
    schemaSnapshotDigest,
} from "../../src/server/schema-snapshot.ts";

function evolve(overrides: Partial<ChardbSchemaSnapshotContent> = {}): ChardbSchemaSnapshotInput {
    const content: ChardbSchemaSnapshotContent = {
        format: SCAFFOLD_INITIAL_SNAPSHOT.format,
        version: 2,
        name: "additive_upgrade",
        previousDigest: SCAFFOLD_INITIAL_SNAPSHOT.digest,
        cdbTables: SCAFFOLD_INITIAL_SNAPSHOT.cdbTables,
        catalogTables: SCAFFOLD_INITIAL_SNAPSHOT.catalogTables,
        resources: SCAFFOLD_INITIAL_SNAPSHOT.resources,
        ...overrides,
    };
    return { ...content, digest: schemaSnapshotDigest(content) };
}

describe("additive schema snapshot diffs", () => {
    test("adds nullable columns, nonunique indexes, tables, and resource triggers deterministically", () => {
        const messages = SCAFFOLD_INITIAL_SNAPSHOT.cdbTables.find(table => table.tableName === "messages");
        if (!messages) throw new Error("scaffold messages table is missing");
        const vectorResource = {
            kind: "vector" as const,
            version: 1 as const,
            table: "messages",
            column: "embedding",
            primaryKey: "id",
            organizationColumn: "organization_id",
            binding: "VECTOR_INDEX",
            dimensions: 3,
            metric: "cosine" as const,
        };
        const next = evolve({
            cdbTables: [
                {
                    ...messages,
                    columns: [...messages.columns, { name: "embedding", sql: '"embedding" text' }],
                    indexes: [
                        ...messages.indexes,
                        {
                            name: "messages_created_at_idx",
                            unique: false,
                            sql: 'CREATE INDEX "messages_created_at_idx" ON "messages" ("created_at")',
                        },
                    ],
                },
                {
                    tableName: "reactions",
                    columns: [
                        { name: "id", sql: '"id" text PRIMARY KEY NOT NULL' },
                        { name: "organization_id", sql: '"organization_id" text NOT NULL' },
                    ],
                    constraints: [],
                    indexes: [],
                },
            ],
            resources: [...SCAFFOLD_INITIAL_SNAPSHOT.resources, vectorResource],
        });

        const migration = diffAdditiveSchemaSnapshots(SCAFFOLD_INITIAL_SNAPSHOT, next);

        expect(migration).toMatchObject({ version: 2, name: "additive_upgrade" });
        expect(migration.statements[0]).toBe('ALTER TABLE "messages" ADD COLUMN "embedding" text');
        expect(migration.statements[1]).toBe('CREATE INDEX "messages_created_at_idx" ON "messages" ("created_at")');
        expect(migration.statements[2]).toBe(
            'CREATE TABLE "reactions" ("id" text PRIMARY KEY NOT NULL, "organization_id" text NOT NULL)'
        );
        expect(migration.statements.some(statement => statement.includes("_chardb_vector_"))).toBe(true);
        expect(migration.resources).toEqual([vectorResource]);
    });

    test("rejects destructive changes and additions that need a data plan", () => {
        const messages = SCAFFOLD_INITIAL_SNAPSHOT.cdbTables.find(table => table.tableName === "messages");
        if (!messages) throw new Error("scaffold messages table is missing");
        const withMessages = (table: typeof messages) => evolve({ cdbTables: [table] });

        expect(() =>
            diffAdditiveSchemaSnapshots(
                SCAFFOLD_INITIAL_SNAPSHOT,
                withMessages({ ...messages, columns: messages.columns.slice(0, -1) })
            )
        ).toThrow(/removed a column/);
        expect(() =>
            diffAdditiveSchemaSnapshots(
                SCAFFOLD_INITIAL_SNAPSHOT,
                withMessages({
                    ...messages,
                    columns: [...messages.columns, { name: "required", sql: '"required" text NOT NULL' }],
                })
            )
        ).toThrow(/not a nullable unconstrained column/);
        expect(() =>
            diffAdditiveSchemaSnapshots(
                SCAFFOLD_INITIAL_SNAPSHOT,
                withMessages({
                    ...messages,
                    indexes: [
                        {
                            name: "messages_body_unique",
                            unique: true,
                            sql: 'CREATE UNIQUE INDEX "messages_body_unique" ON "messages" ("body")',
                        },
                    ],
                })
            )
        ).toThrow(/requires a duplicate-data plan/);
        expect(() => diffAdditiveSchemaSnapshots(SCAFFOLD_INITIAL_SNAPSHOT, evolve({ resources: [] }))).toThrow(
            /resource messages.attachment was removed/
        );
    });

    test("rejects an empty diff and a broken digest chain", () => {
        expect(() => diffAdditiveSchemaSnapshots(SCAFFOLD_INITIAL_SNAPSHOT, evolve())).toThrow(
            /no additive schema change/
        );
        const wrongChain = evolve({ previousDigest: "a".repeat(64) });
        expect(() => diffAdditiveSchemaSnapshots(SCAFFOLD_INITIAL_SNAPSHOT, wrongChain)).toThrow(
            /does not name the previous digest/
        );
    });
});
