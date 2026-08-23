import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { Miniflare } from "miniflare";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "registry-mutation.entry.ts");
const BUNDLE = path.join(HERE, ".test-registry-mutation.bundle.mjs");

let mf: Miniflare | undefined;

async function buildWorker(): Promise<string> {
    try {
        const proc = Bun.spawn(
            [
                "bun",
                "build",
                ENTRY,
                "--target=browser",
                "--format=esm",
                "--external=cloudflare:workers",
                "--outfile",
                BUNDLE,
            ],
            { stdout: "pipe", stderr: "pipe" }
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            throw new Error(`bundle failed (exit ${exitCode}):\n${stderr}`);
        }
        const bundled = await Bun.file(BUNDLE).text();
        const workerdScript = bundled
            .replace(
                "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
                'await Promise.reject(new Error("file migrations are unavailable in workerd"))'
            )
            .replace(
                "await import(nodeSqlite)",
                'await Promise.reject(new Error("node:sqlite is unavailable in workerd"))'
            );
        if (workerdScript.includes("import(")) {
            throw new Error("bundle contains an unexpected dynamic import that workerd cannot parse");
        }
        return workerdScript;
    } finally {
        await rm(BUNDLE, { force: true });
    }
}

beforeAll(async () => {
    mf = new Miniflare({
        modules: true,
        script: await buildWorker(),
        durableObjects: { CDB: { className: "Cdb", useSQLite: true } },
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
    });
    await mf.ready;
});

afterAll(async () => {
    await mf?.dispose();
});

async function mutate(body: {
    readonly operation: "put" | "inspect" | "raw" | "unknown";
    readonly mutId: string;
    readonly args: unknown;
}): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    if (!mf) throw new Error("miniflare not initialized");
    const response = await mf.dispatchFetch("http://example.com/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function inspectAtomicState(): Promise<{
    readonly entries: readonly { readonly id: string; readonly owner_id: string; readonly value: number }[];
    readonly opLogRows: number;
    readonly changeSeq: number;
    readonly mappings: readonly Record<string, unknown>[];
    readonly outbox: readonly Record<string, unknown>[];
}> {
    if (!mf) throw new Error("miniflare not initialized");
    const response = await mf.dispatchFetch("http://example.com/state");
    return (await response.json()) as {
        readonly entries: readonly { readonly id: string; readonly owner_id: string; readonly value: number }[];
        readonly opLogRows: number;
        readonly changeSeq: number;
        readonly mappings: readonly Record<string, unknown>[];
        readonly outbox: readonly Record<string, unknown>[];
    };
}

async function subscribe(): Promise<Record<string, unknown>> {
    if (!mf) throw new Error("miniflare not initialized");
    const response = await mf.dispatchFetch("http://example.com/subscribe", { method: "POST" });
    return (await response.json()) as Record<string, unknown>;
}

describe("configured Cdb local mutation registry", () => {
    test("resolves two refs locally, validates synchronously, carries auth, and replays the exact result", async () => {
        expect(await subscribe()).toMatchObject({
            changeSeq: 0,
            subscription: { gatewayId: "registry-gateway", registrationId: "registry-registration" },
        });
        expect(await subscribe()).toMatchObject({ changeSeq: 0 });
        const request = {
            operation: "put" as const,
            mutId: "put-one",
            args: { id: "entry-1", value: 41 },
        };
        const first = await mutate(request);
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({
            ok: true,
            ran: true,
            rowsAffected: 1,
            touchedTables: ["registry_entries"],
            result: {
                saved: { id: "entry-1", value: 41 },
                actor: {
                    userId: "registry-user",
                    tenantId: "registry-org",
                    role: "member",
                    probeClaim: "claim-ok",
                },
            },
        });

        const replay = await mutate(request);
        expect(replay.body).toEqual({ ...first.body, ran: false, touchedTables: [] });
        expect(await inspectAtomicState()).toMatchObject({
            changeSeq: 1,
            mappings: [
                {
                    gateway_id: "registry-gateway",
                    registration_id: "registry-registration",
                    table_name: "registry_entries",
                },
            ],
            outbox: [{ gateway_id: "registry-gateway", registration_id: "registry-registration", change_seq: 1 }],
        });

        const invalid = await mutate({
            operation: "put",
            mutId: "invalid-args",
            args: { id: 7, value: 42 },
        });
        expect(invalid.body).toMatchObject({
            ok: false,
            error: {
                code: "CDB_INVALID_ARGS",
                retryable: false,
                docs: "https://chardb.dev/errors/cdb_invalid_args",
            },
        });

        const inspected = await mutate({
            operation: "inspect",
            mutId: "inspect-one",
            args: { label: "after-validation" },
        });
        expect(inspected.body).toMatchObject({
            ok: true,
            touchedTables: [],
            result: {
                label: "after-validation",
                reader: "registry-user",
                rows: [{ id: "entry-1", ownerId: "registry-user", value: 41 }],
            },
        });
    });

    test("returns typed collision and unknown-ref failures without invoking a handler", async () => {
        const handlerFailure = await mutate({
            operation: "put",
            mutId: "handler-failure",
            args: { id: "explode", value: 1 },
        });
        expect(handlerFailure.body).toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });

        const collision = await mutate({
            operation: "put",
            mutId: "put-one",
            args: { id: "entry-2", value: 99 },
        });
        expect(collision.body).toMatchObject({
            ok: false,
            error: { code: "CDB_MUT_ID_COLLISION" },
        });

        const missing = await mutate({
            operation: "unknown",
            mutId: "unknown-ref",
            args: {},
        });
        expect(missing.body).toMatchObject({
            ok: false,
            error: { code: "CDB_REF_NOT_FOUND" },
        });

        const inspected = await mutate({
            operation: "inspect",
            mutId: "inspect-after-errors",
            args: { label: "after-errors" },
        });
        expect(inspected.body).toMatchObject({
            ok: true,
            result: {
                rows: [{ id: "entry-1", ownerId: "registry-user", value: 41 }],
            },
        });
    });

    test("a raw root escape rolls back prior typed SQL and its provisional op-log row", async () => {
        const before = await inspectAtomicState();
        const attempted = await mutate({
            operation: "raw",
            mutId: "raw-after-typed",
            args: { id: "raw-must-roll-back", value: 77 },
        });
        expect(attempted.body).toMatchObject({
            ok: false,
            error: { code: "CDB_UNSUPPORTED_FEATURE", retryable: false },
        });
        expect(await inspectAtomicState()).toEqual(before);
    });
});
