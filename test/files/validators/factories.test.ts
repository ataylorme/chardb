import { describe, expect, test } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { file } from "../../../src/files/index.ts";

const docs = sqliteTable("docs", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    views: integer("views").notNull(),
    attachment: file("attachment").notNull(),
});

const sampleRow = {
    id: "01HX0",
    title: "hello",
    views: 7,
    attachment: "01J0QZ8K0F8YQTBVT2N5N0F0FA",
};

function canResolve(spec: string): boolean {
    try {
        require.resolve(spec);
        return true;
    } catch {
        return false;
    }
}

const hasZod = canResolve("drizzle-zod") && canResolve("zod");
const hasTypebox = canResolve("drizzle-typebox") && canResolve("@sinclair/typebox");
const hasValibot = canResolve("drizzle-valibot") && canResolve("valibot");
const hasArktype = canResolve("drizzle-arktype") && canResolve("arktype");

describe("zod validator factory", () => {
    test.skipIf(!hasZod)("createInsertSchemaForZod parses sample row", async () => {
        const mod = await import("../../../src/files/validators/zod.ts");
        const schema = mod.createInsertSchemaForZod(docs);
        const parsed = schema.parse(sampleRow) as unknown as {
            title: string;
            attachment: string;
            views: number;
        };
        expect(parsed.title).toBe("hello");
        expect(parsed.attachment).toBe(sampleRow.attachment);
        expect(parsed.views).toBe(7);
        expect(() => schema.parse({ ...sampleRow, attachment: "" })).toThrow();
        expect(() => schema.parse({ ...sampleRow, views: "nope" })).toThrow();

        const fileColSchema = mod.chardbZodFromColumn(docs.attachment);
        expect(fileColSchema.parse("abc")).toBe("abc");
        expect(() => fileColSchema.parse("")).toThrow();

        const titleSchema = mod.chardbZodFromColumn(docs.title);
        expect(titleSchema.parse("ok")).toBe("ok");
    });
});

describe("typebox validator factory", () => {
    test.skipIf(!hasTypebox)("createInsertSchemaForTypebox accepts sample row", async () => {
        const mod = await import("../../../src/files/validators/typebox.ts");
        const valueMod = (await import("@sinclair/typebox/value" as string)) as {
            Value: { Check(schema: unknown, v: unknown): boolean };
        };
        const schema = mod.createInsertSchemaForTypebox(docs);
        expect(valueMod.Value.Check(schema, sampleRow)).toBe(true);
        expect(valueMod.Value.Check(schema, { ...sampleRow, attachment: "" })).toBe(false);
    });
});

describe("valibot validator factory", () => {
    test.skipIf(!hasValibot)("createInsertSchemaForValibot accepts sample row", async () => {
        const mod = await import("../../../src/files/validators/valibot.ts");
        const v = (await import("valibot" as string)) as {
            safeParse(schema: unknown, value: unknown): { success: boolean };
        };
        const schema = mod.createInsertSchemaForValibot(docs);
        expect(v.safeParse(schema, sampleRow).success).toBe(true);
        expect(v.safeParse(schema, { ...sampleRow, attachment: "" }).success).toBe(false);
    });
});

describe("arktype validator factory", () => {
    test.skipIf(!hasArktype)("createInsertSchemaForArktype accepts sample row", async () => {
        const mod = await import("../../../src/files/validators/arktype.ts");
        const schemaFn = mod.createInsertSchemaForArktype(docs) as unknown as (v: unknown) => {
            problems?: unknown;
        };
        expect(schemaFn(sampleRow).problems).toBeUndefined();
    });
});
