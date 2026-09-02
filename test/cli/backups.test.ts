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

function requestOperationId(init: RequestInit | undefined): string {
    const body = JSON.parse(String(init?.body)) as { readonly operationId?: unknown };
    if (typeof body.operationId !== "string") throw new Error("missing recovery operation id");
    return body.operationId;
}

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
                    {
                        operationId: requestOperationId(init),
                        ok: true,
                        accepted: true,
                        recoveryPointDigest: RECOVERY_POINT.digest,
                        reconcileAfterMs: 0,
                        providerReset: { files: 3, filesRetained: 3, vectors: 5 },
                    },
                    { status: 202 }
                );
            }
            return Response.json({
                operationId: requestOperationId(init),
                ok: true,
                reconciled: true,
                recoveryPointDigest: RECOVERY_POINT.digest,
                filesRehydrated: 3,
                vectorsRequeued: 7,
            });
        });
        state.files.set("/tmp/chardb-backups/recovery.json", JSON.stringify(RECOVERY_POINT));
        expect(
            await runCli(state.ctx, ["backups", "restore", "--url", "https://db.example", "--from", "recovery.json"])
        ).toBe(0);
        const operationId = (calls[0]?.body as { operationId?: unknown }).operationId;
        expect(operationId).toBeString();
        expect(calls).toEqual([
            {
                url: "https://db.example/_chardb/backups/restore",
                body: { operationId, recoveryPoint: RECOVERY_POINT },
            },
            {
                url: "https://db.example/_chardb/backups/reconcile",
                body: { operationId, recoveryPoint: RECOVERY_POINT },
            },
        ]);
        expect(state.out.join("")).toContain(
            "retained 3 files, reset 3 file objects and 5 vector records, then rehydrated 3 files and requeued 7 vectors"
        );
        expect(state.err).toEqual([]);
    });

    test("waits for every Durable Object restore before recovery reconciliation", async () => {
        let reconciles = 0;
        const state = context(async (input, init) => {
            if (String(input).endsWith("/restore")) {
                return Response.json(
                    {
                        operationId: requestOperationId(init),
                        ok: true,
                        accepted: true,
                        recoveryPointDigest: RECOVERY_POINT.digest,
                        reconcileAfterMs: 0,
                        providerReset: { files: 0, filesRetained: 0, vectors: 1 },
                    },
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
                operationId: requestOperationId(init),
                ok: true,
                reconciled: true,
                recoveryPointDigest: RECOVERY_POINT.digest,
                filesRehydrated: 0,
                vectorsRequeued: 2,
            });
        });
        state.files.set("/tmp/chardb-backups/recovery.json", JSON.stringify(RECOVERY_POINT));

        expect(
            await runCli(state.ctx, ["backups", "restore", "--url", "https://db.example", "--from", "recovery.json"])
        ).toBe(0);
        expect(reconciles).toBe(2);
        expect(state.out.join("")).toContain("rehydrated 0 files and requeued 2 vectors");
    });

    test("drives signed restore and reconciliation continuations to completion", async () => {
        const calls: { readonly url: string; readonly body: Record<string, unknown> }[] = [];
        const restoreContinuation = { format: "restore-turn", signature: "a".repeat(64) };
        const reconcileContinuation = { format: "reconcile-turn", signature: "b".repeat(64) };
        let restoreTurns = 0;
        let reconcileTurns = 0;
        const state = context(async (input, init) => {
            const url = String(input);
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            calls.push({ url, body });
            if (url.endsWith("/restore") && restoreTurns++ === 0) {
                return Response.json(
                    {
                        operationId: requestOperationId(init),
                        ok: true,
                        pending: true,
                        recoveryPointDigest: RECOVERY_POINT.digest,
                        continuation: restoreContinuation,
                    },
                    { status: 202 }
                );
            }
            if (url.endsWith("/restore")) {
                return Response.json(
                    {
                        operationId: requestOperationId(init),
                        ok: true,
                        accepted: true,
                        recoveryPointDigest: RECOVERY_POINT.digest,
                        reconcileAfterMs: 0,
                        providerReset: { files: 4, filesRetained: 4, vectors: 6 },
                    },
                    { status: 202 }
                );
            }
            if (reconcileTurns++ === 0) {
                return Response.json(
                    {
                        operationId: requestOperationId(init),
                        ok: true,
                        pending: true,
                        recoveryPointDigest: RECOVERY_POINT.digest,
                        continuation: reconcileContinuation,
                    },
                    { status: 202 }
                );
            }
            return Response.json({
                operationId: requestOperationId(init),
                ok: true,
                reconciled: true,
                recoveryPointDigest: RECOVERY_POINT.digest,
                filesRehydrated: 4,
                vectorsRequeued: 8,
            });
        });
        state.files.set("/tmp/chardb-backups/recovery.json", JSON.stringify(RECOVERY_POINT));

        expect(
            await runCli(state.ctx, ["backups", "restore", "--url", "https://db.example", "--from", "recovery.json"])
        ).toBe(0);
        const operationId = calls[0]?.body.operationId;
        expect(operationId).toBeString();
        expect(calls.map(call => call.body)).toEqual([
            { operationId, recoveryPoint: RECOVERY_POINT },
            { operationId, recoveryPoint: RECOVERY_POINT, continuation: restoreContinuation },
            { operationId, recoveryPoint: RECOVERY_POINT },
            { operationId, recoveryPoint: RECOVERY_POINT, continuation: reconcileContinuation },
        ]);
        expect(state.out.join("")).toContain("retained 4 files, reset 4 file objects and 6 vector records");
    });

    test("rejects an unbound recovery continuation", async () => {
        const state = context(async (_input, init) =>
            Response.json(
                {
                    operationId: requestOperationId(init),
                    ok: true,
                    pending: true,
                    recoveryPointDigest: "f".repeat(64),
                    continuation: { signature: "a".repeat(64) },
                },
                { status: 202 }
            )
        );
        state.files.set("/tmp/chardb-backups/recovery.json", JSON.stringify(RECOVERY_POINT));
        expect(
            await runCli(state.ctx, ["backups", "restore", "--url", "https://db.example", "--from", "recovery.json"])
        ).toBe(1);
        expect(state.err.at(-1)).toContain("invalid restore continuation");
    });

    test("rejects a signed continuation that makes no progress", async () => {
        const continuation = { format: "restore-turn", signature: "a".repeat(64), state: { shardIndex: 1 } };
        let calls = 0;
        const state = context(async (_input, init) => {
            calls++;
            return Response.json(
                {
                    operationId: requestOperationId(init),
                    ok: true,
                    pending: true,
                    recoveryPointDigest: RECOVERY_POINT.digest,
                    continuation,
                },
                { status: 202 }
            );
        });
        state.files.set("/tmp/chardb-backups/recovery.json", JSON.stringify(RECOVERY_POINT));
        expect(
            await runCli(state.ctx, ["backups", "restore", "--url", "https://db.example", "--from", "recovery.json"])
        ).toBe(1);
        expect(calls).toBe(2);
        expect(state.err.at(-1)).toContain("stalled restore continuation");
    });

    test("allows repeated polling continuations only with a positive retry delay", async () => {
        const continuation = { format: "restore-turn", signature: "a".repeat(64), state: { shardIndex: 1 } };
        let restoreCalls = 0;
        const state = context(async (input, init) => {
            if (String(input).endsWith("/restore") && restoreCalls++ < 3) {
                return Response.json(
                    {
                        operationId: requestOperationId(init),
                        ok: true,
                        pending: true,
                        recoveryPointDigest: RECOVERY_POINT.digest,
                        continuation,
                        retryAfterMs: 1,
                    },
                    { status: 202 }
                );
            }
            if (String(input).endsWith("/restore")) {
                return Response.json(
                    {
                        operationId: requestOperationId(init),
                        ok: true,
                        accepted: true,
                        recoveryPointDigest: RECOVERY_POINT.digest,
                        reconcileAfterMs: 0,
                        providerReset: { files: 0, filesRetained: 0, vectors: 0 },
                    },
                    { status: 202 }
                );
            }
            return Response.json({
                operationId: requestOperationId(init),
                ok: true,
                reconciled: true,
                recoveryPointDigest: RECOVERY_POINT.digest,
                filesRehydrated: 0,
                vectorsRequeued: 0,
            });
        });
        state.files.set("/tmp/chardb-backups/recovery.json", JSON.stringify(RECOVERY_POINT));

        expect(
            await runCli(state.ctx, ["backups", "restore", "--url", "https://db.example", "--from", "recovery.json"])
        ).toBe(0);
        expect(restoreCalls).toBe(4);
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
