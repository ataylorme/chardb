import { describe, expect, test } from "bun:test";
import type { SqlParam, SyncSql } from "../../src/oplog/wrapper.ts";
import { scrubCdbVectorRecoveryPage } from "../../src/server/do/cdb-vector-recovery-scrub.ts";
import { cdbVectorizePhysicalId } from "../../src/server/do/cdb-vectorize-wire.ts";
import { cdbVectorResourceId } from "../../src/server/resource-descriptors.ts";

const RESOURCE_A = Object.freeze({
    kind: "vector" as const,
    version: 1 as const,
    table: "messages",
    column: "embedding",
    primaryKey: "id",
    organizationColumn: "organization_id",
    binding: "CDB_MESSAGES_VECTOR",
    dimensions: 3,
    metric: "cosine" as const,
});

const RESOURCE_B = Object.freeze({
    ...RESOURCE_A,
    table: "documents",
    binding: "CDB_DOCUMENTS_VECTOR",
});

const VECTOR_A = `vec1_${"a".repeat(64)}`;
const VECTOR_B = `vec1_${"b".repeat(64)}`;

interface AttemptRow {
    readonly vector_id: string;
    readonly resource_id: string;
    readonly physical_version: number;
}

function fakeSql(rows: readonly AttemptRow[], attemptsExist = true): SyncSql {
    return {
        exec() {
            throw new Error("recovery scrub must not mutate SQLite");
        },
        one<T>() {
            return (attemptsExist ? { present: 1 } : null) as T | null;
        },
        all<T>(_sql: string, ...params: SqlParam[]) {
            const afterVectorId = String(params[0]);
            const afterPhysicalVersion = Number(params[2]);
            const limit = Number(params[3]);
            return rows
                .filter(
                    row =>
                        row.vector_id > afterVectorId ||
                        (row.vector_id === afterVectorId && row.physical_version > afterPhysicalVersion)
                )
                .slice(0, limit) as T[];
        },
        changes: () => 0,
    };
}

describe("Cdb vector recovery provider scrub", () => {
    test("pages by stable physical identity and groups deletes by binding", async () => {
        const rows = [
            { vector_id: VECTOR_A, resource_id: cdbVectorResourceId(RESOURCE_A), physical_version: 1 },
            { vector_id: VECTOR_A, resource_id: cdbVectorResourceId(RESOURCE_A), physical_version: 2 },
            { vector_id: VECTOR_B, resource_id: cdbVectorResourceId(RESOURCE_B), physical_version: 1 },
        ];
        const deletes = new Map<string, string[][]>();
        const resolveIndex = (binding: string) => ({
            upsert: () => ({ mutationId: "unused" }),
            deleteByIds(ids: readonly string[]) {
                const calls = deletes.get(binding) ?? [];
                calls.push([...ids]);
                deletes.set(binding, calls);
                return { ids, count: ids.length };
            },
            getByIds: () => [],
        });

        const first = await scrubCdbVectorRecoveryPage({
            sql: fakeSql(rows),
            resources: [RESOURCE_A, RESOURCE_B],
            resolveIndex,
            cursor: { afterVectorId: "", afterPhysicalVersion: 0 },
            limit: 2,
        });
        expect(first).toEqual({
            processed: 2,
            afterVectorId: VECTOR_A,
            afterPhysicalVersion: 2,
            done: false,
        });
        expect(deletes.get(RESOURCE_A.binding)).toEqual([
            [cdbVectorizePhysicalId(VECTOR_A, 1), cdbVectorizePhysicalId(VECTOR_A, 2)],
        ]);

        const second = await scrubCdbVectorRecoveryPage({
            sql: fakeSql(rows),
            resources: [RESOURCE_A, RESOURCE_B],
            resolveIndex,
            cursor: first,
            limit: 2,
        });
        expect(second).toEqual({
            processed: 1,
            afterVectorId: VECTOR_B,
            afterPhysicalVersion: 1,
            done: true,
        });
        expect(deletes.get(RESOURCE_B.binding)).toEqual([[cdbVectorizePhysicalId(VECTOR_B, 1)]]);
    });

    test("returns an empty terminal page when the shard has no vector ledger", async () => {
        const page = await scrubCdbVectorRecoveryPage({
            sql: fakeSql([], false),
            resources: [],
            resolveIndex: () => {
                throw new Error("unexpected provider lookup");
            },
            cursor: { afterVectorId: "", afterPhysicalVersion: 0 },
            limit: 32,
        });
        expect(page).toEqual({ processed: 0, afterVectorId: "", afterPhysicalVersion: 0, done: true });
    });

    test("starts independent Vectorize bindings in parallel", async () => {
        const rows = [
            { vector_id: VECTOR_A, resource_id: cdbVectorResourceId(RESOURCE_A), physical_version: 1 },
            { vector_id: VECTOR_B, resource_id: cdbVectorResourceId(RESOURCE_B), physical_version: 1 },
        ];
        const started: string[] = [];
        let release = () => {};
        const bothStarted = new Promise<void>(resolve => {
            release = resolve;
        });
        const scrub = scrubCdbVectorRecoveryPage({
            sql: fakeSql(rows),
            resources: [RESOURCE_A, RESOURCE_B],
            resolveIndex: binding => ({
                upsert: () => ({ mutationId: "unused" }),
                async deleteByIds(ids: readonly string[]) {
                    started.push(binding);
                    if (started.length === 2) release();
                    await bothStarted;
                    return { ids, count: ids.length };
                },
                getByIds: () => [],
            }),
            cursor: { afterVectorId: "", afterPhysicalVersion: 0 },
            limit: 2,
        });

        await expect(
            Promise.race([
                scrub,
                Bun.sleep(100).then(() => {
                    throw new Error("Vectorize binding recovery ran serially");
                }),
            ])
        ).resolves.toMatchObject({ processed: 2, done: true });
        expect(started.sort()).toEqual([RESOURCE_A.binding, RESOURCE_B.binding].sort());
    });

    test("waits for sibling binding deletes before reporting a failure", async () => {
        const rows = [
            { vector_id: VECTOR_A, resource_id: cdbVectorResourceId(RESOURCE_A), physical_version: 1 },
            { vector_id: VECTOR_B, resource_id: cdbVectorResourceId(RESOURCE_B), physical_version: 1 },
        ];
        let releaseSibling = () => {};
        const sibling = new Promise<void>(resolve => {
            releaseSibling = resolve;
        });
        let settled = false;
        const scrub = scrubCdbVectorRecoveryPage({
            sql: fakeSql(rows),
            resources: [RESOURCE_A, RESOURCE_B],
            resolveIndex: binding => ({
                upsert: () => ({ mutationId: "unused" }),
                async deleteByIds(ids: readonly string[]) {
                    if (binding === RESOURCE_A.binding) throw new Error("binding A unavailable");
                    await sibling;
                    return { ids, count: ids.length };
                },
                getByIds: () => [],
            }),
            cursor: { afterVectorId: "", afterPhysicalVersion: 0 },
            limit: 2,
        }).finally(() => {
            settled = true;
        });

        await Bun.sleep(5);
        expect(settled).toBe(false);
        releaseSibling();
        await expect(scrub).rejects.toMatchObject({ code: "CDB_SHARD_UNAVAILABLE" });
        expect(settled).toBe(true);
    });

    test("fails closed when an attempted vector has no configured resource", async () => {
        await expect(
            scrubCdbVectorRecoveryPage({
                sql: fakeSql([
                    { vector_id: VECTOR_A, resource_id: cdbVectorResourceId(RESOURCE_A), physical_version: 1 },
                ]),
                resources: [],
                resolveIndex: () => {
                    throw new Error("unexpected provider lookup");
                },
                cursor: { afterVectorId: "", afterPhysicalVersion: 0 },
                limit: 32,
            })
        ).rejects.toMatchObject({ code: "CDB_INVARIANT" });
    });
});
