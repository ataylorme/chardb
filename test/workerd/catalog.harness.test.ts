/**
 * Workerd-level integration test for the internal Catalog barrier records.
 *
 * Boots `miniflare@4` with a bundled test worker that exposes `Catalog`
 * and drives the `openBarrier` -> `ackBarrier` -> `openBarriers` flow
 * against real Durable Object `SqlStorage`. The supported Worker does not
 * schedule these methods and has no backup or restore path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { vshardOf } from "../../src/vshard.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "catalog.entry.ts");
const WORKER_NAME = "catalog-restart-worker";

let mf: Miniflare | undefined;

async function buildWorker(): Promise<string> {
    const out = path.join(HERE, ".test-catalog.bundle.mjs");
    const proc = Bun.spawn(
        ["bun", "build", ENTRY, "--target=browser", "--format=esm", "--external=cloudflare:workers", "--outfile", out],
        { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`bundle failed (exit ${exitCode}):\n${stderr}`);
    }
    return Bun.file(out).text();
}

beforeAll(async () => {
    const workerSource = await buildWorker();
    mf = new Miniflare({
        name: WORKER_NAME,
        modules: true,
        script: workerSource,
        durableObjects: { CATALOG: { className: "Catalog", useSQLite: true } },
        compatibilityDate: "2024-09-23",
        compatibilityFlags: ["nodejs_compat"],
    });
    await mf.ready;
});

afterAll(async () => {
    await disposeMiniflareBounded(mf, { label: "Catalog fixture final teardown" });
    mf = undefined;
});

async function call(op: string, body?: unknown): Promise<unknown> {
    if (!mf) throw new Error("miniflare not initialized");
    const url = `http://example.com/${op}`;
    const res = await mf.dispatchFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`rpc ${op} → HTTP ${res.status}: ${text}`);
    }
    return res.json();
}

async function callFailure(op: string, body?: unknown): Promise<string> {
    if (!mf) throw new Error("miniflare not initialized");
    const res = await mf.dispatchFetch(`http://example.com/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { readonly error?: unknown };
    if (typeof payload.error !== "string") throw new Error(`rpc ${op} returned a malformed error`);
    return payload.error;
}

interface OpenBarrierResult {
    readonly barrierId: string;
    readonly expectedShards: readonly string[];
}

interface OpenBarriersEntry {
    readonly barrierId: string;
    readonly missing: readonly string[];
}

interface AuthRow {
    readonly [key: string]: unknown;
}

interface OrganizationAuthority {
    readonly principalId: string;
    readonly organizationId: string;
    readonly role: string;
    readonly roles: readonly string[];
    readonly userRole?: string;
    readonly authEpochs: {
        readonly global: number;
        readonly tenant: number;
        readonly principal: number;
    };
}

describe("workerd Catalog barrier flow", () => {
    test("openBarrier seeds expected shards from the range table; ackBarrier completes once every expected shard acks", async () => {
        const opened = (await call("openBarrier", { now: 1_700_000_000_000 })) as OpenBarrierResult;
        expect(opened.expectedShards).toEqual(["ShardDO_0"]);
        expect(opened.barrierId).toMatch(/^b-/);

        // First ack covers the only expected shard → complete.
        const acked = (await call("ackBarrier", {
            barrierId: opened.barrierId,
            shardId: "ShardDO_0",
            bookmark: 42,
        })) as { complete: boolean };
        expect(acked.complete).toBe(true);

        const open = (await call("openBarriers", {})) as readonly OpenBarriersEntry[];
        expect(open.find(b => b.barrierId === opened.barrierId)).toBeUndefined();
    });

    test("ackBarrier is idempotent (same shard re-acks → still complete, no error)", async () => {
        const opened = (await call("openBarrier", { now: 1_700_000_001_000 })) as OpenBarrierResult;
        await call("ackBarrier", { barrierId: opened.barrierId, shardId: "ShardDO_0", bookmark: 50 });
        const second = (await call("ackBarrier", {
            barrierId: opened.barrierId,
            shardId: "ShardDO_0",
            bookmark: 50,
        })) as { complete: boolean };
        expect(second.complete).toBe(true);
    });

    test("openBarriers reports any barrier with at least one missing shard", async () => {
        // An exact topology lease and cutover synthesize a second shard so we
        // can have a barrier with multiple expected acknowledgements.
        const before = (await call("route", { vshard: 0 })) as { readonly schemaEpoch: number };
        await call("beginTopologyOperation", {
            migId: "mig_pitr_1",
            sourceShard: "ShardDO_0",
            destinationShard: "ShardDO_1",
            rangeLo: 0,
            rangeHi: 8191,
            startEpoch: before.schemaEpoch,
        });
        await call("cutover", {
            migId: "mig_pitr_1",
            lo: 0,
            hi: 8191,
            fromShard: "ShardDO_0",
            toShard: "ShardDO_1",
            startEpoch: before.schemaEpoch,
        });
        const opened = (await call("openBarrier", { now: 1_700_000_002_000 })) as OpenBarrierResult;
        expect(new Set(opened.expectedShards)).toEqual(new Set(["ShardDO_0", "ShardDO_1"]));
        // Ack only one — barrier remains incomplete.
        const partial = (await call("ackBarrier", {
            barrierId: opened.barrierId,
            shardId: "ShardDO_0",
            bookmark: 100,
        })) as { complete: boolean };
        expect(partial.complete).toBe(false);
        const open = (await call("openBarriers", {})) as readonly OpenBarriersEntry[];
        const ours = open.find(b => b.barrierId === opened.barrierId);
        expect(ours).toBeDefined();
        expect(ours?.missing).toEqual(["ShardDO_1"]);
        // Final ack from ShardDO_1 closes it.
        const closed = (await call("ackBarrier", {
            barrierId: opened.barrierId,
            shardId: "ShardDO_1",
            bookmark: 200,
        })) as { complete: boolean };
        expect(closed.complete).toBe(true);
    });

    test("ackBarrier on an unknown barrierId is a silent no-op (never complete) — defends against a stale shard", async () => {
        const result = (await call("ackBarrier", {
            barrierId: "b-doesntexist",
            shardId: "ShardDO_0",
            bookmark: 0,
        })) as { complete: boolean };
        expect(result.complete).toBe(false);
    });

    test("Catalog reconstruction keeps auth tables and stored authority rows", async () => {
        if (!mf) throw new Error("miniflare not initialized");
        const now = Date.parse("2026-08-23T00:00:00Z");
        const expiresAt = Date.parse("2026-08-24T00:00:00Z");

        for (const input of [
            {
                model: "user",
                op: "create",
                payload: {
                    id: "restart-user",
                    name: "Restart User",
                    email: "catalog-restart@example.com",
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                },
            },
            {
                model: "session",
                op: "create",
                payload: {
                    id: "restart-session",
                    token: "catalog-restart-token",
                    userId: "restart-user",
                    expiresAt,
                    createdAt: now,
                    updatedAt: now,
                },
            },
            {
                model: "organization",
                op: "create",
                payload: {
                    id: "restart-org",
                    name: "Restart Org",
                    slug: "catalog-restart-org",
                    createdAt: now,
                },
            },
            {
                model: "member",
                op: "create",
                payload: {
                    id: "restart-member",
                    organizationId: "restart-org",
                    userId: "restart-user",
                    role: "owner,member",
                    createdAt: now,
                },
            },
        ] as const) {
            await call("mutateAuth", input);
        }

        const queryOne = async (model: string, where: Record<string, string>): Promise<AuthRow> => {
            const rows = (await call("queryAuth", {
                model,
                where: Object.entries(where).map(([field, value]) => ({ field, operator: "eq", value })),
                limit: 1,
            })) as readonly AuthRow[];
            expect(rows).toHaveLength(1);
            const row = rows[0];
            if (!row) throw new Error(`missing stored ${model} row`);
            return row;
        };
        const readStoredAuth = async () => ({
            session: await queryOne("session", { token: "catalog-restart-token" }),
            organization: await queryOne("organization", { slug: "catalog-restart-org" }),
            membership: await queryOne("member", {
                organizationId: "restart-org",
                userId: "restart-user",
            }),
            authority: (await call("resolveOrganizationAuthority", {
                principalId: "restart-user",
                organizationId: "restart-org",
            })) as OrganizationAuthority,
        });

        const before = await readStoredAuth();
        expect(before.session).toMatchObject({
            id: "restart-session",
            token: "catalog-restart-token",
            userId: "restart-user",
            expiresAt: new Date(expiresAt).toISOString(),
        });
        expect(before.organization).toMatchObject({
            id: "restart-org",
            name: "Restart Org",
            slug: "catalog-restart-org",
        });
        expect(before.membership).toMatchObject({
            id: "restart-member",
            organizationId: "restart-org",
            userId: "restart-user",
            role: "owner,member",
        });
        expect(before.authority).toMatchObject({
            principalId: "restart-user",
            organizationId: "restart-org",
            role: "member,owner",
            roles: ["member", "owner"],
            userRole: "user",
        });

        const firstInstanceId = (await call("fixtureInstanceId")) as string;
        await mf.unsafeEvictDurableObject(WORKER_NAME, "Catalog", { name: "global" });
        const secondInstanceId = (await call("fixtureInstanceId")) as string;
        expect(secondInstanceId).not.toBe(firstInstanceId);

        expect(await readStoredAuth()).toEqual(before);
    });

    test("file-free organization deletion permanently retires the id and removes authority", async () => {
        const now = Date.parse("2026-08-28T00:00:00Z");
        await call("mutateAuth", {
            model: "user",
            op: "create",
            payload: {
                id: "retired-org-user",
                name: "Retired Org User",
                email: "retired-org-user@example.com",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
            },
        });
        await call("mutateAuth", {
            model: "organization",
            op: "create",
            payload: {
                id: "retired-org",
                name: "Retired Org",
                slug: "retired-org",
                createdAt: now,
            },
        });
        await call("mutateAuth", {
            model: "member",
            op: "create",
            payload: {
                id: "retired-org-member",
                organizationId: "retired-org",
                userId: "retired-org-user",
                role: "owner",
                createdAt: now,
            },
        });

        expect(
            await call("resolveOrganizationAuthority", {
                principalId: "retired-org-user",
                organizationId: "retired-org",
            })
        ).toMatchObject({ organizationId: "retired-org", roles: ["owner"] });
        expect(
            await call("resolveOrganizationAuthorityRoute", {
                principalId: "retired-org-user",
                organizationId: "retired-org",
                vshard: Number(vshardOf(["retired-org"])),
            })
        ).toMatchObject({
            authority: { organizationId: "retired-org", roles: ["owner"] },
            route: { shardId: expect.any(String) },
        });

        await call("mutateAuth", {
            model: "member",
            op: "delete",
            where: { id: "retired-org-member" },
            limitOne: true,
        });
        await call("mutateAuth", {
            model: "organization",
            op: "delete",
            where: { id: "retired-org" },
            limitOne: true,
        });

        expect(
            await call("resolveOrganizationAuthority", {
                principalId: "retired-org-user",
                organizationId: "retired-org",
            })
        ).toBeNull();
        expect(
            await call("resolveOrganizationAuthorityRoute", {
                principalId: "retired-org-user",
                organizationId: "retired-org",
                vshard: Number(vshardOf(["retired-org"])),
            })
        ).toEqual({ authority: null });
        await expect(
            callFailure("mutateAuth", {
                model: "organization",
                op: "create",
                payload: {
                    id: "retired-org",
                    name: "Replacement Org",
                    slug: "replacement-org",
                    createdAt: now + 1,
                },
            })
        ).resolves.toContain("organization id was permanently retired after deletion");

        await mf?.unsafeEvictDurableObject(WORKER_NAME, "Catalog", { name: "global" });
        expect(
            await call("resolveOrganizationAuthority", {
                principalId: "retired-org-user",
                organizationId: "retired-org",
            })
        ).toBeNull();
        await expect(
            callFailure("mutateAuth", {
                model: "organization",
                op: "create",
                payload: {
                    id: "retired-org",
                    name: "Replacement Org After Restart",
                    slug: "replacement-org-after-restart",
                    createdAt: now + 2,
                },
            })
        ).resolves.toContain("organization id was permanently retired after deletion");
    });
});
