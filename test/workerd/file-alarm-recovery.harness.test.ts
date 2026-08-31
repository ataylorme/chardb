import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { vshardOf } from "../../src/vshard.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "file-reshard-e2e.entry.ts");
const SOURCE_DRAINED = 6;

type FileAlarmFault = "before_metadata" | "before_r2" | "after_r2";

interface FileAlarmFaultState {
    readonly fault: FileAlarmFault;
    readonly fired: number;
    readonly calls: number;
}

interface R2MutationStats {
    readonly putCalls: number;
    readonly deleteCalls: number;
    readonly operations: readonly {
        readonly sequence: number;
        readonly operation: "put" | "delete";
        readonly keys: readonly string[];
    }[];
}

interface FixtureState {
    readonly destination: {
        readonly files: readonly Record<string, unknown>[];
    };
}

let mf: Miniflare | undefined;
let temporaryPath = "";
let workerSource = "";

function placement(organizationId: string): number {
    return Number(vshardOf([organizationId]));
}

function colocatedOrganizations(prefix: string): readonly [string, string, string] {
    const organizations: string[] = [];
    let selectedPlacement = -1;
    for (let index = 0; index < 600_000 && organizations.length < 3; index++) {
        const candidate = `${prefix}-${index}`;
        const candidatePlacement = placement(candidate);
        if (selectedPlacement < 0) selectedPlacement = candidatePlacement;
        if (candidatePlacement === selectedPlacement) organizations.push(candidate);
    }
    if (organizations.length !== 3) throw new Error("could not find three colocated alarm fixture organizations");
    return organizations as unknown as readonly [string, string, string];
}

async function runtime(): Promise<Miniflare> {
    const instance = new Miniflare({
        name: "file-alarm-recovery",
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
    try {
        await instance.ready;
        return instance;
    } catch (error) {
        await disposeMiniflareBounded(instance, { label: "failed file alarm recovery startup" });
        throw error;
    }
}

async function startRuntimeBounded(label: string, limit = 4): Promise<Miniflare> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= limit; attempt++) {
        try {
            return await runtime();
        } catch (error) {
            lastError = error;
            if (attempt < limit) await Bun.sleep(100 * attempt);
        }
    }
    throw new Error(`${label} failed after ${limit} attempts`, { cause: lastError });
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

async function rejected(operation: string, body: Record<string, unknown>): Promise<string> {
    return (await call<{ readonly error: string }>(operation, body, 500)).error;
}

async function phase(migId: string): Promise<number | null> {
    return (await call<{ readonly phase: number | null }>("phase", { migId })).phase;
}

async function driveTo(migId: string, expected: number, limit = 128): Promise<void> {
    for (let turn = 0; turn < limit; turn++) {
        const current = await phase(migId);
        if (current === expected) return;
        if (current === null || current > expected) {
            throw new Error(`migration ${migId} reached phase ${String(current)} before ${expected}`);
        }
        await call("run", { migId });
    }
    throw new Error(`migration ${migId} did not reach phase ${expected}`);
}

async function r2MutationStats(): Promise<R2MutationStats> {
    return call<R2MutationStats>("r2Operations");
}

function expectR2MutationDelta(
    before: R2MutationStats,
    after: R2MutationStats,
    expected: readonly { readonly operation: "put" | "delete"; readonly keys: readonly string[] }[]
): void {
    const lastSequence = before.operations.at(-1)?.sequence ?? 0;
    expect(
        after.operations
            .filter(operation => operation.sequence > lastSequence)
            .map(({ operation, keys }) => ({ operation, keys }))
    ).toEqual([...expected]);
    expect(after.putCalls - before.putCalls).toBe(expected.filter(item => item.operation === "put").length);
    expect(after.deleteCalls - before.deleteCalls).toBe(expected.filter(item => item.operation === "delete").length);
}

beforeAll(async () => {
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-file-alarm-recovery-"));
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
    mf = await startRuntimeBounded("file alarm recovery startup");
});

afterAll(async () => {
    await disposeMiniflareBounded(mf, { label: "file alarm recovery teardown" });
    mf = undefined;
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
});

describe("native file alarm crash recovery", () => {
    test("recovers every alarm and R2 boundary on a moved owner", async () => {
        const movement = {
            migId: "native_file_alarm_recovery",
            destination: "ShardDO_file_alarm_destination",
            organizationIds: colocatedOrganizations("native-file-alarm"),
        } as const;
        await call("setup", movement as unknown as Record<string, unknown>);
        await driveTo(movement.migId, SOURCE_DRAINED);
        const organizationId = movement.organizationIds[0];
        const shardId = movement.destination;
        const cases = [
            { fault: "before_metadata", suffix: "a", statusAfterFault: "pending", presentAfterFault: true, deletes: 1 },
            { fault: "before_r2", suffix: "b", statusAfterFault: "deleting", presentAfterFault: true, deletes: 1 },
            { fault: "after_r2", suffix: "c", statusAfterFault: "deleting", presentAfterFault: false, deletes: 2 },
        ] as const;

        for (const item of cases) {
            const fileId = `fil_${item.suffix.repeat(64)}`;
            const objectKey = `v1/${organizationId}/${fileId}`;
            const beforeSeed = await r2MutationStats();
            await call("seedPendingFile", {
                shardId,
                organizationId,
                fileId,
                fileBody: `alarm-${item.fault}`,
            });
            const afterSeed = await r2MutationStats();
            expectR2MutationDelta(beforeSeed, afterSeed, [{ operation: "put", keys: [objectKey] }]);

            await call("armAlarmFault", { shardId, fault: item.fault });
            if (item.fault === "before_metadata") {
                expect(await rejected("fileAlarm", { shardId })).toContain(`interrupted at ${item.fault}`);
            } else {
                await call("fileAlarm", { shardId });
            }

            const interrupted = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
            expect(interrupted.destination.files).toContainEqual(
                expect.objectContaining({ file_id: fileId, status: item.statusAfterFault })
            );
            expect(await call<readonly Record<string, unknown>[]>("r2", { keys: [objectKey] })).toEqual([
                expect.objectContaining({ key: objectKey, present: item.presentAfterFault }),
            ]);
            expect(
                (await call<readonly FileAlarmFaultState[]>("alarmFaultState", { shardId })).find(
                    state => state.fault === item.fault
                )
            ).toEqual({ fault: item.fault, fired: 1, calls: 1 });

            await call("fileAlarm", { shardId });
            const recovered = await call<FixtureState>("state", movement as unknown as Record<string, unknown>);
            expect(recovered.destination.files).not.toContainEqual(expect.objectContaining({ file_id: fileId }));
            expect(await call<readonly Record<string, unknown>[]>("r2", { keys: [objectKey] })).toEqual([
                expect.objectContaining({ key: objectKey, present: false }),
            ]);
            expect(
                (await call<readonly FileAlarmFaultState[]>("alarmFaultState", { shardId })).find(
                    state => state.fault === item.fault
                )
            ).toEqual({ fault: item.fault, fired: 1, calls: 2 });
            expectR2MutationDelta(
                afterSeed,
                await r2MutationStats(),
                Array.from({ length: item.deletes }, () => ({ operation: "delete" as const, keys: [objectKey] }))
            );
        }
    }, 30_000);
});
