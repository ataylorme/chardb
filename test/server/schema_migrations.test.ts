import { describe, expect, test } from "bun:test";
import { defineMigrations, pendingMigrations } from "../../src/server/schema-migrations.ts";

describe("packaged schema migration journal", () => {
    test("owns, freezes, hashes, and selects a contiguous migration suffix", () => {
        const statements = ["CREATE TABLE projects (id TEXT PRIMARY KEY)"];
        const input = [
            { version: 1, name: "create_projects", statements },
            { version: 2, name: "add_project_name", statements: ["ALTER TABLE projects ADD COLUMN name TEXT"] },
        ];
        const journal = defineMigrations(input);
        statements[0] = "DROP TABLE projects";
        input[0] = { version: 1, name: "changed", statements: [] };

        expect(journal).toMatchObject({ format: "chardb.migrations.v1", version: 2 });
        expect(journal.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(journal.migrations[0]).toMatchObject({
            version: 1,
            name: "create_projects",
            statements: ["CREATE TABLE projects (id TEXT PRIMARY KEY)"],
        });
        expect(Object.isFrozen(journal)).toBe(true);
        expect(Object.isFrozen(journal.migrations)).toBe(true);
        expect(Object.isFrozen(journal.migrations[0]?.statements)).toBe(true);
        expect(pendingMigrations(journal, 0).map(migration => migration.version)).toEqual([1, 2]);
        expect(pendingMigrations(journal, 1).map(migration => migration.version)).toEqual([2]);
        expect(pendingMigrations(journal, 2)).toEqual([]);
        expect(
            defineMigrations([
                { version: 1, name: "create_projects", statements: ["CREATE TABLE projects (id TEXT PRIMARY KEY)"] },
                {
                    version: 2,
                    name: "add_project_name",
                    statements: ["ALTER TABLE projects ADD COLUMN name TEXT"],
                },
            ]).digest
        ).toBe(journal.digest);
    });

    test("rejects gaps, unknown fields, accessors, sparse arrays, invalid names, and oversized SQL", () => {
        expect(() => defineMigrations([{ version: 2, name: "gap", statements: ["SELECT 1"] }])).toThrow(/contiguous/);
        expect(() => defineMigrations([{ version: 1, name: "bad name", statements: ["SELECT 1"] }])).toThrow(
            /invalid name/
        );
        expect(() =>
            defineMigrations([{ version: 1, name: "extra", statements: ["SELECT 1"], extra: true } as never])
        ).toThrow(/contain only/);
        const getter = Object.defineProperty({}, "version", { enumerable: true, get: () => 1 });
        Object.defineProperties(getter, {
            name: { enumerable: true, value: "getter" },
            statements: { enumerable: true, value: ["SELECT 1"] },
        });
        expect(() => defineMigrations([getter as never])).toThrow(/data properties/);
        const sparse = new Array(1) as string[];
        expect(() => defineMigrations([{ version: 1, name: "sparse", statements: sparse }])).toThrow(/dense data/);
        expect(() => defineMigrations([{ version: 1, name: "large", statements: ["x".repeat(1_048_577)] }])).toThrow(
            /1048576 UTF-8 bytes/
        );
    });

    test("rejects stored future, negative, and noninteger versions", () => {
        const journal = defineMigrations([{ version: 1, name: "one", statements: ["SELECT 1"] }]);
        for (const version of [-1, 0.5, 2, Number.NaN]) {
            expect(() => pendingMigrations(journal, version)).toThrow(/incompatible/);
        }
    });
});
