import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { organization } from "better-auth/plugins/organization";
import { describeSqliteTableDdl, renderSqliteTableDdl, renderSqliteTableDdlDescriptor } from "../../src/auth/ddl.ts";
import { defineAuth, synthesizeAuthSchema } from "../../src/auth/synthesize.ts";

function install(schema: Record<string, unknown>): Database {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    for (const table of Object.values(schema)) {
        const ddl = renderSqliteTableDdl(table as never);
        db.run(ddl.createTable);
        for (const statement of ddl.indexes) db.run(statement);
    }
    return db;
}

function schemaFor(options = defineAuth({ plugins: [organization()] }).options): Record<string, unknown> {
    return synthesizeAuthSchema(options as never) as unknown as Record<string, unknown>;
}

function indexColumns(db: Database, table: string, unique?: boolean): string[][] {
    const indexes = db.query(`PRAGMA index_list("${table}")`).all() as { name: string; unique: number }[];
    return indexes
        .filter(index => unique === undefined || index.unique === Number(unique))
        .map(index => {
            const escaped = index.name.replaceAll('"', '""');
            const rows = db.query(`PRAGMA index_info("${escaped}")`).all() as { name: string; seqno: number }[];
            return rows.sort((a, b) => a.seqno - b.seqno).map(row => row.name);
        });
}

describe("auth SQLite DDL", () => {
    test("renders the existing byte-exact DDL through one static descriptor", () => {
        const table = schemaFor().session as never;
        const descriptor = describeSqliteTableDdl(table);
        const direct = renderSqliteTableDdl(table);
        const staticRender = renderSqliteTableDdlDescriptor(descriptor);

        expect(staticRender).toEqual(direct);
        expect(descriptor.tableName).toBe("session");
        expect(descriptor.columns.map(column => column.name)).toEqual([
            "id",
            "expiresAt",
            "token",
            "createdAt",
            "updatedAt",
            "ipAddress",
            "userAgent",
            "userId",
            "activeOrganizationId",
        ]);
        expect(direct.createTable).toStartWith(
            'CREATE TABLE "session" ("id" text PRIMARY KEY NOT NULL, "expiresAt" integer NOT NULL'
        );
        expect(direct.indexes).toEqual(descriptor.indexes.map(index => index.sql));
    });

    test("executes core and organization DDL with columns, defaults, FKs, and indexes intact", () => {
        const db = install(schemaFor());

        const userColumns = db.query('PRAGMA table_info("user")').all() as {
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
        }[];
        expect(userColumns.find(column => column.name === "id")).toMatchObject({ type: "TEXT", notnull: 1, pk: 1 });
        expect(userColumns.find(column => column.name === "emailVerified")).toMatchObject({
            type: "INTEGER",
            notnull: 1,
            dflt_value: "0",
        });
        expect(userColumns.find(column => column.name === "createdAt")?.dflt_value).toContain("unixepoch()");

        const memberColumns = db.query('PRAGMA table_info("member")').all() as {
            name: string;
            dflt_value: string | null;
        }[];
        expect(memberColumns.find(column => column.name === "role")?.dflt_value).toBe("'member'");

        expect(indexColumns(db, "user", true)).toContainEqual(["email"]);
        expect(indexColumns(db, "session", true)).toContainEqual(["token"]);
        expect(indexColumns(db, "account", true)).toContainEqual(["providerId", "accountId"]);
        expect(indexColumns(db, "member", true)).toContainEqual(["organizationId", "userId"]);
        expect(indexColumns(db, "session", false)).toContainEqual(["userId"]);
        expect(indexColumns(db, "member", false)).toEqual(expect.arrayContaining([["organizationId"], ["userId"]]));

        const sessionFks = db.query('PRAGMA foreign_key_list("session")').all() as {
            table: string;
            from: string;
            to: string;
            on_delete: string;
        }[];
        expect(sessionFks).toContainEqual(
            expect.objectContaining({ table: "user", from: "userId", to: "id", on_delete: "CASCADE" })
        );
        const memberFks = db.query('PRAGMA foreign_key_list("member")').all() as {
            table: string;
            from: string;
            to: string;
        }[];
        expect(memberFks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ table: "organization", from: "organizationId", to: "id" }),
                expect.objectContaining({ table: "user", from: "userId", to: "id" }),
            ])
        );
        db.close();
    });

    test("rejects duplicate identities, sessions, provider accounts, memberships, and broken FKs", () => {
        const db = install(schemaFor());
        db.run(`INSERT INTO "user" ("id", "name", "email") VALUES ('u1', 'One', 'one@example.com')`);
        db.run(`INSERT INTO "user" ("id", "name", "email") VALUES ('u2', 'Two', 'two@example.com')`);
        expect(() =>
            db.run(`INSERT INTO "user" ("id", "name", "email") VALUES ('u3', 'Three', 'one@example.com')`)
        ).toThrow();

        db.run(
            `INSERT INTO "session" ("id", "expiresAt", "token", "updatedAt", "userId") VALUES ('s1', 1, 'token', 1, 'u1')`
        );
        expect(() =>
            db.run(
                `INSERT INTO "session" ("id", "expiresAt", "token", "updatedAt", "userId") VALUES ('s2', 1, 'token', 1, 'u2')`
            )
        ).toThrow();
        expect(() =>
            db.run(
                `INSERT INTO "session" ("id", "expiresAt", "token", "updatedAt", "userId") VALUES ('s3', 1, 'other', 1, 'missing')`
            )
        ).toThrow();

        db.run(
            `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "updatedAt") VALUES ('a1', 'external', 'github', 'u1', 1)`
        );
        expect(() =>
            db.run(
                `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "updatedAt") VALUES ('a2', 'external', 'github', 'u2', 1)`
            )
        ).toThrow();

        db.run(`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('o1', 'Org', 'org', 1)`);
        db.run(`INSERT INTO "member" ("id", "organizationId", "userId", "createdAt") VALUES ('m1', 'o1', 'u1', 1)`);
        expect(() =>
            db.run(`INSERT INTO "member" ("id", "organizationId", "userId", "createdAt") VALUES ('m2', 'o1', 'u1', 1)`)
        ).toThrow();
        db.close();
    });

    test("composite constraints and indexes follow renamed models and fields", () => {
        const auth = defineAuth({
            account: {
                modelName: "oauth_accounts",
                fields: {
                    accountId: "external_account",
                    providerId: "provider",
                    userId: "owner_id",
                },
            },
            plugins: [
                organization({
                    schema: {
                        member: {
                            modelName: "org_members",
                            fields: { organizationId: "org_id", userId: "person_id" },
                        },
                    },
                }),
            ],
        });
        const db = install(schemaFor(auth.options));

        expect(indexColumns(db, "oauth_accounts", true)).toContainEqual(["provider", "external_account"]);
        expect(indexColumns(db, "oauth_accounts", false)).toContainEqual(["owner_id"]);
        expect(indexColumns(db, "org_members", true)).toContainEqual(["org_id", "person_id"]);
        expect(indexColumns(db, "org_members", false)).toEqual(expect.arrayContaining([["org_id"], ["person_id"]]));
        db.close();
    });

    test("rejects an unknown dynamic default instead of inventing SQL semantics", () => {
        expect(() =>
            synthesizeAuthSchema({
                plugins: [
                    {
                        id: "dynamic-default-test",
                        schema: {
                            nonce: {
                                modelName: "nonce",
                                fields: {
                                    value: { type: "number", required: true, defaultValue: () => 42 },
                                },
                            },
                        },
                    } as never,
                ],
            })
        ).toThrow("cannot translate dynamic default for nonce.value");
    });
});
