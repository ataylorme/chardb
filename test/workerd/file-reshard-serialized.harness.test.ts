import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { vshardOf } from "../../src/vshard.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "file-reshard-serialized.entry.ts");
const SOURCE = "ShardDO_0";
const SOURCE_DRAINED = 6;

interface SetupInput {
    readonly migId: string;
    readonly destination: string;
    readonly organizationIds: readonly [string, string, string];
}

interface SetupResult {
    readonly placement: number;
    readonly seeded: readonly {
        readonly fileId: string;
        readonly objectKey: string;
        readonly rowId: string;
        readonly status: string;
    }[];
}

interface FixtureState {
    readonly rows: readonly Record<string, unknown>[];
    readonly files: readonly Record<string, unknown>[];
}

interface R2Operations {
    readonly putCalls: number;
    readonly deleteCalls: number;
    readonly operations: readonly {
        readonly sequence: number;
        readonly operation: "put" | "delete";
        readonly keys: readonly string[];
    }[];
}

let mf: Miniflare | undefined;
let temporaryPath = "";
let workerSource = "";

function placement(organizationId: string): number {
    return Number(vshardOf([organizationId]));
}

function colocatedOrganizations(prefix: string, count: number, excluded = new Set<number>()): readonly string[] {
    let selectedPlacement = -1;
    const organizations: string[] = [];
    for (let index = 0; index < 300_000 && organizations.length === 0; index++) {
        const candidate = `${prefix}-${index}`;
        const candidatePlacement = placement(candidate);
        if (excluded.has(candidatePlacement)) continue;
        selectedPlacement = candidatePlacement;
        organizations.push(candidate);
    }
    for (let index = 300_000; index < 900_000 && organizations.length < count; index++) {
        const candidate = `${prefix}-${index}`;
        if (placement(candidate) === selectedPlacement) organizations.push(candidate);
    }
    if (organizations.length !== count) throw new Error(`could not find ${count} colocated organizations`);
    return organizations;
}

async function runtime(): Promise<Miniflare> {
    const instance = new Miniflare({
        name: "file-reshard-serialized",
        modules: true,
        script: workerSource,
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
            CDB_RESHARD: { className: "Resharder", useSQLite: true },
        },
        durableObjectsPersist: path.join(temporaryPath, "durable-objects"),
        r2Buckets: ["CDB_FILES"],
        r2Persist: path.join(temporaryPath, "r2"),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
    await instance.ready;
    return instance;
}

async function call<TResult = Record<string, unknown>>(
    operation: string,
    body: Record<string, unknown> = {},
    expectedStatus = 200
): Promise<TResult> {
    if (!mf) throw new Error("Miniflare is not initialized");
    const response = await mf.dispatchFetch(`http://example.com/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const result = (await response.json()) as TResult;
    if (response.status !== expectedStatus) {
        throw new Error(`${operation} returned ${response.status}: ${JSON.stringify(result)}`);
    }
    return result;
}

async function phase(migId: string): Promise<number | null> {
    return (await call<{ readonly phase: number | null }>("phase", { migId })).phase;
}

async function driveWithTraffic(input: {
    readonly migId: string;
    readonly destination: string;
    readonly organizationId: string;
    readonly firstSequence: number;
}): Promise<number> {
    let sequence = input.firstSequence;
    for (let turn = 0; turn < 128; turn++) {
        if ((await phase(input.migId)) === SOURCE_DRAINED) return sequence;
        const traffic = await call<{
            readonly route: { readonly shardId: string };
            readonly resolved: { readonly status: string; readonly rowId: string };
        }>("unrelatedTraffic", { organizationId: input.organizationId, sequence });
        expect(traffic.route).toMatchObject({ shardId: SOURCE });
        expect(traffic.resolved).toMatchObject({ status: "attached", rowId: `row-unrelated-${sequence}` });
        sequence++;
        await call("run", { migId: input.migId });
    }
    throw new Error(`migration ${input.migId} did not finish in 128 bounded turns`);
}

beforeAll(async () => {
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-file-reshard-serialized-"));
    const bundle = path.join(temporaryPath, "worker.mjs");
    const child = Bun.spawn(
        [
            "bun",
            "build",
            ENTRY,
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:workers",
            "--outfile",
            bundle,
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
    workerSource = (await Bun.file(bundle).text())
        .replace(
            "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
            'await Promise.reject(new Error("file migrations are unavailable in workerd"))'
        )
        .replace(
            "await import(nodeSqlite)",
            'await Promise.reject(new Error("node:sqlite is unavailable in workerd"))'
        );
    if (workerSource.includes("import(")) throw new Error("fixture bundle contains a dynamic import");
    mf = await runtime();
});

afterAll(async () => {
    await disposeMiniflareBounded(mf, { label: "serialized file reshard teardown" });
    mf = undefined;
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
});

describe("serialized disjoint file-aware range movement", () => {
    // file-reshard-e2e owns cold actor reconstruction. This proof isolates the
    // global lease, unrelated traffic, and exact ownership across disjoint moves.
    test("keeps unrelated traffic live, serializes disjoint moves, and preserves exact ownership", async () => {
        const organizationsA = colocatedOrganizations("serialized-move-a", 3) as readonly [string, string, string];
        const organizationsB = colocatedOrganizations(
            "serialized-move-b",
            3,
            new Set([placement(organizationsA[0])])
        ) as readonly [string, string, string];
        const unrelatedOrganizations = colocatedOrganizations(
            "serialized-unrelated",
            1,
            new Set([placement(organizationsA[0]), placement(organizationsB[0])])
        );
        const unrelated = unrelatedOrganizations[0];
        if (!unrelated) throw new Error("unrelated organization is missing");
        const moveA = {
            migId: "serialized_file_move_a",
            destination: "ShardDO_serialized_destination_a",
            organizationIds: organizationsA,
        } satisfies SetupInput;
        const moveB = {
            migId: "serialized_file_move_b",
            destination: "ShardDO_serialized_destination_b",
            organizationIds: organizationsB,
        } satisfies SetupInput;

        const setupA = await call<SetupResult>("setup", moveA as unknown as Record<string, unknown>);
        const preparedB = await call<SetupResult>("prepareOrganizations", {
            organizationIds: organizationsB,
            label: "move-b",
        });
        await call("prepareOrganizations", { organizationIds: [unrelated], label: "unrelated-base" });
        const beforeA = await call<readonly Record<string, unknown>[]>("r2Prefix", {
            prefix: `v1/${organizationsA[0]}/`,
        });
        const beforeB = await call<readonly Record<string, unknown>[]>("r2Prefix", {
            prefix: `v1/${organizationsB[0]}/`,
        });
        const baselineOperations = await call<R2Operations>("r2Operations");

        const blockedMigrationId = `${moveB.migId}_while_a_active`;
        const rejected = await call<{ readonly error: string }>(
            "startPreparedMove",
            {
                migId: blockedMigrationId,
                destination: moveB.destination,
                organizationId: organizationsB[0],
            },
            500
        );
        expect(rejected.error).toContain("already active");
        expect(await phase(blockedMigrationId)).toBeNull();

        let nextSequence = await driveWithTraffic({
            migId: moveA.migId,
            destination: moveA.destination,
            organizationId: unrelated,
            firstSequence: 0,
        });
        expect(await phase(moveA.migId)).toBe(SOURCE_DRAINED);
        expect(
            await call("startPreparedMove", {
                migId: moveB.migId,
                destination: moveB.destination,
                organizationId: organizationsB[0],
            })
        ).toMatchObject({ placement: preparedB.placement });

        nextSequence = await driveWithTraffic({
            migId: moveB.migId,
            destination: moveB.destination,
            organizationId: unrelated,
            firstSequence: nextSequence,
        });
        expect(await phase(moveB.migId)).toBe(SOURCE_DRAINED);
        expect(nextSequence).toBeGreaterThanOrEqual(8);

        expect(await call("route", { vshard: setupA.placement })).toMatchObject({ shardId: moveA.destination });
        expect(await call("route", { vshard: preparedB.placement })).toMatchObject({ shardId: moveB.destination });
        expect(await call("route", { vshard: placement(unrelated) })).toMatchObject({ shardId: SOURCE });

        const everyOrganization = [...organizationsA, ...organizationsB, unrelated];
        const source = await call<FixtureState>("shardState", {
            shardId: SOURCE,
            organizationIds: everyOrganization,
            migId: moveB.migId,
        });
        const destinationA = await call<FixtureState>("shardState", {
            shardId: moveA.destination,
            organizationIds: everyOrganization,
            migId: moveA.migId,
        });
        const destinationB = await call<FixtureState>("shardState", {
            shardId: moveB.destination,
            organizationIds: everyOrganization,
            migId: moveB.migId,
        });
        expect(new Set(source.rows.map(row => row.organization_id))).toEqual(new Set([unrelated]));
        expect(new Set(source.files.map(row => row.organization_id))).toEqual(new Set([unrelated]));
        expect(new Set(destinationA.rows.map(row => row.organization_id))).toEqual(new Set(organizationsA));
        expect(new Set(destinationA.files.map(row => row.organization_id))).toEqual(new Set(organizationsA));
        expect(new Set(destinationB.rows.map(row => row.organization_id))).toEqual(new Set(organizationsB));
        expect(new Set(destinationB.files.map(row => row.organization_id))).toEqual(new Set(organizationsB));

        await expect(
            call("gate", {
                shardId: moveA.destination,
                organizationId: organizationsA[0],
                operation: "download",
                rowId: setupA.seeded[0]?.rowId,
            })
        ).resolves.toMatchObject({ fileId: setupA.seeded[0]?.fileId, status: "attached" });
        await expect(
            call("gate", {
                shardId: moveB.destination,
                organizationId: organizationsB[0],
                operation: "download",
                rowId: preparedB.seeded[0]?.rowId,
            })
        ).resolves.toMatchObject({ fileId: preparedB.seeded[0]?.fileId, status: "attached" });
        const staleSource = await call<{ readonly error: string }>(
            "gate",
            {
                shardId: SOURCE,
                organizationId: organizationsA[0],
                operation: "download",
                rowId: setupA.seeded[0]?.rowId,
            },
            500
        );
        expect(staleSource.error).toContain("CDB_STALE_EPOCH");
        await expect(
            call("gate", {
                shardId: SOURCE,
                organizationId: unrelated,
                operation: "download",
                rowId: `row-unrelated-${nextSequence - 1}`,
            })
        ).resolves.toMatchObject({ status: "attached" });

        expect(
            await call<readonly Record<string, unknown>[]>("r2Prefix", {
                prefix: `v1/${organizationsA[0]}/`,
            })
        ).toEqual(beforeA);
        expect(
            await call<readonly Record<string, unknown>[]>("r2Prefix", {
                prefix: `v1/${organizationsB[0]}/`,
            })
        ).toEqual(beforeB);
        const afterOperations = await call<R2Operations>("r2Operations");
        const delta = afterOperations.operations.slice(baselineOperations.operations.length);
        expect(delta).toHaveLength(nextSequence);
        expect(delta.every(operation => operation.operation === "put")).toBe(true);
        expect(delta.flatMap(operation => operation.keys).every(key => key.startsWith(`v1/${unrelated}/`))).toBe(true);
        expect(afterOperations.deleteCalls).toBe(baselineOperations.deleteCalls);
    }, 60_000);
});
