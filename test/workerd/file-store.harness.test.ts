import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded, restartMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "file-store.entry.ts");
const BUNDLE = path.join(HERE, ".test-file-store.bundle.mjs");

let source = "";
let persistencePath = "";
let mf: Miniflare | undefined;

function createRuntime(): Miniflare {
    return new Miniflare({
        modules: true,
        script: source,
        durableObjects: {
            CDB_SHARD: { className: "FileStoreProof", useSQLite: true },
            CDB_CATALOG: { className: "FileCatalogProof", useSQLite: true },
        },
        durableObjectsPersist: persistencePath,
        r2Buckets: ["CDB_FILES"],
        r2Persist: persistencePath,
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
}

async function startRuntime(): Promise<Miniflare> {
    const started = await restartMiniflareBounded(undefined, createRuntime, {
        settleDelayMs: 0,
        label: "file store fixture startup",
    });
    return started.instance;
}

beforeAll(async () => {
    persistencePath = await mkdtemp(path.join(tmpdir(), "chardb-file-store-workerd-"));
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
        source = await Bun.file(BUNDLE).text();
    } finally {
        await rm(BUNDLE, { force: true });
    }
    mf = await startRuntime();
});

afterAll(async () => {
    await disposeMiniflareBounded(mf, { label: "file store fixture final teardown" });
    mf = undefined;
    if (persistencePath) await rm(persistencePath, { recursive: true, force: true });
});

describe("Cdb file store on real Durable Object SQLite", () => {
    test("preserves exact lifecycle state, rollback, and cleanup order across reconstruction", async () => {
        if (!mf) throw new Error("miniflare not initialized");
        const uploadUrl =
            "http://example.com/_chardb/files/upload?organizationId=org-1&table=messages&column=attachment";
        const uploadRequest = () =>
            mf?.dispatchFetch(uploadUrl, {
                method: "PUT",
                headers: { "content-type": "image/png", "idempotency-key": "workerd-upload" },
                body: "upload-proof",
            });
        const uploadResponse = await uploadRequest();
        if (!uploadResponse) throw new Error("miniflare not initialized");
        if (!uploadResponse.ok)
            throw new Error(`upload failed ${uploadResponse.status}: ${await uploadResponse.text()}`);
        const firstUpload = (await uploadResponse.json()) as {
            readonly file: { readonly fileId: string; readonly size: number; readonly sha256: string };
        };
        const retryResponse = await uploadRequest();
        if (!retryResponse) throw new Error("miniflare not initialized");
        const retriedUpload = await retryResponse.json();
        expect(retriedUpload).toEqual(firstUpload);
        expect(firstUpload.file).toMatchObject({ size: 12 });
        expect(firstUpload.file.fileId).toMatch(/^fil_[0-9a-f]{64}$/);
        expect(firstUpload.file.sha256).toMatch(/^[0-9a-f]{64}$/);
        const uploaded = (await (
            await mf.dispatchFetch(`http://example.com/object?fileId=${firstUpload.file.fileId}`)
        ).json()) as {
            readonly object: { readonly customMetadata: Record<string, string> };
        };
        expect(uploaded.object.customMetadata).toEqual({
            chardbRetainedSha256: firstUpload.file.sha256,
            chardbRetainedSize: "12",
        });
        const seeded = (await (await mf.dispatchFetch("http://example.com/seed")).json()) as Record<string, unknown>;
        expect(seeded).toMatchObject({
            rolledBack: true,
            dueDeletes: ["file_abandoned", "file_old"],
            rows: [
                {
                    file_id: firstUpload.file.fileId,
                    status: "ready",
                    row_id: null,
                    size: 12,
                    sha256: firstUpload.file.sha256,
                },
                { file_id: "file_abandoned", status: "deleting", row_id: null, size: 2, sha256: null },
                { file_id: "file_new", status: "attached", row_id: "row-1", size: 5, sha256: HASH_B },
                { file_id: "file_old", status: "deleting", row_id: "row-1", size: 4, sha256: HASH_A },
            ],
        });
        expect(JSON.stringify(seeded)).not.toContain("file_rollback");

        const downloadUrl =
            "http://example.com/_chardb/files/download?organizationId=org-1&table=messages&column=attachment&rowId=row-1";
        const downloaded = await mf.dispatchFetch(downloadUrl);
        expect(downloaded.status).toBe(200);
        expect(await downloaded.text()).toBe("newer");
        expect(downloaded.headers.get("content-type")).toBe("image/png");
        expect(downloaded.headers.get("content-disposition")).toBe("attachment");
        expect(downloaded.headers.get("content-security-policy")).toBe("sandbox");
        expect(downloaded.headers.get("cross-origin-resource-policy")).toBe("same-origin");
        expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");

        const cleanupResponse = await mf.dispatchFetch(`http://example.com/cleanup?fileId=${firstUpload.file.fileId}`);
        const cleanupBody = await cleanupResponse.text();
        if (!cleanupResponse.ok) {
            throw new Error(`cleanup failed ${cleanupResponse.status}: ${cleanupBody}`);
        }
        let cleaned: Record<string, unknown>;
        try {
            cleaned = JSON.parse(cleanupBody) as Record<string, unknown>;
        } catch {
            throw new Error(`cleanup returned invalid JSON ${cleanupResponse.status}: ${cleanupBody}`);
        }
        expect(cleaned).toMatchObject({
            dueDeletes: [],
            schedules: [900_090],
            objects: { old: false, replacement: true, abandoned: false, upload: true },
            rows: [
                {
                    file_id: firstUpload.file.fileId,
                    status: "ready",
                    row_id: null,
                    size: 12,
                    sha256: firstUpload.file.sha256,
                },
                { file_id: "file_new", status: "attached", row_id: "row-1", size: 5, sha256: HASH_B },
            ],
        });

        const deletion = (await (await mf.dispatchFetch("http://example.com/bulk-delete")).json()) as Record<
            string,
            unknown
        >;
        expect(deletion).toMatchObject({
            accepted: { organizationId: "org-bulk", accepted: true },
            afterFirst: { remaining: 8, due: 8 },
            afterSecond: { remaining: 0, due: 0 },
            deletedObjectsRemaining: 0,
            survivor: { body: "survivor", size: 8 },
            survivorMetadata: { organizationId: "org-safe", status: "ready", size: 8 },
            tombstoned: true,
        });

        const restarted = await restartMiniflareBounded(mf, createRuntime, {
            label: "file store reconstruction",
        });
        mf = restarted.instance;
        const reconstructed = await (await mf.dispatchFetch("http://example.com/inspect")).json();
        expect(reconstructed).toEqual({
            rows: [
                ...((cleaned.rows as readonly unknown[]) ?? []),
                {
                    file_id: "survivor",
                    object_key: "v1/org-safe/survivor",
                    status: "ready",
                    row_id: null,
                    size: 8,
                    sha256: HASH_SURVIVOR,
                },
            ],
            dueDeletes: cleaned.dueDeletes,
        });
        const reconstructedDownload = await mf.dispatchFetch(downloadUrl);
        expect(reconstructedDownload.status).toBe(200);
        expect(await reconstructedDownload.text()).toBe("newer");
        const deletionState = await (
            await mf.dispatchFetch("http://example.com/deletion-state?organizationId=org-bulk")
        ).json();
        expect(deletionState).toEqual({ organizationId: "org-bulk", tombstoned: true, remaining: 0 });
        const survivor = (await (await mf.dispatchFetch("http://example.com/object?fileId=survivor")).json()) as {
            readonly object: { readonly size: number } | null;
            readonly stored: { readonly organizationId: string; readonly status: string } | null;
        };
        expect(survivor).toMatchObject({
            object: { size: 8 },
            stored: { organizationId: "org-safe", status: "ready" },
        });
    }, 20_000);
});

const HASH_A = "f28d6cfd0ebc466e6358e1f4f90edc071d0ba3d413255cdc0ec7917189033ad8";
const HASH_B = "804f51f71254c4081e37e7c887073560f4a6fa6cdad202e9ac67e032c43ed1e1";
const HASH_SURVIVOR = "7a01ac37408614bcf58069bb6b6a543f6c473cdded552c491de4eb36aacce235";
