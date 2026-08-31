import { describe, expect, test } from "bun:test";
import {
    parsePreviewUpgradeArgs,
    renderVersionTwoMigrations,
    renderVersionTwoSchema,
} from "../scripts/prepare-preview-upgrade.mjs";

describe("preview version-two preparation", () => {
    test("parses exact input and output directories", () => {
        expect(parsePreviewUpgradeArgs(["--input", "v1", "--output", "v2"])).toEqual({
            help: false,
            input: "v1",
            output: "v2",
        });
        expect(() => parsePreviewUpgradeArgs(["--input", "v1"])).toThrow("--output is required");
        expect(() => parsePreviewUpgradeArgs(["--wat"])).toThrow("Unknown preview upgrade argument");
    });

    test("adds one nullable column without changing the existing schema text", () => {
        const source = `const table = {\n        createdAt: integer("created_at").notNull(),\n};\n`;
        expect(renderVersionTwoSchema(source)).toBe(
            `const table = {\n        createdAt: integer("created_at").notNull(),\n        editedAt: integer("edited_at"),\n};\n`
        );
        expect(() => renderVersionTwoSchema("const table = {};\n")).toThrow("marker is missing");
        expect(() => renderVersionTwoSchema(renderVersionTwoSchema(source))).toThrow("already contains");
    });

    test("appends one immutable migration after the frozen baseline", () => {
        const source = `import { defineMigrations } from "@chardb/core/server";\nexport const migrations = defineMigrations([initialSchema]);\n`;
        const rendered = renderVersionTwoMigrations(source);
        expect(rendered).toContain("version: 2");
        expect(rendered).toContain('ALTER TABLE "messages" ADD COLUMN "edited_at" integer');
        expect(rendered).toContain("initialSchema,");
        expect(() => renderVersionTwoMigrations("export const migrations = [];\n")).toThrow("marker is missing");
    });
});
