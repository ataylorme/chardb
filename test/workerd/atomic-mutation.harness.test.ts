import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Miniflare } from "miniflare";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "atomic-mutation.entry.ts");
const BUNDLE = path.join(HERE, ".test-atomic-mutation.bundle.mjs");

let mf: Miniflare | undefined;

async function buildWorker(): Promise<string> {
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
    return Bun.file(BUNDLE).text();
}

beforeAll(async () => {
    mf = new Miniflare({
        modules: true,
        script: await buildWorker(),
        durableObjects: { ATOMIC: { className: "AtomicMutationProbe", useSQLite: true } },
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
    });
    await mf.ready;
});

afterAll(async () => {
    await mf?.dispose();
});

async function execute(body: {
    readonly mode: "commit" | "throw" | "async" | "forbidden" | "policy" | "updatePolicy";
    readonly mutId: string;
    readonly firstId: string;
    readonly secondId: string;
}) {
    if (!mf) throw new Error("miniflare not initialized");
    return mf.dispatchFetch("http://example.com/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function inspect(): Promise<{
    readonly entries: readonly { id: string; sequence: number }[];
    readonly opLogRows: number;
}> {
    if (!mf) throw new Error("miniflare not initialized");
    const response = await mf.dispatchFetch("http://example.com/inspect");
    return (await response.json()) as {
        readonly entries: readonly { id: string; sequence: number }[];
        readonly opLogRows: number;
    };
}

describe("atomic domain mutation on real Durable Object SqlStorage", () => {
    test("two Drizzle statements and the op-log row commit together; replay returns the exact result", async () => {
        const body = {
            mode: "commit" as const,
            mutId: "commit-pair",
            firstId: "committed-1",
            secondId: "committed-2",
        };
        const first = await execute(body);
        expect(first.status).toBe(200);
        expect((await first.json()) as unknown).toEqual({
            cookie: "probe:commit-pair",
            ran: true,
            result: { ids: ["committed-1", "committed-2"] },
            rowsAffected: 1,
        });

        const replay = await execute(body);
        expect({ status: replay.status, body: (await replay.json()) as unknown }).toEqual({
            status: 200,
            body: {
                cookie: "probe:commit-pair",
                ran: false,
                result: { ids: ["committed-1", "committed-2"] },
                rowsAffected: 1,
            },
        });

        expect(await inspect()).toEqual({
            entries: [
                { id: "committed-1", sequence: 1 },
                { id: "committed-2", sequence: 2 },
            ],
            opLogRows: 1,
        });
    });

    test("throwing after the second statement rolls back both rows and the provisional op-log row", async () => {
        const before = await inspect();
        const response = await execute({
            mode: "throw",
            mutId: "rollback-pair",
            firstId: "rolled-back-1",
            secondId: "rolled-back-2",
        });
        expect(response.status).toBe(409);
        expect((await response.json()) as unknown).toEqual({
            code: "UNKNOWN",
            message: "probe failure after second statement",
        });

        expect(await inspect()).toEqual(before);
    });

    test("a native async handler is rejected before its first SQL statement", async () => {
        const before = await inspect();
        const response = await execute({
            mode: "async",
            mutId: "async-handler",
            firstId: "must-not-write",
            secondId: "unused",
        });
        expect(response.status).toBe(409);
        expect((await response.json()) as unknown).toEqual({
            code: "CDB_INTERACTIVE_TXN_UNSUPPORTED",
            message: "mutation handlers must be synchronous; Durable Object SQLite transactions cannot span await",
        });
        expect(await inspect()).toEqual(before);
    });

    test("a conflicting tenant insert rolls back earlier statements and the provisional op-log row", async () => {
        const before = await inspect();
        const response = await execute({
            mode: "forbidden",
            mutId: "forbidden-tenant",
            firstId: "must-roll-back",
            secondId: "must-not-insert",
        });
        expect(response.status).toBe(409);
        expect((await response.json()) as unknown).toEqual({
            code: "CDB_FORBIDDEN",
            message: 'explicit tenant column "organizationId" conflicts with verified auth',
        });
        expect(await inspect()).toEqual(before);
    });

    test("a forbidden create column rolls back earlier statements and the provisional op-log row", async () => {
        const before = await inspect();
        const response = await execute({
            mode: "policy",
            mutId: "forbidden-create-column",
            firstId: "policy-must-roll-back",
            secondId: "policy-must-not-insert",
        });
        expect(response.status).toBe(409);
        expect((await response.json()) as unknown).toEqual({
            code: "CDB_FORBIDDEN",
            message: 'atomic_secured_entries: caller is not authorized to create column "secret_note"',
        });
        expect(await inspect()).toEqual(before);
    });

    test("a forbidden update column rolls back earlier statements and the provisional op-log row", async () => {
        const before = await inspect();
        const response = await execute({
            mode: "updatePolicy",
            mutId: "forbidden-update-column",
            firstId: "update-policy-must-roll-back",
            secondId: "unused",
        });
        expect(response.status).toBe(409);
        expect((await response.json()) as unknown).toEqual({
            code: "CDB_FORBIDDEN",
            message: 'atomic_secured_entries: caller is not authorized to update column "secret_note"',
        });
        expect(await inspect()).toEqual(before);
    });
});
