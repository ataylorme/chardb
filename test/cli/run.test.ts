import { describe, expect, test } from "bun:test";
import type { CliContext } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/run.ts";

function fakeCtx(): { ctx: CliContext; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
        ctx: {
            cwd: "/tmp/proj",
            env: {},
            stdout: value => out.push(value),
            stderr: value => err.push(value),
            async read() {
                throw new Error("not used");
            },
            async write() {},
            async exists() {
                return false;
            },
        },
        out,
        err,
    };
}

describe("chardb explain CLI", () => {
    test("explains a partition-key query from positional JSON", async () => {
        const { ctx, out, err } = fakeCtx();
        const intent = JSON.stringify({
            kind: "select",
            tables: ["messages"],
            partitionKey: { table: "messages", column: "organization_id", values: ["org-1"] },
            joinShape: "colocated",
        });

        expect(await runCli(ctx, ["explain", intent])).toBe(0);
        expect(out.join("")).toContain("path=partition-key fanout~1");
        expect(err).toEqual([]);
    });

    test("returns one for a scatter plan in strict mode", async () => {
        const { ctx, out } = fakeCtx();
        const intent = JSON.stringify({ kind: "select", tables: ["messages"], joinShape: "cross-partition" });

        expect(await runCli(ctx, ["explain", "--strict", "--intent", intent])).toBe(1);
        expect(out.join("")).toContain("path=rejected");
        expect(out.join("")).toContain("CDB_SCATTER_NOT_INDEX");
    });

    test("returns usage errors for missing and malformed intents", async () => {
        const missing = fakeCtx();
        expect(await runCli(missing.ctx, ["explain"])).toBe(2);
        expect(missing.err.join("")).toContain("usage: chardb explain");

        const malformed = fakeCtx();
        expect(await runCli(malformed.ctx, ["explain", '{"kind":"select"}'])).toBe(2);
        expect(malformed.err.join("")).toContain("intent.tables");
    });
});
