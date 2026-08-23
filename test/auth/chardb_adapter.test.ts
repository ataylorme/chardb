import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chardbAuthAdapter } from "../../src/auth/chardb_adapter.ts";
import { bindAuthRuntime, resetAuthRuntime } from "../../src/auth/runtime.ts";
import { defineAuth, synthesizeAuthSchema } from "../../src/auth/synthesize.ts";
import { chardb } from "../../src/server/chardb.ts";
import { Catalog } from "../../src/server/do/catalog.ts";

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

class CatalogHarness {
    readonly db: Database;
    private bootstrap: Promise<unknown> = Promise.resolve();
    private readonly state: DurableObjectState;
    catalog: Catalog;

    constructor(prepare?: (db: Database) => void) {
        this.db = new Database(":memory:");
        prepare?.(this.db);
        this.state = {
            storage: {
                sql: sqlStorage(this.db),
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
        const bumps: string[] = [];
        const adapter = chardbAuthAdapter({
            env: { CDB_CATALOG: namespaceFor(harness) },
            dispatcher: {
                bumpGlobal: async () => {
                    bumps.push("global");
                },
                bumpTenant: async id => {
                    bumps.push(`tenant:${id}`);
                },
                bumpPrincipal: async id => {
                    bumps.push(`principal:${id}`);
                },
            },
        })(auth.options);
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
        expect(bumps).toEqual([
            "principal:user-1",
            "principal:user-1",
            "principal:user-1",
            "tenant:org-1",
            "tenant:org-1",
        ]);
    });

    test("updates and deletes through non-owner lookups while preserving epoch bumps", async () => {
        const bumps: string[] = [];
        const adapter = chardbAuthAdapter({
            env: { CDB_CATALOG: namespaceFor(harness) },
            dispatcher: {
                bumpGlobal: async () => {
                    bumps.push("global");
                },
                bumpTenant: async id => {
                    bumps.push(`tenant:${id}`);
                },
                bumpPrincipal: async id => {
                    bumps.push(`principal:${id}`);
                },
            },
        })(auth.options);
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
        expect(bumps).toEqual(["principal:user-2", "principal:user-2", "principal:user-2", "principal:user-2"]);
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
});
