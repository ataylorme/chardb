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
        const calls: { readonly url: string; readonly body: unknown }[] = [];
        const state = context(async (input, init) => {
            calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            if (String(input).endsWith("/restore")) {
                return Response.json(
                    { ok: true, accepted: true, recoveryPointDigest: RECOVERY_POINT.digest, reconcileAfterMs: 0 },
                    { status: 202 }
                );
            }
            return Response.json({
                ok: true,
                reconciled: true,
                recoveryPointDigest: RECOVERY_POINT.digest,
                vectorsRequeued: 7,
            });
        });
        state.files.set("/tmp/chardb-backups/recovery.json", JSON.stringify(RECOVERY_POINT));
        expect(
            await runCli(state.ctx, ["backups", "restore", "--url", "https://db.example", "--from", "recovery.json"])
        ).toBe(0);
        expect(calls).toEqual([
            {
                url: "https://db.example/_chardb/backups/restore",
                body: { recoveryPoint: RECOVERY_POINT },
            },
            {
                url: "https://db.example/_chardb/backups/reconcile",
                body: { recoveryPoint: RECOVERY_POINT },
            },
        ]);
        expect(state.out.join("")).toContain("7 vectors were requeued");
        expect(state.err).toEqual([]);
    });

    test("waits for every Durable Object restore before recovery reconciliation", async () => {
        let reconciles = 0;
        const state = context(async input => {
            if (String(input).endsWith("/restore")) {
                return Response.json(
                    { ok: true, accepted: true, recoveryPointDigest: RECOVERY_POINT.digest, reconcileAfterMs: 0 },
                    { status: 202 }
                );
            }
            reconciles++;
            if (reconciles === 1) {
                return Response.json(
                    { ok: false, code: "CDB_STALE_EPOCH", error: "point-in-time restore is in progress" },
                    { status: 409 }
                );
            }
            return Response.json({
                ok: true,
                reconciled: true,
                recoveryPointDigest: RECOVERY_POINT.digest,
                vectorsRequeued: 2,
            });
        });
        state.files.set("/tmp/chardb-backups/recovery.json", JSON.stringify(RECOVERY_POINT));

        expect(
            await runCli(state.ctx, ["backups", "restore", "--url", "https://db.example", "--from", "recovery.json"])
        ).toBe(0);
        expect(reconciles).toBe(2);
        expect(state.out.join("")).toContain("2 vectors were requeued");
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
