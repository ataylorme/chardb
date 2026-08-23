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

describe("chardb command availability", () => {
    test("help labels every unavailable command", async () => {
        const { ctx, out, err } = fakeCtx();

        expect(await runCli(ctx, ["--help"])).toBe(0);
        expect(err).toEqual([]);
        for (const command of ["migrate", "deploy", "shards", "snapshot", "restore", "export", "schedule"]) {
            expect(out.join("")).toContain(`chardb ${command}`);
        }
        expect(out.join("").match(/not implemented/g)).toHaveLength(7);
    });

    test("unavailable commands fail clearly without running placeholder implementations", async () => {
        for (const command of ["migrate", "deploy", "shards", "snapshot", "restore", "export", "schedule"]) {
            const { ctx, out, err } = fakeCtx();

            expect(await runCli(ctx, [command])).toBe(1);
            expect(out).toEqual([]);
            expect(err).toEqual([`chardb ${command}: not implemented in this release\n`]);
        }
    });
});
