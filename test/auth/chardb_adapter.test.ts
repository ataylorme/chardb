import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chardbAuthAdapter } from "../../src/auth/chardb_adapter.ts";
import { bindAuthRuntime, resetAuthRuntime } from "../../src/auth/runtime.ts";
import {
    AUTH_BULK_PRELOAD_MAX_ROWS,
    AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES,
    AUTH_BULK_REPLACEMENT_MAX_BYTES,
} from "../../src/auth/sql.ts";
import { defineAuth, synthesizeAuthSchema } from "../../src/auth/synthesize.ts";
import { chardb } from "../../src/server/chardb.ts";
import { Catalog } from "../../src/server/do/catalog.ts";
import { PrincipalId, TenantId } from "../../src/types.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database, statements: string[] = []) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            statements.push(query);
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

class CatalogHarness {
    readonly db: Database;
    readonly sqlStatements: string[] = [];
    private bootstrap: Promise<unknown> = Promise.resolve();
    private readonly state: DurableObjectState;
    catalog: Catalog;

    constructor(prepare?: (db: Database) => void) {
        this.db = new Database(":memory:");
        prepare?.(this.db);
        this.state = {
            storage: {
                sql: sqlStorage(this.db, this.sqlStatements),
                transactionSync: <T>(callback: () => T): T => this.db.transaction(callback)(),
            },
            blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
                this.bootstrap = callback();
            },
        } as unknown as DurableObjectState;
        this.catalog = new Catalog(this.state, {});
    }

    async ready(): Promise<void> {
        await this.bootstrap;
    }

    async restart(): Promise<void> {
        this.catalog = new Catalog(this.state as never, {});
        await this.ready();
    }

    close(): void {
        this.db.close();
    }
}

function namespaceFor(harness: CatalogHarness): DurableObjectNamespace {
    return {
        idFromName(name: string) {
            if (name !== "global") throw new Error(`unexpected Catalog id: ${name}`);
            return name as never;
        },
        get() {
            return harness.catalog as never;
        },
    } as unknown as DurableObjectNamespace;
}

const auth = defineAuth({});

function bindRuntime(): void {
    resetAuthRuntime();
    bindAuthRuntime({
        schema: synthesizeAuthSchema(auth.options as never) as never,
        options: auth.options as { readonly [key: string]: unknown },
    });
}

function eq(field: string, value: string | number | boolean | string[] | number[] | Date | null) {
    return [{ field, value, operator: "eq" as const }];
}

describe("chardbAuthAdapter — Catalog-owned auth storage", () => {
    let harness: CatalogHarness;

    beforeEach(async () => {
        bindRuntime();
        harness = new CatalogHarness();
        await harness.ready();
    });

    afterEach(() => {
        harness.close();
        resetAuthRuntime();
    });

    test("creates and looks up core and membership rows by non-owner fields", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");

        await adapter.create({
            model: "user",
            forceAllowId: true,
            data: {
                id: "user-1",
                name: "Ada",
                email: "ada@example.com",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
            },
        });
        await adapter.create({
            model: "session",
            forceAllowId: true,
            data: {
                id: "session-1",
                token: "session-token",
                userId: "user-1",
                expiresAt: now,
                createdAt: now,
                updatedAt: now,
            },
        });
        await adapter.create({
            model: "account",
            forceAllowId: true,
            data: {
                id: "account-1",
                accountId: "provider-account",
                providerId: "github",
                userId: "user-1",
                createdAt: now,
                updatedAt: now,
            },
        });
        await adapter.create({
            model: "organization",
            forceAllowId: true,
            data: {
                id: "org-1",
                name: "Example",
                slug: "example",
                createdAt: now,
            },
        });
        await adapter.create({
            model: "member",
            forceAllowId: true,
            data: {
                id: "member-1",
                organizationId: "org-1",
                userId: "user-1",
                role: "member",
                createdAt: now,
            },
        });

        const userByEmail = (await adapter.findOne({
            model: "user",
            where: eq("email", "ada@example.com"),
        })) as { readonly createdAt?: unknown } | null;
        expect(userByEmail).toMatchObject({ id: "user-1", emailVerified: true });
        expect(userByEmail?.createdAt).toBeInstanceOf(Date);
        if (!(userByEmail?.createdAt instanceof Date)) throw new Error("expected a Date from the auth adapter");
        expect(userByEmail.createdAt.getTime()).toBe(now.getTime());
        expect(await adapter.findOne({ model: "session", where: eq("token", "session-token") })).toMatchObject({
            id: "session-1",
        });
        expect(await adapter.findOne({ model: "session", where: eq("expiresAt", now) })).toMatchObject({
            id: "session-1",
            expiresAt: now,
        });
        expect(
            await adapter.findOne({
                model: "account",
                where: [
                    { field: "providerId", value: "github", operator: "eq" },
                    { field: "accountId", value: "provider-account", operator: "eq" },
                ],
            })
        ).toMatchObject({ id: "account-1" });
        expect(await adapter.findMany({ model: "member", where: eq("userId", "user-1") })).toEqual([
            expect.objectContaining({ id: "member-1", organizationId: "org-1" }),
        ]);
        expect(harness.catalog.authEpoch({ tenantId: "org-1" as never, principalId: "user-1" as never })).toEqual({
            global: 1,
            tenant: 2,
            principal: 4,
        });
    });

    test("counts filtered rows with scalar SQL and no row materialization", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");
        for (const [id, name] of [
            ["count-user-1", "Counted"],
            ["count-user-2", "Counted"],
            ["count-user-3", "Excluded"],
        ] as const) {
            await adapter.create({
                model: "user",
                forceAllowId: true,
                data: {
                    id,
                    name,
                    email: `${id}@example.com`,
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                },
            });
        }
        harness.sqlStatements.length = 0;

        await expect(adapter.count({ model: "user", where: eq("name", "Counted") })).resolves.toBe(2);
        expect(harness.sqlStatements).toContain('SELECT COUNT(*) AS c FROM "user" WHERE "name" = ?');
        expect(harness.sqlStatements.some(statement => statement.includes('SELECT * FROM "user"'))).toBe(false);
    });

    test("honors findMany sort and offset across stable pages", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");
        for (const [id, name] of [
            ["sorted-user-d", "Delta"],
            ["sorted-user-a", "Alpha"],
            ["sorted-user-c", "Charlie"],
            ["sorted-user-b", "Bravo"],
        ] as const) {
            await adapter.create({
                model: "user",
                forceAllowId: true,
                data: {
                    id,
                    name,
                    email: `${id}@example.com`,
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                },
            });
        }
        harness.sqlStatements.length = 0;

        const firstPage = await adapter.findMany<Record<string, unknown>>({
            model: "user",
            limit: 2,
            offset: 0,
            sortBy: { field: "name", direction: "asc" },
        });
        const secondPage = await adapter.findMany<Record<string, unknown>>({
            model: "user",
            limit: 2,
            offset: 2,
            sortBy: { field: "name", direction: "asc" },
        });
        const descendingMiddle = await adapter.findMany<Record<string, unknown>>({
            model: "user",
            limit: 2,
            offset: 1,
            sortBy: { field: "name", direction: "desc" },
        });
        const offsetWithoutSort = await adapter.findMany<Record<string, unknown>>({
            model: "user",
            limit: 2,
            offset: 1,
        });

        expect(firstPage.map(row => row.name)).toEqual(["Alpha", "Bravo"]);
        expect(secondPage.map(row => row.name)).toEqual(["Charlie", "Delta"]);
        expect(descendingMiddle.map(row => row.name)).toEqual(["Charlie", "Bravo"]);
        expect(offsetWithoutSort.map(row => row.id)).toEqual(["sorted-user-b", "sorted-user-c"]);
        expect(harness.sqlStatements).toContain(
            'SELECT * FROM "user" WHERE 1=1 ORDER BY "name" ASC, "id" ASC LIMIT ? OFFSET ?'
        );
        expect(harness.sqlStatements).toContain(
            'SELECT * FROM "user" WHERE 1=1 ORDER BY "name" DESC, "id" ASC LIMIT ? OFFSET ?'
        );
        expect(harness.sqlStatements).toContain('SELECT * FROM "user" WHERE 1=1 ORDER BY "id" ASC LIMIT ? OFFSET ?');
    });

    test("uses id as a stable tie-breaker across sorted pages", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");
        for (const id of ["tied-user-d", "tied-user-a", "tied-user-c", "tied-user-b"] as const) {
            await adapter.create({
                model: "user",
                forceAllowId: true,
                data: {
                    id,
                    name: "Tied",
                    email: `${id}@example.com`,
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                },
            });
        }

        const firstPage = await adapter.findMany<Record<string, unknown>>({
            model: "user",
            where: eq("name", "Tied"),
            limit: 2,
            offset: 0,
            sortBy: { field: "name", direction: "asc" },
        });
        const secondPage = await adapter.findMany<Record<string, unknown>>({
            model: "user",
            where: eq("name", "Tied"),
            limit: 2,
            offset: 2,
            sortBy: { field: "name", direction: "asc" },
        });

        expect(firstPage.map(row => row.id)).toEqual(["tied-user-a", "tied-user-b"]);
        expect(secondPage.map(row => row.id)).toEqual(["tied-user-c", "tied-user-d"]);
    });

    test("routes adapter counts to countAuth without falling back to queryAuth", async () => {
        const requests: Array<{ model: string; where: Record<string, unknown> }> = [];
        const catalog = {
            async countAuth(request: { model: string; where: Record<string, unknown> }) {
                requests.push(request);
                return 7;
            },
            async queryAuth() {
                throw new Error("count must not materialize auth rows");
            },
        };
        const namespace = {
            idFromName: () => "global",
            get: () => catalog,
        } as unknown as DurableObjectNamespace;
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespace } })(auth.options);

        await expect(adapter.count({ model: "user", where: eq("name", "Counted") })).resolves.toBe(7);
        expect(requests).toEqual([{ model: "user", where: { name: "Counted" } }]);
    });

    test("updates and deletes through non-owner lookups while preserving epoch bumps", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");

        await adapter.create({
            model: "user",
            forceAllowId: true,
            data: {
                id: "user-2",
                name: "Before",
                email: "update@example.com",
                emailVerified: false,
                createdAt: now,
                updatedAt: now,
            },
        });
        const updated = await adapter.update({
            model: "user",
            where: eq("email", "update@example.com"),
            update: { name: "After" },
        });
        expect(updated).toMatchObject({ id: "user-2", name: "After" });

        await adapter.create({
            model: "session",
            forceAllowId: true,
            data: {
                id: "session-2",
                token: "delete-token",
                userId: "user-2",
                expiresAt: now,
                createdAt: now,
                updatedAt: now,
            },
        });
        await adapter.delete({ model: "session", where: eq("token", "delete-token") });
        expect(await adapter.findOne({ model: "session", where: eq("token", "delete-token") })).toBeNull();
        expect(harness.catalog.authEpoch({ principalId: "user-2" as never }).principal).toBe(4);
    });

    test("rolls back an auth row when its atomic epoch bump fails", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        harness.db.run(`CREATE TRIGGER fail_auth_epoch
            BEFORE UPDATE ON catalog_epoch
            WHEN NEW.scope = 'auth_principal'
            BEGIN SELECT RAISE(ABORT, 'forced epoch failure'); END`);
        const now = new Date("2026-08-23T00:00:00Z");

        await expect(
            adapter.create({
                model: "user",
                forceAllowId: true,
                data: {
                    id: "rollback-user",
                    name: "Rollback",
                    email: "rollback@example.com",
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                },
            })
        ).rejects.toThrow("forced epoch failure");
        expect(await adapter.findOne({ model: "user", where: eq("email", "rollback@example.com") })).toBeNull();
        expect(harness.catalog.authEpoch({ principalId: "rollback-user" as never }).principal).toBe(0);
    });

    test("updateMany bumps every affected principal before returning", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");
        for (const id of ["batch-user-1", "batch-user-2"]) {
            await adapter.create({
                model: "user",
                forceAllowId: true,
                data: {
                    id,
                    name: "Before",
                    email: `${id}@example.com`,
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                    role: "batch",
                },
            });
        }

        expect(await adapter.updateMany({ model: "user", where: eq("role", "batch"), update: { name: "After" } })).toBe(
            2
        );
        expect(await adapter.findMany({ model: "user", where: eq("name", "After") })).toHaveLength(2);
        expect(harness.catalog.authEpoch({ principalId: "batch-user-1" as never }).principal).toBe(2);
        expect(harness.catalog.authEpoch({ principalId: "batch-user-2" as never }).principal).toBe(2);
    });

    test("rejects a 4097-row auth update before the row or epoch write", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const insert = harness.db.prepare(
            'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)'
        );
        harness.db.transaction(() => {
            for (let index = 0; index <= AUTH_BULK_PRELOAD_MAX_ROWS; index++) {
                insert.run(
                    `bulk-over-${index}`,
                    "Bulk row cap",
                    `bulk-over-${index}@example.com`,
                    1,
                    1_777_000_000_000,
                    1_777_000_000_000
                );
            }
        })();
        harness.sqlStatements.length = 0;

        await expect(
            adapter.updateMany({ model: "user", where: eq("name", "Bulk row cap"), update: { name: "Changed" } })
        ).rejects.toMatchObject({ code: "CDB_RATE_LIMITED", retryable: true });
        expect(harness.db.query('SELECT COUNT(*) AS count FROM "user" WHERE "name" = ?').get("Changed")).toEqual({
            count: 0,
        });
        expect(harness.sqlStatements.some(statement => statement.startsWith('UPDATE "user"'))).toBe(false);
        expect(harness.sqlStatements.some(statement => statement.startsWith("UPDATE catalog_epoch"))).toBe(false);
        expect(harness.catalog.authEpoch({ principalId: "bulk-over-0" as never }).principal).toBe(0);
    });

    test("rejects excess stored and replacement scope bytes before auth writes", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const oversizedId = "s".repeat(AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES + 1);
        harness.db
            .prepare(
                'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)'
            )
            .run(oversizedId, "Bulk byte cap", "bulk-byte-cap@example.com", 1, 1_777_000_000_000, 1_777_000_000_000);
        await adapter.create({
            model: "user",
            forceAllowId: true,
            data: {
                id: "replacement-byte-user",
                name: "Before",
                email: "replacement-byte-user@example.com",
                emailVerified: true,
                createdAt: new Date("2026-08-23T00:00:00Z"),
                updatedAt: new Date("2026-08-23T00:00:00Z"),
            },
        });
        harness.sqlStatements.length = 0;

        await expect(
            adapter.updateMany({ model: "user", where: eq("name", "Bulk byte cap"), update: { name: "Changed" } })
        ).rejects.toMatchObject({ code: "CDB_RATE_LIMITED", retryable: true });
        await expect(adapter.deleteMany({ model: "user", where: eq("name", "Bulk byte cap") })).rejects.toMatchObject({
            code: "CDB_RATE_LIMITED",
            retryable: true,
        });
        await expect(
            harness.catalog.mutateAuth({
                model: "user",
                op: "update",
                where: { id: "replacement-byte-user" },
                payload: { id: "n".repeat(AUTH_BULK_PRELOAD_MAX_SCOPE_BYTES) },
                returnRow: false,
            })
        ).rejects.toMatchObject({ code: "CDB_RATE_LIMITED", retryable: true });
        expect(harness.db.query('SELECT "name" FROM "user" WHERE "id" = ?').get(oversizedId)).toEqual({
            name: "Bulk byte cap",
        });
        expect(harness.db.query('SELECT "name" FROM "user" WHERE "id" = ?').get("replacement-byte-user")).toEqual({
            name: "Before",
        });
        expect(harness.sqlStatements.some(statement => statement.startsWith('UPDATE "user"'))).toBe(false);
        expect(harness.sqlStatements.some(statement => statement.startsWith('DELETE FROM "user"'))).toBe(false);
        expect(harness.sqlStatements.some(statement => statement.startsWith("UPDATE catalog_epoch"))).toBe(false);
        expect(harness.catalog.authEpoch({ principalId: oversizedId as never }).principal).toBe(0);
    });

    test("updateMany preloads only narrow scope columns and skips a full-row reread", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        await adapter.create({
            model: "user",
            forceAllowId: true,
            data: {
                id: "wide-bulk-user",
                name: "Before",
                email: "wide-bulk-user@example.com",
                emailVerified: true,
                image: "w".repeat(1_024 * 1_024),
                createdAt: new Date("2026-08-23T00:00:00Z"),
                updatedAt: new Date("2026-08-23T00:00:00Z"),
            },
        });
        harness.sqlStatements.length = 0;

        await expect(
            adapter.updateMany({
                model: "user",
                where: eq("email", "wide-bulk-user@example.com"),
                update: { name: "After" },
            })
        ).resolves.toBe(1);
        const userSelects = harness.sqlStatements.filter(
            statement => statement.startsWith("SELECT") && statement.includes('FROM "user"')
        );
        expect(userSelects).toHaveLength(2);
        expect(userSelects.every(statement => !statement.includes('"image"'))).toBe(true);
        expect(userSelects.every(statement => !statement.includes("SELECT *"))).toBe(true);
        expect(harness.catalog.authEpoch({ principalId: "wide-bulk-user" as never }).principal).toBe(2);
    });

    test("rejects expanded non-scope replacements before base or epoch writes", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        await adapter.create({
            model: "user",
            forceAllowId: true,
            data: {
                id: "replacement-expansion-user",
                name: "Before",
                email: "replacement-expansion-user@example.com",
                emailVerified: true,
                image: "before",
                createdAt: new Date("2026-08-23T00:00:00Z"),
                updatedAt: new Date("2026-08-23T00:00:00Z"),
            },
        });
        const epochBefore = harness.catalog.authEpoch({ principalId: "replacement-expansion-user" as never });
        harness.sqlStatements.length = 0;

        await expect(
            adapter.updateMany({
                model: "user",
                where: eq("id", "replacement-expansion-user"),
                update: { image: "x".repeat(AUTH_BULK_REPLACEMENT_MAX_BYTES + 1) },
            })
        ).rejects.toMatchObject({ code: "CDB_RATE_LIMITED", retryable: true });
        expect(harness.db.query('SELECT "image" FROM "user" WHERE "id" = ?').get("replacement-expansion-user")).toEqual(
            { image: "before" }
        );
        expect(harness.sqlStatements.some(statement => statement.startsWith('UPDATE "user"'))).toBe(false);
        expect(harness.sqlStatements.some(statement => statement.startsWith("UPDATE catalog_epoch"))).toBe(false);
        expect(harness.catalog.authEpoch({ principalId: "replacement-expansion-user" as never })).toEqual(epochBefore);
    });

    test("updateMany bumps every tenant and principal touched by membership rows", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");
        for (const suffix of ["1", "2"]) {
            const userId = `batch-member-user-${suffix}`;
            const organizationId = `batch-member-org-${suffix}`;
            await adapter.create({
                model: "user",
                forceAllowId: true,
                data: {
                    id: userId,
                    name: userId,
                    email: `${userId}@example.com`,
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                },
            });
            await adapter.create({
                model: "organization",
                forceAllowId: true,
                data: { id: organizationId, name: organizationId, slug: organizationId, createdAt: now },
            });
            await adapter.create({
                model: "member",
                forceAllowId: true,
                data: {
                    id: `batch-member-${suffix}`,
                    organizationId,
                    userId,
                    role: "pending-batch",
                    createdAt: now,
                },
            });
        }
        const before = ["1", "2"].map(suffix =>
            harness.catalog.authEpoch({
                tenantId: `batch-member-org-${suffix}` as never,
                principalId: `batch-member-user-${suffix}` as never,
            })
        );

        expect(
            await adapter.updateMany({
                model: "member",
                where: eq("role", "pending-batch"),
                update: { role: "member" },
            })
        ).toBe(2);
        for (const [index, suffix] of ["1", "2"].entries()) {
            const after = harness.catalog.authEpoch({
                tenantId: `batch-member-org-${suffix}` as never,
                principalId: `batch-member-user-${suffix}` as never,
            });
            expect(after.tenant).toBe((before[index]?.tenant ?? 0) + 1);
            expect(after.principal).toBe((before[index]?.principal ?? 0) + 1);
        }
    });

    test("moving a membership bumps every old and new tenant and principal scope", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");
        for (const id of ["move-user-1", "move-user-2"]) {
            await adapter.create({
                model: "user",
                forceAllowId: true,
                data: {
                    id,
                    name: id,
                    email: `${id}@example.com`,
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                },
            });
        }
        for (const id of ["move-org-1", "move-org-2"]) {
            await adapter.create({
                model: "organization",
                forceAllowId: true,
                data: { id, name: id, slug: id, createdAt: now },
            });
        }
        await adapter.create({
            model: "member",
            forceAllowId: true,
            data: {
                id: "moving-member",
                organizationId: "move-org-1",
                userId: "move-user-1",
                role: "member",
                createdAt: now,
            },
        });

        const beforeOld = harness.catalog.authEpoch({
            tenantId: "move-org-1" as never,
            principalId: "move-user-1" as never,
        });
        const beforeNew = harness.catalog.authEpoch({
            tenantId: "move-org-2" as never,
            principalId: "move-user-2" as never,
        });
        expect(
            await adapter.update({
                model: "member",
                where: eq("id", "moving-member"),
                update: { organizationId: "move-org-2", userId: "move-user-2" },
            })
        ).toMatchObject({ organizationId: "move-org-2", userId: "move-user-2" });

        const afterOld = harness.catalog.authEpoch({
            tenantId: "move-org-1" as never,
            principalId: "move-user-1" as never,
        });
        const afterNew = harness.catalog.authEpoch({
            tenantId: "move-org-2" as never,
            principalId: "move-user-2" as never,
        });
        expect(afterOld.tenant).toBe(beforeOld.tenant + 1);
        expect(afterOld.principal).toBe(beforeOld.principal + 1);
        expect(afterNew.tenant).toBe(beforeNew.tenant + 1);
        expect(afterNew.principal).toBe(beforeNew.principal + 1);
    });

    test("a restarted Catalog instance reads rows from the same durable storage", async () => {
        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");
        await adapter.create({
            model: "user",
            forceAllowId: true,
            data: {
                id: "restart-user",
                name: "Restart",
                email: "restart@example.com",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
            },
        });

        await harness.restart();
        const restartedAdapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);

        expect(
            await restartedAdapter.findOne({ model: "user", where: eq("email", "restart@example.com") })
        ).toMatchObject({ id: "restart-user" });
    });

    test("module initialization binds auth before the first Catalog bootstrap", async () => {
        harness.close();
        chardb({ schema: {}, auth });
        resetAuthRuntime();

        // A fresh Worker or DO isolate evaluates the application module
        // again. This second factory call models that evaluation: no fetch,
        // schema getter, or adapter request runs before Catalog construction.
        chardb({ schema: {}, auth });
        harness = new CatalogHarness();
        await harness.ready();

        const adapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        const now = new Date("2026-08-23T00:00:00Z");
        await adapter.create({
            model: "user",
            forceAllowId: true,
            data: {
                id: "first-user",
                name: "First",
                email: "first@example.com",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
            },
        });
        await adapter.create({
            model: "session",
            forceAllowId: true,
            data: {
                id: "first-session",
                token: "first-request-token",
                userId: "first-user",
                expiresAt: now,
                createdAt: now,
                updatedAt: now,
            },
        });

        await harness.restart();
        const restartedAdapter = chardbAuthAdapter({ env: { CDB_CATALOG: namespaceFor(harness) } })(auth.options);
        expect(
            await restartedAdapter.findOne({ model: "session", where: eq("token", "first-request-token") })
        ).toMatchObject({ id: "first-session", userId: "first-user" });
    });

    test("Catalog rejects a legacy auth table instead of pretending CREATE IF NOT EXISTS upgraded it", async () => {
        harness.close();
        harness = new CatalogHarness(db => {
            db.run('CREATE TABLE "user" ("id" TEXT PRIMARY KEY, "email" TEXT)');
        });

        await expect(harness.ready()).rejects.toMatchObject({
            code: "CDB_AUTH_PROFILE_INCOMPATIBLE",
            message: expect.stringContaining("predates auth DDL v1"),
        });
    });

    test("Catalog keeps tenant and principal epochs independent across restart", async () => {
        expect(harness.catalog.bumpAuthEpoch("tenant", "tenant-a")).toBe(1);
        expect(harness.catalog.bumpAuthEpoch("tenant", "tenant-b")).toBe(1);
        expect(harness.catalog.bumpAuthEpoch("principal", "user-a")).toBe(1);
        expect(harness.catalog.bumpAuthEpoch("principal", "user-b")).toBe(1);
        expect(harness.catalog.bumpAuthEpoch("tenant", "tenant-a")).toBe(2);
        expect(harness.catalog.bumpAuthEpoch("principal", "user-b")).toBe(2);

        await harness.restart();
        expect(harness.catalog.authEpoch({ tenantId: "tenant-a" as never, principalId: "user-a" as never })).toEqual({
            global: 1,
            tenant: 2,
            principal: 1,
        });
        expect(harness.catalog.authEpoch({ tenantId: "tenant-b" as never, principalId: "user-b" as never })).toEqual({
            global: 1,
            tenant: 1,
            principal: 2,
        });
    });

    test("derives canonical organization roles and current epochs from Catalog rows", async () => {
        const nowMs = Date.parse("2026-08-23T00:00:00Z");
        await harness.catalog.mutateAuth({
            model: "user",
            op: "create",
            payload: {
                id: "authority-user",
                name: "Authority User",
                email: "authority@example.com",
                emailVerified: true,
                createdAt: nowMs,
                updatedAt: nowMs,
            },
        });
        await harness.catalog.mutateAuth({
            model: "organization",
            op: "create",
            payload: { id: "authority-org", name: "Authority Org", slug: "authority", createdAt: nowMs },
        });
        await harness.catalog.mutateAuth({
            model: "member",
            op: "create",
            payload: {
                id: "authority-member",
                organizationId: "authority-org",
                userId: "authority-user",
                role: " member,admin, member ,owner ",
                createdAt: nowMs,
            },
        });

        expect(
            await harness.catalog.resolveOrganizationAuthority({
                principalId: PrincipalId("authority-user"),
                organizationId: TenantId("authority-org"),
            })
        ).toEqual({
            principalId: PrincipalId("authority-user"),
            organizationId: TenantId("authority-org"),
            role: "admin,member,owner",
            roles: ["admin", "member", "owner"],
            authEpochs: { global: 1, tenant: 2, principal: 2 },
        });
    });

    test("isolates organizations and returns null for missing or revoked membership", async () => {
        const nowMs = Date.parse("2026-08-23T00:00:00Z");
        for (const organizationId of ["isolation-org-a", "isolation-org-b"]) {
            await harness.catalog.mutateAuth({
                model: "organization",
                op: "create",
                payload: { id: organizationId, name: organizationId, slug: organizationId, createdAt: nowMs },
            });
        }
        await harness.catalog.mutateAuth({
            model: "user",
            op: "create",
            payload: {
                id: "isolation-user",
                name: "Isolation User",
                email: "isolation@example.com",
                emailVerified: true,
                createdAt: nowMs,
                updatedAt: nowMs,
            },
        });

        const request = {
            principalId: PrincipalId("isolation-user"),
            organizationId: TenantId("isolation-org-a"),
        };
        expect(await harness.catalog.resolveOrganizationAuthority(request)).toBeNull();
        await harness.catalog.mutateAuth({
            model: "member",
            op: "create",
            payload: {
                id: "isolation-member",
                organizationId: "isolation-org-a",
                userId: "isolation-user",
                role: "member",
                createdAt: nowMs,
            },
        });
        expect(
            await harness.catalog.resolveOrganizationAuthority({
                ...request,
                organizationId: TenantId("isolation-org-b"),
            })
        ).toBeNull();
        await harness.catalog.mutateAuth({
            model: "member",
            op: "delete",
            where: { id: "isolation-member" },
        });
        expect(await harness.catalog.resolveOrganizationAuthority(request)).toBeNull();
    });

    test("reflects membership role changes and their tenant/principal epoch bumps", async () => {
        const nowMs = Date.parse("2026-08-23T00:00:00Z");
        await harness.catalog.mutateAuth({
            model: "user",
            op: "create",
            payload: {
                id: "role-user",
                name: "Role User",
                email: "role@example.com",
                emailVerified: true,
                createdAt: nowMs,
                updatedAt: nowMs,
            },
        });
        await harness.catalog.mutateAuth({
            model: "organization",
            op: "create",
            payload: { id: "role-org", name: "Role Org", slug: "role-org", createdAt: nowMs },
        });
        await harness.catalog.mutateAuth({
            model: "member",
            op: "create",
            payload: {
                id: "role-member",
                organizationId: "role-org",
                userId: "role-user",
                role: "member",
                createdAt: nowMs,
            },
        });
        await harness.catalog.mutateAuth({
            model: "member",
            op: "update",
            where: { id: "role-member" },
            payload: { role: "owner, admin" },
        });

        expect(
            await harness.catalog.resolveOrganizationAuthority({
                principalId: PrincipalId("role-user"),
                organizationId: TenantId("role-org"),
            })
        ).toMatchObject({
            role: "admin,owner",
            roles: ["admin", "owner"],
            authEpochs: { global: 1, tenant: 3, principal: 3 },
        });
    });

    test("fails closed when the organization authority models are unavailable", async () => {
        const fullSchema = synthesizeAuthSchema(auth.options as never) as Record<string, unknown>;
        for (const missingModel of ["organization", "member"]) {
            harness.close();
            const incompleteSchema = Object.fromEntries(
                Object.entries(fullSchema).filter(([model]) => model !== missingModel)
            );
            resetAuthRuntime();
            bindAuthRuntime({
                schema: incompleteSchema as never,
                options: auth.options as { readonly [key: string]: unknown },
            });
            harness = new CatalogHarness();
            await harness.ready();

            expect(
                await harness.catalog.resolveOrganizationAuthority({
                    principalId: PrincipalId("any-user"),
                    organizationId: TenantId("any-org"),
                })
            ).toBeNull();
        }
    });
});
