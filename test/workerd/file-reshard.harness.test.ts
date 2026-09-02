import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "file-reshard.entry.ts");
const BUNDLE = path.join(HERE, ".test-file-reshard.bundle.mjs");
const FILE_HASH = "a".repeat(64);

interface RpcCall {
    readonly op: string;
    readonly target: string;
    readonly body?: unknown;
    readonly recovery?: "catalog" | "cdb" | "resharder";
}

interface SeedResult {
    readonly identity: FileMoveIdentity;
    readonly movedOrganizationId: string;
    readonly outsideOrganizationId: string;
    readonly tombstoneOrganizationId: string;
    readonly retainedKeys: readonly string[];
}

interface FileMoveIdentity {
    readonly migId: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
}

interface SnapshotPage {
    readonly rows: readonly unknown[];
    readonly afterPlacement: number;
    readonly afterId: string;
    readonly done: boolean;
}

interface TombstonePage {
    readonly rows: readonly unknown[];
    readonly afterPlacement: number;
    readonly afterId: string;
    readonly done: boolean;
}

let workerSource = "";
let persistencePath = "";
let mf: Miniflare | undefined;

async function runtime(): Promise<Miniflare> {
    const instance = new Miniflare({
        modules: true,
        script: workerSource,
        durableObjects: {
            FILE_RESHARD: { className: "FileReshardProof", useSQLite: true },
            LEGACY_FILE_RESHARD: { className: "LegacyFileReshardProof", useSQLite: true },
            FILE_RUNTIME_CDB: { className: "FileRuntimeCdb", useSQLite: true },
            CDB_CATALOG: { className: "LegacyRecoveryCatalog", useSQLite: true },
            CDB_SHARD: { className: "LegacyRecoveryCdb", useSQLite: true },
            CDB_RESHARD: { className: "LegacyRecoveryResharder", useSQLite: true },
        },
        durableObjectsPersist: persistencePath,
        r2Buckets: ["CDB_FILES"],
        r2Persist: persistencePath,
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
    await instance.ready;
    return instance;
}

async function rpc<T>({ op, target, body, recovery }: RpcCall): Promise<T> {
    if (!mf) throw new Error("miniflare not initialized");
    const params = new URLSearchParams({ name: target });
    if (recovery) params.set("recovery", recovery);
    const response = await mf.dispatchFetch(`http://example.com/${op}?${params.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    const payload = (await response.json()) as { readonly result?: T; readonly error?: string };
    if (!response.ok) throw new Error(payload.error ?? `RPC ${op}/${target} failed with ${response.status}`);
    return payload.result as T;
}

async function copySnapshot(identity: FileMoveIdentity, source: string, destination: string): Promise<number> {
    let afterPlacement = -1;
    let afterFileId = "";
    let copied = 0;
    let done = false;
    do {
        const page = await rpc<SnapshotPage>({
            op: "readSnapshot",
            target: source,
            body: { ...identity, afterPlacement, afterFileId, limit: 500 },
        });
        await rpc({ op: "applySnapshot", target: destination, body: { identity, rows: page.rows } });
        copied += page.rows.length;
        afterPlacement = page.afterPlacement;
        afterFileId = page.afterId;
        done = page.done;
    } while (!done);
    return copied;
}

async function copyTombstones(identity: FileMoveIdentity, source: string, destination: string): Promise<number> {
    let afterPlacement = -1;
    let afterOrganizationId = "";
    let copied = 0;
    let done = false;
    do {
        const page = await rpc<TombstonePage>({
            op: "readTombstones",
            target: source,
            body: { ...identity, afterPlacement, afterOrganizationId, limit: 500 },
        });
        await rpc({ op: "applyTombstones", target: destination, body: { identity, rows: page.rows } });
        copied += page.rows.length;
        afterPlacement = page.afterPlacement;
        afterOrganizationId = page.afterId;
        done = page.done;
    } while (!done);
    return copied;
}

function runtimeAuth(organizationId: string) {
    return {
        userId: "runtime-user",
        tenantId: organizationId,
        role: "member",
        roles: ["member"],
        authEpochs: { global: 1, tenant: 1, principal: 1 },
        claims: {},
    };
}

async function evictRuntime(target: string): Promise<void> {
    if (!mf) throw new Error("miniflare not initialized");
    await mf.unsafeEvictDurableObject("", "FileRuntimeCdb", { name: target });
}

async function evictFileProof(target: string): Promise<void> {
    if (!mf) throw new Error("miniflare not initialized");
    await mf.unsafeEvictDurableObject("", "FileReshardProof", { name: target });
}

async function evictLegacyProof(target: string): Promise<void> {
    if (!mf) throw new Error("miniflare not initialized");
    await mf.unsafeEvictDurableObject("", "LegacyFileReshardProof", { name: target });
}

beforeAll(async () => {
    persistencePath = await mkdtemp(path.join(tmpdir(), "chardb-file-reshard-workerd-"));
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
        if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
        workerSource = await Bun.file(BUNDLE).text();
    } finally {
        await rm(BUNDLE, { force: true });
    }
    mf = await runtime();
});

afterAll(async () => {
    await disposeMiniflareBounded(mf, { label: "file reshard fixture final teardown" });
    mf = undefined;
    if (persistencePath) await rm(persistencePath, { recursive: true, force: true });
});

describe("native file metadata resharding", () => {
    test("drives real Cdb file wrappers through route admission and external capture", async () => {
        const source = "runtime-wrapper-source";
        const sourceOrganization = "runtime-wrapper-source-org";
        const sourceMigration = "runtime-wrapper-capture";
        const sourceFileId = `fil_${"a".repeat(64)}`;
        await expect(rpc({ op: "_activateSchema", target: source })).resolves.toMatchObject({
            activeVersion: 1,
            activeEpoch: 2,
        });
        await rpc({
            op: "_beginSourceCapture",
            target: source,
            body: { migId: sourceMigration, organizationId: sourceOrganization },
        });
        const sourceNow = Date.now() + 60_000;
        await expect(
            rpc({
                op: "reserveFile",
                target: source,
                body: {
                    fileId: sourceFileId,
                    organizationId: sourceOrganization,
                    table: "runtime_file_messages",
                    column: "attachment",
                    contentType: "image/png",
                    size: 4,
                    nowMs: sourceNow,
                    recoveryGeneration: 0,
                    schemaEpoch: 1,
                    domainSchemaEpoch: 2,
                    auth: runtimeAuth(sourceOrganization),
                },
            })
        ).resolves.toMatchObject({ fileId: sourceFileId, status: "pending" });
        await expect(
            rpc({
                op: "markFileReady",
                target: source,
                body: {
                    fileId: sourceFileId,
                    organizationId: sourceOrganization,
                    sha256: FILE_HASH,
                    size: 4,
                    nowMs: sourceNow + 1,
                    recoveryGeneration: 0,
                    schemaEpoch: 1,
                    domainSchemaEpoch: 2,
                    auth: runtimeAuth(sourceOrganization),
                },
            })
        ).resolves.toMatchObject({ fileId: sourceFileId, status: "ready" });
        await expect(
            rpc({
                op: "deleteOrganizationFiles",
                target: source,
                body: {
                    organizationId: sourceOrganization,
                    nowMs: sourceNow + 2,
                    recoveryGeneration: 0,
                    domainSchemaEpoch: 2,
                },
            })
        ).resolves.toEqual({ organizationId: sourceOrganization, accepted: true });
        const capture = await rpc<
            readonly { lsn: number; source_tx_id: number; op: string; table_name: string; pk: string }[]
        >({ op: "_captureLog", target: source, body: { migId: sourceMigration } });
        expect(capture).toEqual([
            expect.objectContaining({
                lsn: 1,
                source_tx_id: -1,
                op: "ins",
                table_name: "_chardb_files",
                pk: sourceFileId,
            }),
            expect.objectContaining({
                lsn: 2,
                source_tx_id: -2,
                op: "upd",
                table_name: "_chardb_files",
                pk: sourceFileId,
            }),
            expect.objectContaining({
                lsn: 3,
                source_tx_id: -3,
                op: "ins",
                table_name: "_chardb_deleted_organizations",
                pk: sourceOrganization,
            }),
            expect.objectContaining({
                lsn: 4,
                source_tx_id: -3,
                op: "upd",
                table_name: "_chardb_files",
                pk: sourceFileId,
            }),
        ]);

        const destination = "runtime-wrapper-destination";
        const destinationOrganization = "runtime-wrapper-destination-org";
        const destinationMigration = "runtime-wrapper-destination";
        const destinationFileId = `fil_${"b".repeat(64)}`;
        await rpc({ op: "_activateSchema", target: destination });
        await rpc({
            op: "_prepareDestination",
            target: destination,
            body: {
                migId: destinationMigration,
                organizationId: destinationOrganization,
                destinationGeneration: 2,
            },
        });
        const destinationRequest = {
            fileId: destinationFileId,
            organizationId: destinationOrganization,
            table: "runtime_file_messages",
            column: "attachment",
            contentType: "image/png",
            size: 4,
            nowMs: sourceNow,
            recoveryGeneration: 0,
            schemaEpoch: 2,
            domainSchemaEpoch: 2,
            auth: runtimeAuth(destinationOrganization),
        };
        await expect(rpc({ op: "reserveFile", target: destination, body: destinationRequest })).rejects.toThrow(
            "CDB_STALE_EPOCH"
        );
        await rpc({
            op: "_activateDestination",
            target: destination,
            body: { migId: destinationMigration, organizationId: destinationOrganization },
        });
        await evictRuntime(destination);
        await expect(rpc({ op: "reserveFile", target: destination, body: destinationRequest })).resolves.toMatchObject({
            fileId: destinationFileId,
            status: "pending",
        });
        await rpc({
            op: "markFileReady",
            target: destination,
            body: {
                fileId: destinationFileId,
                organizationId: destinationOrganization,
                sha256: FILE_HASH,
                size: 4,
                nowMs: sourceNow + 1,
                recoveryGeneration: 0,
                schemaEpoch: 2,
                domainSchemaEpoch: 2,
                auth: runtimeAuth(destinationOrganization),
            },
        });
        await rpc({
            op: "_attachRow",
            target: destination,
            body: { organizationId: destinationOrganization, fileId: destinationFileId, rowId: "row-destination" },
        });
        await expect(
            rpc({
                op: "resolveFileDownload",
                target: destination,
                body: {
                    organizationId: destinationOrganization,
                    table: "runtime_file_messages",
                    column: "attachment",
                    rowId: "row-destination",
                    recoveryGeneration: 0,
                    schemaEpoch: 2,
                    domainSchemaEpoch: 2,
                    auth: runtimeAuth(destinationOrganization),
                },
            })
        ).resolves.toMatchObject({ fileId: destinationFileId, status: "attached", rowId: "row-destination" });
        await expect(
            rpc({
                op: "reserveFile",
                target: destination,
                body: { ...destinationRequest, fileId: `fil_${"c".repeat(64)}`, recoveryGeneration: 0, schemaEpoch: 1 },
            })
        ).rejects.toThrow("CDB_STALE_EPOCH");
    }, 30_000);

    test("rechecks native file ownership after an awaited download read", async () => {
        const target = "runtime-download-race";
        const organizationId = "runtime-download-race-org";
        const fileId = `fil_${"d".repeat(64)}`;
        const rowId = "row-download-race";
        const nowMs = Date.now() + 60_000;
        await rpc({ op: "_activateSchema", target });
        await rpc({
            op: "reserveFile",
            target,
            body: {
                fileId,
                organizationId,
                table: "runtime_file_messages",
                column: "attachment",
                contentType: "image/png",
                size: 4,
                nowMs,
                recoveryGeneration: 0,
                schemaEpoch: 1,
                domainSchemaEpoch: 2,
                auth: runtimeAuth(organizationId),
            },
        });
        await rpc({
            op: "markFileReady",
            target,
            body: {
                fileId,
                organizationId,
                sha256: FILE_HASH,
                size: 4,
                nowMs: nowMs + 1,
                recoveryGeneration: 0,
                schemaEpoch: 1,
                domainSchemaEpoch: 2,
                auth: runtimeAuth(organizationId),
            },
        });
        await rpc({ op: "_attachRow", target, body: { organizationId, fileId, rowId } });
        await expect(
            rpc({
                op: "resolveFileDownload",
                target,
                body: {
                    organizationId,
                    table: "runtime_file_messages",
                    column: "attachment",
                    rowId,
                    recoveryGeneration: 0,
                    schemaEpoch: 1,
                    domainSchemaEpoch: 2,
                    auth: runtimeAuth(organizationId),
                },
            })
        ).resolves.toMatchObject({ fileId, status: "attached" });
        const migId = "runtime-download-race";
        await rpc({ op: "_beginSourceCapture", target, body: { migId, organizationId } });
        await expect(
            rpc({
                op: "_resolveDownloadAfterFence",
                target,
                body: {
                    migId,
                    organizationId,
                    fileId,
                    rowId,
                    recoveryGeneration: 0,
                    domainSchemaEpoch: 2,
                    auth: runtimeAuth(organizationId),
                },
            })
        ).rejects.toThrow("CDB_STALE_EPOCH");
    }, 30_000);

    test("captures maintenance ordering and filters fenced work after cold restart", async () => {
        const captureTarget = "runtime-maintenance-capture";
        const captureOrganization = "runtime-maintenance-capture-org";
        const captureFileId = `fil_${"e".repeat(64)}`;
        const captureMigration = "runtime-maintenance-capture";
        await rpc({ op: "_activateSchema", target: captureTarget });
        const captureSeed = await rpc<{ objectKey: string }>({
            op: "_seedPending",
            target: captureTarget,
            body: { organizationId: captureOrganization, fileId: captureFileId, nowMs: 1 },
        });
        await rpc({
            op: "_beginSourceCapture",
            target: captureTarget,
            body: { migId: captureMigration, organizationId: captureOrganization },
        });
        await evictRuntime(captureTarget);
        await expect(rpc({ op: "_runFileMaintenance", target: captureTarget })).resolves.toEqual({ alarm: null });
        await expect(
            rpc({
                op: "_inspectRuntimeFile",
                target: captureTarget,
                body: { fileId: captureFileId, objectKey: captureSeed.objectKey },
            })
        ).resolves.toEqual({ stored: null, objectPresent: false });
        const maintenanceCapture = await rpc<
            readonly { source_tx_id: number; op: string; table_name: string; pk: string }[]
        >({ op: "_captureLog", target: captureTarget, body: { migId: captureMigration } });
        expect(maintenanceCapture).toEqual([
            expect.objectContaining({
                source_tx_id: -1,
                op: "upd",
                table_name: "_chardb_files",
                pk: captureFileId,
            }),
            expect.objectContaining({
                source_tx_id: -2,
                op: "del",
                table_name: "_chardb_files",
                pk: captureFileId,
            }),
        ]);

        const starvationTarget = "runtime-maintenance-starvation";
        const starvation = await rpc<{ ownedFileId: string; ownedObjectKey: string }>({
            op: "_seedMaintenanceStarvation",
            target: starvationTarget,
            body: {
                fencedOrganizationId: "runtime-maintenance-fenced-org",
                ownedOrganizationId: "runtime-maintenance-owned-org",
                migId: "runtime-maintenance-fenced",
            },
        });
        await rpc({ op: "_activateSchema", target: starvationTarget });
        await evictRuntime(starvationTarget);
        await expect(rpc({ op: "_runFileMaintenance", target: starvationTarget })).resolves.toEqual({ alarm: null });
        await expect(
            rpc({
                op: "_inspectRuntimeFile",
                target: starvationTarget,
                body: { fileId: starvation.ownedFileId, objectKey: starvation.ownedObjectKey },
            })
        ).resolves.toEqual({ stored: null, objectPresent: false });
        await expect(
            rpc({
                op: "_inspectRuntimeFile",
                target: starvationTarget,
                body: { fileId: "fenced-00" },
            })
        ).resolves.toMatchObject({ stored: { status: "pending" } });
    }, 30_000);

    test("moves every lifecycle state without touching R2 and survives activation response loss", async () => {
        const sourceName = "source-main";
        const destinationName = "destination-main";
        const seed = await rpc<SeedResult>({ op: "seed", target: sourceName });
        await rpc({ op: "beginSource", target: sourceName, body: seed.identity });
        await rpc({ op: "beginDest", target: destinationName, body: seed.identity });

        expect(await copyTombstones(seed.identity, sourceName, destinationName)).toBe(1);
        expect(await copySnapshot(seed.identity, sourceName, destinationName)).toBe(4);
        await expect(rpc({ op: "maintain", target: destinationName, body: { nowMs: 10_000_000 } })).resolves.toEqual({
            schedules: [],
        });
        expect(await rpc<{ puts: number; deletes: number }>({ op: "objectOperations", target: sourceName })).toEqual({
            puts: 5,
            deletes: 0,
        });

        await rpc({ op: "fence", target: sourceName, body: seed.identity });
        await expect(
            rpc({ op: "activateThenLoseResponse", target: destinationName, body: seed.identity })
        ).rejects.toThrow("simulated response loss after file destination activation");
        await evictFileProof(destinationName);
        await expect(rpc({ op: "activate", target: destinationName, body: seed.identity })).resolves.toEqual({
            activated: false,
        });
        await expect(
            rpc({
                op: "delete",
                target: sourceName,
                body: { organizationId: seed.movedOrganizationId, fileId: `fil_${"4".repeat(64)}` },
            })
        ).rejects.toThrow("CDB_STALE_EPOCH");
        await expect(rpc({ op: "validate", target: destinationName, body: seed.identity })).resolves.toEqual({
            done: true,
            checked: 5,
        });

        const destination = await rpc<Record<string, unknown>>({ op: "inspect", target: destinationName });
        expect(destination).toMatchObject({
            states: ["attached", "deleting", "pending", "ready"],
            tombstonedOrganizations: [seed.tombstoneOrganizationId],
            maintenanceEnabled: true,
        });
        const source = await rpc<Record<string, unknown>>({ op: "inspect", target: sourceName });
        expect(source).toMatchObject({ outsideOrganizations: [seed.outsideOrganizationId] });
        expect(await rpc<{ puts: number; deletes: number }>({ op: "objectOperations", target: sourceName })).toEqual({
            puts: 5,
            deletes: 0,
        });
        for (const objectKey of seed.retainedKeys) {
            await expect(rpc({ op: "object", target: sourceName, body: { objectKey } })).resolves.toMatchObject({
                present: true,
            });
        }
    }, 30_000);

    test("enforces file ownership on both sides of cutover, including ready after an immutable put", async () => {
        const sourceName = "source-route";
        const destinationName = "destination-route";
        const seed = await rpc<SeedResult>({ op: "seed", target: sourceName, body: { suffix: "route" } });
        await rpc({ op: "beginSource", target: sourceName, body: seed.identity });
        await rpc({ op: "beginDest", target: destinationName, body: seed.identity });
        const fileId = `fil_${"c".repeat(64)}`;
        await rpc({
            op: "reserve",
            target: sourceName,
            body: { organizationId: seed.movedOrganizationId, fileId, recoveryGeneration: 0, schemaEpoch: 1 },
        });
        await rpc({ op: "put", target: sourceName, body: { organizationId: seed.movedOrganizationId, fileId } });
        await copyTombstones(seed.identity, sourceName, destinationName);
        expect(await copySnapshot(seed.identity, sourceName, destinationName)).toBe(5);
        await rpc({ op: "fence", target: sourceName, body: seed.identity });
        await expect(
            rpc({
                op: "ready",
                target: sourceName,
                body: { organizationId: seed.movedOrganizationId, fileId, recoveryGeneration: 0, schemaEpoch: 1 },
            })
        ).rejects.toThrow("CDB_STALE_EPOCH");
        await expect(
            rpc({
                op: "reserve",
                target: destinationName,
                body: { organizationId: seed.movedOrganizationId, fileId, recoveryGeneration: 0, schemaEpoch: 2 },
            })
        ).rejects.toThrow("CDB_STALE_EPOCH");
        await rpc({ op: "activate", target: destinationName, body: seed.identity });
        await expect(
            rpc({
                op: "ready",
                target: destinationName,
                body: { organizationId: seed.movedOrganizationId, fileId, recoveryGeneration: 0, schemaEpoch: 2 },
            })
        ).resolves.toMatchObject({ fileId, status: "ready" });
        await expect(
            rpc({
                op: "delete",
                target: sourceName,
                body: { organizationId: seed.movedOrganizationId, fileId, recoveryGeneration: 0, schemaEpoch: 1 },
            })
        ).rejects.toThrow("CDB_STALE_EPOCH");
    }, 30_000);

    test("abort is exact after response loss and delayed apply cannot cross its durable fence", async () => {
        const sourceName = "source-abort";
        const destinationName = "destination-abort";
        const seed = await rpc<SeedResult>({ op: "seed", target: sourceName, body: { suffix: "abort" } });
        await rpc({ op: "beginSource", target: sourceName, body: seed.identity });
        await rpc({ op: "beginDest", target: destinationName, body: seed.identity });
        const page = await rpc<SnapshotPage>({
            op: "readSnapshot",
            target: sourceName,
            body: { ...seed.identity, afterPlacement: -1, afterFileId: "", limit: 500 },
        });
        await expect(
            rpc({
                op: "applySnapshotThenLoseResponse",
                target: destinationName,
                body: { identity: seed.identity, rows: page.rows },
            })
        ).rejects.toThrow("simulated response loss after file snapshot apply");
        await evictFileProof(destinationName);
        await expect(
            rpc({ op: "applySnapshot", target: destinationName, body: { identity: seed.identity, rows: page.rows } })
        ).resolves.toEqual({ applied: 4, inserted: 0 });
        await expect(rpc({ op: "abort", target: destinationName, body: seed.identity })).resolves.toEqual({
            afterKind: "file",
            afterId: `fil_${"4".repeat(64)}`,
            deleted: 4,
            done: true,
        });
        await evictFileProof(destinationName);
        await expect(
            rpc({ op: "applySnapshot", target: destinationName, body: { identity: seed.identity, rows: page.rows } })
        ).rejects.toThrow("aborted");
        expect(await rpc<{ puts: number; deletes: number }>({ op: "objectOperations", target: sourceName })).toEqual({
            puts: 5,
            deletes: 0,
        });
        const source = await rpc<Record<string, unknown>>({ op: "inspect", target: sourceName });
        expect(source).toMatchObject({ states: ["attached", "deleting", "pending", "ready"] });
    }, 30_000);

    test("fails closed on malformed placement, object-key drift, collisions, and old nonempty schemas", async () => {
        const cases = ["malformed-placement", "object-key-drift", "destination-collision"];
        for (const scenario of cases) {
            await expect(
                rpc({ op: "unsupported", target: `legacy-${scenario}`, body: { scenario } })
            ).rejects.toThrow();
        }
        await expect(
            rpc({ op: "unsupported", target: "legacy-old-empty-schema", body: { scenario: "old-empty-schema" } })
        ).resolves.toEqual({ accepted: true, rowsBackfilled: 0 });
        await expect(
            rpc({ op: "unsupported", target: "legacy-old-nonempty-schema", body: { scenario: "old-nonempty-schema" } })
        ).resolves.toEqual({ accepted: true, rowsBackfilled: 2 });
    }, 30_000);

    test("fails closed on legacy snapshot provenance and aborts without touching the shared object", async () => {
        const source = "legacy-active-source";
        const destination = "legacy-active-destination";
        const objectKey = `v1/org-legacy-active-recovery/fil_${"a".repeat(64)}`;
        const sourceRecovery = await rpc<Record<string, unknown>>({
            op: "legacyActiveRecovery",
            target: source,
            body: { role: "source" },
        });
        expect(sourceRecovery).toMatchObject({
            snapshotColumn: true,
            nullProvenanceBefore: 0,
            replayError: null,
            outcome: "aborted",
            metadataRows: 1,
            ledgerRows: 0,
            objectPresent: true,
        });
        const destinationRecovery = await rpc<Record<string, unknown>>({
            op: "legacyActiveRecovery",
            target: destination,
            body: { role: "dest" },
        });
        expect(destinationRecovery).toMatchObject({
            snapshotColumn: true,
            nullProvenanceBefore: 1,
            replayError: expect.stringContaining("was created by tail before snapshot apply"),
            outcome: "aborted",
            metadataRows: 0,
            ledgerRows: 0,
            objectPresent: true,
        });

        await evictLegacyProof(source);
        await evictLegacyProof(destination);
        await expect(rpc({ op: "legacyRecoveryState", target: source, body: { objectKey } })).resolves.toMatchObject({
            outcome: "aborted",
            metadataRows: 1,
            ledgerRows: 0,
            objectPresent: true,
        });
        await expect(
            rpc({ op: "legacyRecoveryState", target: destination, body: { objectKey } })
        ).resolves.toMatchObject({ outcome: "aborted", metadataRows: 0, ledgerRows: 0, objectPresent: true });
    }, 30_000);

    test("recovers legacy phase three from either exact Catalog owner without replaying unknown tail", async () => {
        const table = {
            name: "messages",
            partitionColumn: "organization_id",
            columns: ["id", "organization_id", "body"],
        };
        for (const owner of ["source", "destination"] as const) {
            const migId = `legacy_recovery_${owner}`;
            const source = `legacy-recovery-source-${owner}`;
            const destination = `legacy-recovery-destination-${owner}`;
            const split = {
                migId,
                srcShard: source,
                dstShard: destination,
                rangeLo: owner === "source" ? 301 : 302,
                rangeHi: owner === "source" ? 301 : 302,
                epochAtStart: 7,
                tables: [table],
            };
            await rpc({
                op: "fixtureSetOwner",
                target: "global",
                recovery: "catalog",
                body: { migId, owner },
            });
            await rpc({ op: "fixtureSetup", target: source, recovery: "cdb", body: { migId, role: "source" } });
            await rpc({
                op: "fixtureSetup",
                target: destination,
                recovery: "cdb",
                body: { migId, role: "dest" },
            });
            await expect(
                rpc({ op: "fixtureSeedPhaseThree", target: "global", recovery: "resharder", body: split })
            ).resolves.toEqual({ phase: 3 });

            if (!mf) throw new Error("miniflare not initialized");
            for (const [className, name] of [
                ["LegacyRecoveryCdb", source],
                ["LegacyRecoveryCdb", destination],
                ["LegacyRecoveryResharder", "global"],
                ["LegacyRecoveryCatalog", "global"],
            ] as const) {
                try {
                    await mf.unsafeEvictDurableObject("", className, { name });
                } catch (error) {
                    if (!(error instanceof Error) || !error.message.includes("not currently running")) throw error;
                }
            }

            const recovered = await rpc<{ action: string; phase: number }>({
                op: "recoverLegacyFileMovement",
                target: "global",
                recovery: "resharder",
                body: migId,
            });
            expect(recovered).toEqual({
                action: owner === "source" ? "aborted" : "resumed",
                phase: owner === "source" ? -1 : 4,
            });
            const catalogTimeline = await rpc<readonly string[]>({
                op: "fixtureTimeline",
                target: "global",
                recovery: "catalog",
                body: { migId },
            });
            const sourceTimeline = await rpc<readonly string[]>({
                op: "fixtureTimeline",
                target: source,
                recovery: "cdb",
                body: { migId },
            });
            const destinationTimeline = await rpc<readonly string[]>({
                op: "fixtureTimeline",
                target: destination,
                recovery: "cdb",
                body: { migId },
            });
            if (owner === "source") {
                expect(catalogTimeline).toEqual(["routing-status", "catalog-abort"]);
                expect(sourceTimeline).toEqual(["cancel-fence", "abort-source-files", "abort-source"]);
                expect(destinationTimeline).toEqual(["provenance", "dest-fence", "abort-dest-files", "abort-dest"]);
            } else {
                expect(catalogTimeline).toEqual(["routing-status"]);
                expect(sourceTimeline).toEqual([]);
                expect(destinationTimeline).toEqual([
                    "provenance",
                    "prepare-destination",
                    "activate-files",
                    "activate-destination",
                ]);
                if (!mf) throw new Error("miniflare not initialized");
                for (const [className, name] of [
                    ["LegacyRecoveryCdb", source],
                    ["LegacyRecoveryCdb", destination],
                    ["LegacyRecoveryResharder", "global"],
                ] as const) {
                    try {
                        await mf.unsafeEvictDurableObject("", className, { name });
                    } catch (error) {
                        if (!(error instanceof Error) || !error.message.includes("not currently running")) throw error;
                    }
                }
                let phase = recovered.phase;
                for (let step = 0; step < 8 && phase === 4; step++) {
                    phase = (
                        await rpc<{ phase: number }>({
                            op: "runSplit",
                            target: "global",
                            recovery: "resharder",
                            body: migId,
                        })
                    ).phase;
                }
                expect(phase).toBe(5);
                expect(
                    await rpc<readonly string[]>({
                        op: "fixtureTimeline",
                        target: source,
                        recovery: "cdb",
                        body: { migId },
                    })
                ).toEqual(["stop-capture", "stop-files", "drop-range", "stop-capture", "stop-files", "drain-files"]);
            }
        }
    }, 30_000);
});
