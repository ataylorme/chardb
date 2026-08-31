import { describe, expect, test } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineAuth } from "../../src/auth/synthesize.ts";
import {
    CDB_FILE_MAX_BYTES,
    type FileColumnConfig,
    FileId,
    file,
    getChardbFileColumnConfig,
    normalizeFileColumnConfig,
} from "../../src/files/index.ts";
import { forOrg, forUser } from "../../src/server/cdb-tenant.ts";
import {
    assertSchemaResourceJournal,
    collectSchemaResourceDescriptors,
} from "../../src/server/resource-descriptors.ts";
import { defineMigrations, defineSchemaBaseline } from "../../src/server/schema-migrations.ts";

const organization = sqliteTable("organization", { id: text("id").primaryKey() });
const user = sqliteTable("user", { id: text("id").primaryKey() });

function organizationFiles(
    config: FileColumnConfig = { maxSize: 2_048, contentTypes: ["image/png", "application/pdf"] }
) {
    const { cdbTable } = forOrg();
    return cdbTable(
        "file_messages",
        {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => organization.id),
            attachment: file("attachment", config),
        },
        { roles: { member: { read: "*" } } }
    );
}

describe("private organization file schema contract", () => {
    test("stores one branded opaque id and normalizes resource identity", () => {
        const table = organizationFiles();
        const id = FileId("fil_01K3H9R5P2N8Q4Y7V6W1X0ZABC");

        expect(table.attachment.mapToDriverValue(id)).toBe(id);
        expect(table.attachment.mapFromDriverValue(id)).toBe(id);
        expect(getChardbFileColumnConfig(table.attachment)).toEqual({
            maxSize: 2_048,
            contentTypes: ["application/pdf", "image/png"],
        });
        expect(collectSchemaResourceDescriptors({ messages: table })).toEqual([
            {
                kind: "file",
                version: 1,
                table: "file_messages",
                column: "attachment",
                primaryKey: "id",
                organizationColumn: "organization_id",
                maxSize: 2_048,
                contentTypes: ["application/pdf", "image/png"],
            },
        ]);
        expect(() => FileId("bucket/key")).toThrow(/invalid Chardb FileId/);
    });

    test("bounds file configuration before it reaches a migration", () => {
        expect(normalizeFileColumnConfig(undefined)).toEqual({ maxSize: CDB_FILE_MAX_BYTES, contentTypes: "*" });
        expect(() => normalizeFileColumnConfig({ maxSize: CDB_FILE_MAX_BYTES + 1 })).toThrow(/maxSize/);
        expect(() => normalizeFileColumnConfig({ contentTypes: [] })).toThrow(/contentTypes/);
        expect(() => normalizeFileColumnConfig({ contentTypes: ["IMAGE/PNG", "image/png"] })).toThrow(/unique/);
        expect(() => normalizeFileColumnConfig({ contentTypes: ["not a mime"] })).toThrow(/valid MIME/);
    });

    test("binds normalized descriptors into the exact migration digest", () => {
        const auth = defineAuth({});
        const first = defineSchemaBaseline({
            version: 1,
            name: "files",
            domainSchema: { messages: organizationFiles() },
            authOptions: auth.options,
        });
        const same = defineSchemaBaseline({
            version: 1,
            name: "files",
            domainSchema: {
                messages: organizationFiles({ contentTypes: ["application/pdf", "image/png"], maxSize: 2_048 }),
            },
            authOptions: auth.options,
        });
        const changed = defineSchemaBaseline({
            version: 1,
            name: "files",
            domainSchema: { messages: organizationFiles({ contentTypes: ["image/png"], maxSize: 2_048 }) },
            authOptions: auth.options,
        });

        const firstJournal = defineMigrations([first]);
        expect(first.resources).toEqual(same.resources);
        expect(firstJournal.digest).toBe(defineMigrations([same]).digest);
        expect(firstJournal.digest).not.toBe(defineMigrations([changed]).digest);
        expect(Object.isFrozen(firstJournal.migrations[0]?.resources)).toBe(true);
        expect(() =>
            assertSchemaResourceJournal({ messages: organizationFiles() }, firstJournal.migrations)
        ).not.toThrow();
        expect(() => assertSchemaResourceJournal({ messages: organizationFiles() }, [])).toThrow(
            /do not match the packaged migration journal/
        );
        expect(() => assertSchemaResourceJournal({}, firstJournal.migrations)).toThrow(
            /do not match the packaged migration journal/
        );
    });

    test("fails closed outside the V1 organization, nullable, scalar-key shape", () => {
        const { cdbTable: userTable } = forUser();
        const userFiles = userTable("user_files", {
            id: text("id").primaryKey(),
            userId: text("user_id")
                .notNull()
                .references(() => user.id),
            attachment: file("attachment"),
        });
        expect(() => collectSchemaResourceDescriptors({ userFiles })).toThrow(/organization tenancy/);

        const { cdbTable } = forOrg();
        const required = cdbTable("required_files", {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => organization.id),
            attachment: file("attachment").notNull(),
        });
        expect(() => collectSchemaResourceDescriptors({ required })).toThrow(/nullable/);

        const composite = cdbTable("composite_file_rows", {
            left: text("left").primaryKey(),
            right: text("right").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => organization.id),
            attachment: file("attachment"),
        });
        expect(() => collectSchemaResourceDescriptors({ composite })).toThrow(/scalar primary key/);

        const datePrimary = cdbTable("date_primary_files", {
            id: integer("id", { mode: "timestamp" }).primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => organization.id),
            attachment: file("attachment"),
        });
        expect(() => collectSchemaResourceDescriptors({ datePrimary })).toThrow(/primary key must be a string/);
    });
});
