import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "gateway-snapshot.entry.ts");
const BUNDLE = path.join(process.env.TMPDIR ?? "/tmp", `chardb-gateway-snapshot-${process.pid}.bundle.mjs`);

interface DirtyRun {
    readonly targetVersion: number;
    readonly runToken: string;
    readonly runVersion: number;
    readonly leaseExpiresAt: number;
    readonly reclaimed: boolean;
}

interface SnapshotState {
    readonly instanceId: string;
    readonly generation: {
        readonly lifecycle: string;
        readonly cdbState: string;
        readonly dirtyVersion: number;
        readonly deliveredVersion: number;
        readonly runToken: string | null;
        readonly runTargetVersion: number | null;
        readonly runVersion: number;
        readonly lastCookie: string | null;
        readonly lastSnapshotCookie: string | null;
        readonly headRegistrationId: string | null;
    } | null;
    readonly outbox: {
        readonly cookie: string;
        readonly targetVersion: number;
        readonly rowsJson: string;
        readonly sendAttempts: number;
        readonly nextAttemptAt: number;
        readonly claimToken: string | null;
        readonly claimVersion: number;
        readonly claimExpiresAt: number | null;
        readonly lastSentAt: number | null;
    } | null;
}

let script = "";
let persistencePath = "";
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
            throw new Error(`bundle failed (exit ${exitCode}):\n${await new Response(proc.stderr).text()}`);
        }
        return await Bun.file(BUNDLE).text();
    } finally {
        await rm(BUNDLE, { force: true });
    }
}

function startMiniflare(): Miniflare {
    return new Miniflare({
        modules: true,
        script,
        durableObjects: { GATEWAY: { className: "Gateway", useSQLite: true } },
        durableObjectsPersist: persistencePath,
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
    });
}

async function call<T>(operation: string, body?: Record<string, unknown>): Promise<T> {
    if (!mf) throw new Error("miniflare not initialized");
    const response = await mf.dispatchFetch(`http://example.com/${operation}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${operation} failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
}

beforeAll(async () => {
    script = await buildWorker();
    persistencePath = await mkdtemp(path.join(tmpdir(), "chardb-gateway-snapshot-workerd-"));
    mf = startMiniflare();
});

afterAll(async () => {
    await mf?.dispose();
    if (persistencePath) await rm(persistencePath, { recursive: true, force: true });
});

describe("Gateway snapshot delivery durability in real workerd", () => {
    test("staged delivery survives reconstruction and exact acknowledgement advances only its target", async () => {
        expect(await call<boolean>("install", {})).toBe(true);
        expect(await call<boolean>("dirty", { dirtyVersion: 5 })).toBe(true);
        const run = await call<DirtyRun>("claim", {});
        expect(run).toMatchObject({ targetVersion: 5, runVersion: 1, reclaimed: false });

        expect(await call<boolean>("dirty", { dirtyVersion: 9 })).toBe(true);
        expect(await call<boolean>("stage", { run })).toBe(true);
        expect(await call<boolean>("ack", {})).toBe(false);

        const beforeRestart = await call<SnapshotState>("inspect");
        expect(beforeRestart.generation).toMatchObject({
            lifecycle: "active",
            cdbState: "active",
            dirtyVersion: 9,
            deliveredVersion: 2,
            runToken: null,
            runTargetVersion: null,
            runVersion: 2,
            lastCookie: "cookie-baseline",
            lastSnapshotCookie: null,
            headRegistrationId: "registration-workerd-snapshot",
        });
        expect(beforeRestart.outbox).toEqual({
            cookie: "cookie-target-5",
            targetVersion: 5,
            rowsJson: '[{"id":"row-from-target-5"}]',
            sendAttempts: 0,
            nextAttemptAt: 220,
            claimToken: null,
            claimVersion: 0,
            claimExpiresAt: null,
            lastSentAt: null,
        });

        await mf?.dispose();
        mf = startMiniflare();

        const afterRestart = await call<SnapshotState>("inspect");
        expect(afterRestart.instanceId).not.toBe(beforeRestart.instanceId);
        expect(afterRestart.generation).toEqual(beforeRestart.generation);
        expect(afterRestart.outbox).toEqual(beforeRestart.outbox);

        expect(await call<Record<string, unknown> | null>("claim-send", {})).toMatchObject({
            registrationId: "registration-workerd-snapshot",
            cookie: "cookie-target-5",
            targetVersion: 5,
            rows: [{ id: "row-from-target-5" }],
            sendAttempts: 1,
            nextAttemptAt: 320,
        });
        expect(await call<boolean>("ack", { cookie: "cookie-forged" })).toBe(false);
        expect(await call<boolean>("ack", {})).toBe(true);

        const acknowledged = await call<SnapshotState>("inspect");
        expect(acknowledged.generation).toMatchObject({
            dirtyVersion: 9,
            deliveredVersion: 5,
            lastCookie: "cookie-target-5",
            lastSnapshotCookie: "cookie-target-5",
        });
        expect(acknowledged.outbox).toBeNull();
        expect(await call<boolean>("ack", {})).toBe(true);
        expect(await call<SnapshotState>("inspect")).toEqual(acknowledged);

        expect(await call<DirtyRun>("claim", { nowMs: 400 })).toMatchObject({ targetVersion: 9 });
    }, 15_000);
});
