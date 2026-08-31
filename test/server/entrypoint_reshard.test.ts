import { describe, expect, test } from "bun:test";
import { text } from "drizzle-orm/sqlite-core";
import { globalScope } from "../../src/server/cdb-tenant.ts";
import type { ChardbEnv } from "../../src/server/entrypoint.ts";
import { handleReshardAdminRequest } from "../../src/server/reshard-admin.ts";

const { cdbTable } = globalScope();
const records = cdbTable(
    "records",
    { id: text("id").primaryKey(), organizationId: text("organization_id").notNull() },
    { partitionBy: "organizationId" }
);
const schema = { records };

function namespace(value: object): DurableObjectNamespace {
    return {
        idFromName: (name: string) => ({ name }),
        get: () => value,
    } as unknown as DurableObjectNamespace;
}

function env(catalog: object, resharder: object, token = "reshard-secret"): ChardbEnv {
    return {
        CDB_ADMIN_TOKEN: token,
        CDB_CATALOG: namespace(catalog),
        CDB_RESHARD: namespace(resharder),
    } as unknown as ChardbEnv;
}

function authorized(path: string, init: RequestInit = {}): Request {
    return new Request(`https://worker.example${path}`, {
        ...init,
        headers: { authorization: "Bearer reshard-secret", ...init.headers },
    });
}

function status(phase = 0) {
    return {
        migId: "split-1",
        phase,
        srcShard: "ShardDO_0",
        dstShard: "ShardDO_1",
        rangeLo: 8,
        rangeHi: 15,
    };
}

describe("private reshard admin endpoint", () => {
    test("hides an unconfigured route and authenticates before any RPC", async () => {
        let calls = 0;
        const catalog = { beginDerivedTopologyOperation: () => calls++ };
        const resharder = { migrationStatus: () => calls++ };
        expect(
            (
                await handleReshardAdminRequest(
                    authorized("/_chardb/shards/status?migrationId=split-1"),
                    env(catalog, resharder, ""),
                    schema
                )
            ).status
        ).toBe(404);
        expect(
            (
                await handleReshardAdminRequest(
                    new Request("https://worker.example/_chardb/shards/status?migrationId=split-1", {
                        headers: { authorization: "Bearer wrong" },
                    }),
                    env(catalog, resharder),
                    schema
                )
            ).status
        ).toBe(403);
        expect(calls).toBe(0);
    });

    test("derives topology and the complete packaged table specs before exact start", async () => {
        const calls: unknown[] = [];
        let current: ReturnType<typeof status> | null = null;
        const catalog = {
            beginDerivedTopologyOperation(input: unknown) {
                calls.push(["claim", input]);
                return {
                    migrationId: "split-1",
                    sourceShard: "ShardDO_0",
                    destinationShard: "ShardDO_1",
                    rangeLo: 8,
                    rangeHi: 15,
                    startEpoch: 3,
                    schemaVersion: 2,
                    schemaEpoch: 7,
                    schemaDigest: "a".repeat(64),
                    status: "active",
                    completedEpoch: null,
                    createdAt: 1,
                    updatedAt: 1,
                };
            },
        };
        const resharder = {
            migrationStatus() {
                return current;
            },
            startSplit(input: unknown) {
                calls.push(["start", input]);
                current = status();
            },
        };
        const request = () =>
            handleReshardAdminRequest(
                authorized("/_chardb/shards/start", {
                    method: "POST",
                    body: JSON.stringify({
                        migrationId: "split-1",
                        destinationShard: "ShardDO_1",
                        rangeLo: 8,
                        rangeHi: 15,
                    }),
                }),
                env(catalog, resharder),
                schema
            );

        expect(await (await request()).json()).toMatchObject({
            ok: true,
            started: true,
            state: { phaseName: "INIT", terminal: false },
        });
        expect(calls).toEqual([
            ["claim", { migId: "split-1", destinationShard: "ShardDO_1", rangeLo: 8, rangeHi: 15 }],
            [
                "start",
                {
                    migId: "split-1",
                    srcShard: "ShardDO_0",
                    dstShard: "ShardDO_1",
                    rangeLo: 8,
                    rangeHi: 15,
                    epochAtStart: 3,
                    tables: [
                        { name: "records", partitionColumn: "organization_id", columns: ["id", "organization_id"] },
                    ],
                },
            ],
        ]);
        expect(await (await request()).json()).toMatchObject({ ok: true, started: false });
        expect(calls).toHaveLength(2);
    });

    test("rejects caller-owned physical identity and stale resume intent", async () => {
        let calls = 0;
        const resharder = { migrationStatus: () => status() };
        const environment = env({ beginDerivedTopologyOperation: () => calls++ }, resharder);
        const extra = await handleReshardAdminRequest(
            authorized("/_chardb/shards/start", {
                method: "POST",
                body: JSON.stringify({
                    migrationId: "split-1",
                    destinationShard: "ShardDO_1",
                    rangeLo: 8,
                    rangeHi: 15,
                    sourceShard: "hostile",
                }),
            }),
            environment,
            schema
        );
        expect(extra.status).toBe(400);
        const changed = await handleReshardAdminRequest(
            authorized("/_chardb/shards/start", {
                method: "POST",
                body: JSON.stringify({
                    migrationId: "split-1",
                    destinationShard: "ShardDO_2",
                    rangeLo: 8,
                    rangeHi: 15,
                }),
            }),
            environment,
            schema
        );
        expect(changed.status).toBe(409);
        expect(calls).toBe(0);
    });

    test("drives one bounded step and aborts an orphaned Catalog claim safely", async () => {
        let current: ReturnType<typeof status> | null = status();
        let drives = 0;
        let reshardAborts = 0;
        const topology = {
            migrationId: "split-1",
            sourceShard: "ShardDO_0",
            destinationShard: "ShardDO_1",
            rangeLo: 8,
            rangeHi: 15,
            startEpoch: 3,
            schemaVersion: 2,
            schemaEpoch: 7,
            schemaDigest: "a".repeat(64),
            status: "active",
            completedEpoch: null,
            createdAt: 1,
            updatedAt: 1,
        } as const;
        const catalogAborts: unknown[] = [];
        const catalog = {
            topologyOperation: () => topology,
            abortTopologyOperation(input: unknown) {
                catalogAborts.push(input);
                return { ...topology, status: "aborted" };
            },
        };
        const resharder = {
            migrationStatus: () => current,
            runSplit() {
                drives++;
                current = status(1);
            },
            abort() {
                reshardAborts++;
            },
        };
        const environment = env(catalog, resharder);
        const drive = await handleReshardAdminRequest(
            authorized("/_chardb/shards/drive", {
                method: "POST",
                body: JSON.stringify({ migrationId: "split-1" }),
            }),
            environment,
            schema
        );
        expect(await drive.json()).toMatchObject({ state: { phase: 1, phaseName: "TAIL_CAPTURE_ENABLED" } });
        expect(drives).toBe(1);

        current = null;
        const abort = await handleReshardAdminRequest(
            authorized("/_chardb/shards/abort", {
                method: "POST",
                body: JSON.stringify({ migrationId: "split-1" }),
            }),
            environment,
            schema
        );
        expect((await abort.json()) as unknown).toEqual({ ok: true, state: null, aborted: true });
        expect(catalogAborts).toEqual([
            {
                migId: "split-1",
                sourceShard: "ShardDO_0",
                destinationShard: "ShardDO_1",
                rangeLo: 8,
                rangeHi: 15,
                startEpoch: 3,
            },
        ]);
        expect(reshardAborts).toBe(1);
    });

    test("runs legacy recovery only through the explicit operator route", async () => {
        let recoveries = 0;
        const resharder = {
            migrationStatus: () => status(4),
            recoverLegacyFileMovement(migrationId: string) {
                expect(migrationId).toBe("split-1");
                recoveries++;
                return { action: "resumed" as const, phase: 4 };
            },
        };
        const response = await handleReshardAdminRequest(
            authorized("/_chardb/shards/recover", {
                method: "POST",
                body: JSON.stringify({ migrationId: "split-1" }),
            }),
            env({}, resharder),
            schema
        );
        expect((await response.json()) as unknown).toEqual({
            ok: true,
            action: "resumed",
            state: {
                migrationId: "split-1",
                phase: 4,
                phaseName: "DUAL_WRITE_OPEN",
                terminal: false,
                sourceShard: "ShardDO_0",
                destinationShard: "ShardDO_1",
                rangeLo: 8,
                rangeHi: 15,
            },
        });
        expect(recoveries).toBe(1);
    });
});
