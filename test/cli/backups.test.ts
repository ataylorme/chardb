import { describe, expect, test } from "bun:test";
import type { CliContext, CliFetch } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/run.ts";

const RECOVERY_POINT = {
    format: "chardb-recovery-point/v1",
    createdAt: 1_000,
    atMs: 900,
    schema: { version: 1, epoch: 2, digest: "a".repeat(64) },
    routingEpoch: 3,
    catalog: { bookmark: "00000001-catalog" },
    shards: [{ shardId: "ShardDO_0", bookmark: "00000001-shard" }],
    digest: "b".repeat(64),
};

function context(fetch: CliFetch): {
    readonly ctx: CliContext;
    readonly files: Map<string, string>;
    readonly out: string[];
    readonly err: string[];
} {
    const files = new Map<string, string>();
    const out: string[] = [];
    const err: string[] = [];
    return {
        files,
        out,
        err,
        ctx: {
            cwd: "/tmp/chardb-backups",
            env: { CHARDB_ADMIN_TOKEN: "backup-secret" },
            fetch,
            stdout: value => out.push(value),
            stderr: value => err.push(value),
            async read(path) {
                const value = files.get(path);
                if (value === undefined) throw new Error(`missing ${path}`);
                return value;
            },
            async write(path, contents) {
                files.set(path, contents);
            },
            async exists(path) {
                return files.has(path);
            },
            async writeFilesExclusive(artifacts) {
                for (const artifact of artifacts) {
                    if (files.has(artifact.path)) throw new Error(`artifact target already exists: ${artifact.path}`);
                }
                for (const artifact of artifacts) files.set(artifact.path, artifact.contents);
            },
        },
    };
}

describe("chardb backups CLI", () => {
    test("saves the remote recovery point without replacing an existing file", async () => {
        const calls: { readonly url: string; readonly body: unknown }[] = [];
        const state = context(async (input, init) => {
            calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            return Response.json({ ok: true, recoveryPoint: RECOVERY_POINT });
        });
        const argv = [
            "backups",
            "create",
            "--url",
            "https://db.example",
            "--out",
            "recovery.json",
            "--at",
            "2026-08-31T12:30:00Z",
        ];
        expect(await runCli(state.ctx, argv)).toBe(0);
        expect(calls).toEqual([
            {
                url: "https://db.example/_chardb/backups/create",
                body: { atMs: Date.parse("2026-08-31T12:30:00Z") },
            },
        ]);
        expect(JSON.parse(state.files.get("/tmp/chardb-backups/recovery.json") ?? "null")).toEqual(RECOVERY_POINT);
        expect(state.out.join("")).toContain(RECOVERY_POINT.digest);
        expect(state.err).toEqual([]);

        expect(await runCli(state.ctx, argv)).toBe(1);
        expect(state.err.at(-1)).toContain("artifact target already exists");
    });

    test("posts the saved point and requires an exact acknowledgement", async () => {
        let body: unknown;
        const state = context(async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return Response.json(
                { ok: true, accepted: true, recoveryPointDigest: RECOVERY_POINT.digest },
                { status: 202 }
            );
        });
        state.files.set("/tmp/chardb-backups/recovery.json", JSON.stringify(RECOVERY_POINT));
        expect(
            await runCli(state.ctx, ["backups", "restore", "--url", "https://db.example", "--from", "recovery.json"])
        ).toBe(0);
        expect(body).toEqual({ recoveryPoint: RECOVERY_POINT });
        expect(state.out.join("")).toContain("Durable Objects will restart");
        expect(state.err).toEqual([]);
    });

    test("rejects ambiguous flags, unsafe URLs, bad timestamps, and malformed files before fetch", async () => {
        let calls = 0;
        const state = context(async () => {
            calls++;
            return Response.json({});
        });
        for (const argv of [
            ["backups", "create", "--url", "https://db.example", "--out", "a", "--out", "b"],
            ["backups", "create", "--url", "https://db.example/path", "--out", "a"],
            ["backups", "create", "--url", "https://db.example", "--out", "a", "--at", "last Tuesday"],
            ["backups", "restore", "--url", "https://db.example", "--from", "bad.json", "--extra", "x"],
        ]) {
            expect(await runCli(state.ctx, argv)).not.toBe(0);
        }
        expect(calls).toBe(0);
    });
});
