import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import { CdbFileReshardStore, initializeCdbFileReshardStore } from "../../src/server/do/cdb-file-reshard-store.ts";
import { CdbFileRuntime } from "../../src/server/do/cdb-file-runtime.ts";
import { CDB_FILE_PENDING_TTL_MS, CdbFileStore, initializeFileStore } from "../../src/server/do/cdb-file-store.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { vshardOf } from "../../src/vshard.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            return {
                columnNames,
                raw: () => rawRows.values(),
                *[Symbol.iterator]() {
                    yield* rows as T[];
                },
            };
        },
    };
}

const auth = {
    userId: "user-1",
    tenantId: "org-1",
    role: "member",
    roles: ["member"],
    authEpochs: { global: 1, tenant: 1, principal: 1 },
    claims: {},
};

describe("Cdb file runtime", () => {
    let db: Database;
    let storage: DurableObjectStorage;
    let deleted: string[];
    let runtime: CdbFileRuntime;

    beforeEach(() => {
        db = new Database(":memory:");
        storage = {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        } as unknown as DurableObjectStorage;
        initializeFileStore(adaptSqlStorage(storage.sql));
        initializeCdbFileReshardStore(adaptSqlStorage(storage.sql));
        deleted = [];
        runtime = new CdbFileRuntime({
            storage,
            bucket: {
                async delete(key: string) {
                    deleted.push(key);
                },
            } as R2Bucket,
            resources: () => [
                {
                    kind: "file",
                    version: 1,
                    table: "messages",
                    column: "attachment",
                    primaryKey: "id",
                    organizationColumn: "organization_id",
                    maxSize: 8,
                    contentTypes: ["image/png"],
                },
            ],
            assertActiveEpoch: epoch => {
                if (epoch !== 2) throw new Error("stale epoch");
            },
        });
    });

    afterEach(() => db.close());

    function reserve(fileId = "file_a", nowMs = 100) {
        return runtime.reserve({
            fileId,
            organizationId: "org-1",
            table: "messages",
            column: "attachment",
            contentType: "IMAGE/PNG",
            size: 4,
            nowMs,
            domainSchemaEpoch: 2,
            auth,
        });
    }

    test("revalidates authority, epoch, locator, MIME, and size before reservation", () => {
        expect(reserve()).toMatchObject({ contentType: "image/png", status: "pending" });
        expect(() => reserve()).not.toThrow();
        expect(() =>
            runtime.reserve({
                fileId: "wrong_org",
                organizationId: "org-2",
                table: "messages",
                column: "attachment",
                contentType: "image/png",
                size: 4,
                nowMs: 100,
                domainSchemaEpoch: 2,
                auth,
            })
        ).toThrow(expect.objectContaining({ code: "CDB_FORBIDDEN" }));
        expect(() =>
            runtime.reserve({
                fileId: "bad_mime",
                organizationId: "org-1",
                table: "messages",
                column: "attachment",
                contentType: "text/plain",
                size: 4,
                nowMs: 100,
                domainSchemaEpoch: 2,
                auth,
            })
        ).toThrow(/content type/);
        expect(() =>
            runtime.reserve({
                fileId: "too_big",
                organizationId: "org-1",
                table: "messages",
                column: "attachment",
                contentType: "image/png",
                size: 9,
                nowMs: 100,
                domainSchemaEpoch: 2,
                auth,
            })
        ).toThrow(/configured column size/);
    });

    test("deletes R2 before releasing quota and preserves failures for retry", async () => {
        reserve();
        runtime.markReady({
            fileId: "file_a",
            organizationId: "org-1",
            sha256: "a".repeat(64),
            size: 4,
            nowMs: 101,
            domainSchemaEpoch: 2,
            auth,
        });
        new CdbFileStore(adaptSqlStorage(storage.sql)).queueDelete("file_a", 102);
        const deadlines: number[] = [];
        await runtime.maintain(200, async deadline => {
            deadlines.push(deadline);
        });
        expect(deleted).toEqual(["v1/org-1/file_a"]);
        expect(new CdbFileStore(adaptSqlStorage(storage.sql)).read("file_a")).toBeNull();
        expect(deadlines).toEqual([]);

        const failing = new CdbFileRuntime({
            storage,
            bucket: {
                async delete() {
                    throw new Error("R2 unavailable");
                },
            } as unknown as R2Bucket,
            resources: runtime.resources,
            assertActiveEpoch: runtime.assertActiveEpoch,
        });
        reserve("file_retry", 300);
        new CdbFileStore(adaptSqlStorage(storage.sql)).queueDelete("file_retry", 301);
        await failing.maintain(400, async deadline => {
            deadlines.push(deadline);
        });
        expect(new CdbFileStore(adaptSqlStorage(storage.sql)).read("file_retry")?.status).toBe("deleting");
        expect(deadlines).toContain(1_400);
    });

    test("expires pending and ready objects and schedules the earliest remaining deadline", async () => {
        reserve("expired_pending", 10);
        reserve("future_ready", 1_000);
        runtime.markReady({
            fileId: "future_ready",
            organizationId: "org-1",
            sha256: "b".repeat(64),
            size: 4,
            nowMs: 1_001,
            domainSchemaEpoch: 2,
            auth,
        });
        const nowMs = CDB_FILE_PENDING_TTL_MS + 20;
        const deadlines: number[] = [];
        await runtime.maintain(nowMs, async deadline => {
            deadlines.push(deadline);
        });
        expect(deleted).toEqual(["v1/org-1/expired_pending"]);
        expect(new CdbFileStore(adaptSqlStorage(storage.sql)).read("expired_pending")).toBeNull();
        expect(deadlines).toContain(1_001 + CDB_FILE_PENDING_TTL_MS);
    });

    test("accepts an idempotent deletion fence and drains R2 under the shard alarm", async () => {
        reserve("pending", 100);
        reserve("attached", 101);
        runtime.markReady({
            fileId: "attached",
            organizationId: "org-1",
            sha256: "a".repeat(64),
            size: 4,
            nowMs: 102,
            domainSchemaEpoch: 2,
            auth,
        });
        new CdbFileStore(adaptSqlStorage(storage.sql)).attach(
            "attached",
            "org-1",
            "messages",
            "attachment",
            "row-1",
            103
        );

        expect(runtime.deleteOrganization({ organizationId: "org-1", nowMs: 200, domainSchemaEpoch: 2 })).toEqual({
            organizationId: "org-1",
            accepted: true,
        });
        expect(runtime.deleteOrganization({ organizationId: "org-1", nowMs: 201, domainSchemaEpoch: 2 })).toEqual({
            organizationId: "org-1",
            accepted: true,
        });
        const store = new CdbFileStore(adaptSqlStorage(storage.sql));
        expect(store.read("pending")?.status).toBe("pending");
        expect(store.read("attached")?.status).toBe("deleting");
        expect(() => reserve("late", 202)).toThrow(expect.objectContaining({ code: "CDB_FORBIDDEN" }));

        const deadlines: number[] = [];
        await runtime.maintain(300, async deadline => {
            deadlines.push(deadline);
        });
        expect(deleted).toEqual(["v1/org-1/attached"]);
        expect(store.read("attached")).toBeNull();
        expect(store.read("pending")?.status).toBe("pending");
        expect(deadlines).toContain(100 + CDB_FILE_PENDING_TTL_MS);

        await runtime.maintain(100 + CDB_FILE_PENDING_TTL_MS, async deadline => {
            deadlines.push(deadline);
        });
        expect(deleted).toEqual(["v1/org-1/attached", "v1/org-1/pending"]);
        expect(store.organizationFileCount("org-1")).toBe(0);
        expect(store.isOrganizationDeleted("org-1")).toBe(true);
    });

    test("rechecks the deletion fence after an awaited policy read", async () => {
        reserve("attached", 100);
        runtime.markReady({
            fileId: "attached",
            organizationId: "org-1",
            sha256: "a".repeat(64),
            size: 4,
            nowMs: 101,
            domainSchemaEpoch: 2,
            auth,
        });
        new CdbFileStore(adaptSqlStorage(storage.sql)).attach(
            "attached",
            "org-1",
            "messages",
            "attachment",
            "row-1",
            102
        );
        await expect(
            runtime.resolveDownload(
                {
                    organizationId: "org-1",
                    table: "messages",
                    column: "attachment",
                    rowId: "row-1",
                    domainSchemaEpoch: 2,
                    auth,
                },
                async () => {
                    runtime.deleteOrganization({ organizationId: "org-1", nowMs: 200, domainSchemaEpoch: 2 });
                    return "attached";
                }
            )
        ).rejects.toMatchObject({ code: "CDB_FORBIDDEN" });
    });

    test("admits and captures each non-mutation metadata transition by organization", async () => {
        const events: string[] = [];
        const guarded = new CdbFileRuntime({
            storage,
            bucket: {
                async delete(key: string) {
                    events.push(`r2:${key}`);
                },
            } as R2Bucket,
            resources: runtime.resources,
            assertActiveEpoch: runtime.assertActiveEpoch,
            assertOwnership(organizationId) {
                events.push(`admit:${organizationId}`);
            },
            metadataTransaction(organizationId, callback) {
                return storage.transactionSync(() => {
                    events.push(`capture-begin:${organizationId}`);
                    const result = callback(new CdbFileStore(adaptSqlStorage(storage.sql)));
                    events.push(`capture-end:${organizationId}`);
                    return result;
                });
            },
        });
        const request = {
            fileId: "captured",
            organizationId: "org-1",
            table: "messages",
            column: "attachment",
            contentType: "image/png",
            size: 4,
            nowMs: 10,
            domainSchemaEpoch: 2,
            auth,
        } as const;
        guarded.reserve(request);
        guarded.markReady({
            fileId: request.fileId,
            organizationId: request.organizationId,
            sha256: "c".repeat(64),
            size: request.size,
            nowMs: 11,
            domainSchemaEpoch: 2,
            auth,
        });
        expect(events).toEqual([
            "admit:org-1",
            "capture-begin:org-1",
            "capture-end:org-1",
            "admit:org-1",
            "capture-begin:org-1",
            "capture-end:org-1",
        ]);

        events.length = 0;
        await guarded.maintain(CDB_FILE_PENDING_TTL_MS + 20, async () => undefined);
        expect(events).toEqual([
            "capture-begin:org-1",
            "capture-end:org-1",
            "admit:org-1",
            "r2:v1/org-1/captured",
            "capture-begin:org-1",
            "capture-end:org-1",
        ]);

        const blocked = new CdbFileRuntime({
            storage,
            bucket: undefined,
            resources: runtime.resources,
            assertActiveEpoch: runtime.assertActiveEpoch,
            assertOwnership() {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "moved" });
            },
        });
        expect(() => blocked.reserve({ ...request, fileId: "blocked", nowMs: 30 })).toThrow(
            expect.objectContaining({ code: "CDB_STALE_EPOCH" })
        );
        expect(new CdbFileStore(adaptSqlStorage(storage.sql)).read("blocked")).toBeNull();
    });

    test("filters fenced vshards before bounded maintenance selection and alarm calculation", async () => {
        const sql = adaptSqlStorage(storage.sql);
        const store = new CdbFileStore(sql);
        const ownership = new CdbFileReshardStore(sql);
        const fencedOrganization = "fenced-organization";
        const fencedVshard = vshardOf([fencedOrganization]);
        let ownedOrganization = "owned-organization-0";
        for (let suffix = 1; vshardOf([ownedOrganization]) === fencedVshard; suffix++) {
            ownedOrganization = `owned-organization-${suffix}`;
        }
        for (let index = 0; index < 33; index++) {
            store.reserve({
                fileId: `fenced-${String(index).padStart(2, "0")}`,
                organizationId: fencedOrganization,
                table: "messages",
                column: "attachment",
                contentType: "image/png",
                size: 1,
                nowMs: index + 1,
            });
        }
        store.reserve({
            fileId: "owned-file",
            organizationId: ownedOrganization,
            table: "messages",
            column: "attachment",
            contentType: "image/png",
            size: 1,
            nowMs: 100,
        });
        const identity = {
            migId: "maintenance-starvation",
            rangeLo: fencedVshard,
            rangeHi: fencedVshard,
        };
        ownership.beginSource(identity, 200);
        ownership.fenceSource(identity, 201);
        expect(store.maintenanceCandidates(1_000, { ownedOnly: true }).map(file => String(file.fileId))).toEqual([
            "owned-file",
        ]);

        const guarded = new CdbFileRuntime({
            storage,
            bucket: {
                async delete(key: string) {
                    deleted.push(key);
                },
            } as R2Bucket,
            resources: runtime.resources,
            assertActiveEpoch: runtime.assertActiveEpoch,
            assertOwnership(organizationId) {
                new CdbFileReshardStore(adaptSqlStorage(storage.sql)).assertOwnership(vshardOf([organizationId]));
            },
            metadataTransaction(organizationId, callback) {
                return storage.transactionSync(() => {
                    const transactionSql = adaptSqlStorage(storage.sql);
                    new CdbFileReshardStore(transactionSql).assertOwnership(vshardOf([organizationId]));
                    return callback(new CdbFileStore(transactionSql));
                });
            },
        });
        const deadlines: number[] = [];
        await guarded.maintain(CDB_FILE_PENDING_TTL_MS + 1_000, async deadline => {
            deadlines.push(deadline);
        });

        expect(deleted).toEqual([`v1/${ownedOrganization}/owned-file`]);
        expect(store.read("owned-file")).toBeNull();
        expect(store.read("fenced-00")?.status).toBe("pending");
        expect(store.read("fenced-32")?.status).toBe("pending");
        expect(deadlines).toEqual([]);
    });

    test("fails closed when the reshard ownership table is missing but companion state survives", async () => {
        reserve("partial-reshard", 100);
        new CdbFileStore(adaptSqlStorage(storage.sql)).queueDelete("partial-reshard", 101);
        db.run("DROP TABLE _chardb_split_file_cursor");

        await expect(runtime.maintain(200, async () => undefined)).rejects.toMatchObject({
            code: "CDB_INVARIANT",
            message: "file maintenance found incomplete reshard ownership storage",
        });
        expect(deleted).toEqual([]);
        expect(new CdbFileStore(adaptSqlStorage(storage.sql)).read("partial-reshard")?.status).toBe("deleting");
    });
});
