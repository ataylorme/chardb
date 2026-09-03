import { describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import { FileId } from "../../src/files/index.ts";
import type { AuthCtx } from "../../src/server/define.ts";
import type { OrganizationFileUploadCdb } from "../../src/server/organization-file-upload.ts";
import { uploadOrganizationFile } from "../../src/server/organization-file-upload.ts";

const auth: AuthCtx = {
    userId: "user-1",
    tenantId: "org-1",
    role: "member",
    roles: ["member"],
    authEpochs: { global: 1, tenant: 1, principal: 1 },
    claims: {},
};

function fixture() {
    const calls: string[] = [];
    const objects = new Map<
        string,
        { readonly key: string; readonly size: number; readonly customMetadata: Record<string, string> }
    >();
    const bucket = {
        async put(key: string, value: Uint8Array, options: R2PutOptions) {
            calls.push("r2.put");
            if (objects.has(key)) return null;
            const object = { key, size: value.byteLength, customMetadata: options.customMetadata ?? {} };
            objects.set(key, object);
            return object;
        },
        async head(key: string) {
            calls.push("r2.head");
            return objects.get(key) ?? null;
        },
        async delete(key: string) {
            calls.push("r2.delete");
            objects.delete(key);
        },
    } as unknown as R2Bucket;
    let status: "pending" | "ready" = "pending";
    const cdb: OrganizationFileUploadCdb = {
        async reserveFile(request) {
            calls.push("cdb.reserve");
            return {
                fileId: request.fileId as never,
                organizationId: request.organizationId,
                table: request.table,
                column: request.column,
                objectKey: `v1/${request.organizationId}/${request.fileId}`,
                contentType: request.contentType.toLowerCase(),
                size: request.size,
                sha256: null,
                status,
                rowId: null,
                createdAt: request.nowMs,
                updatedAt: request.nowMs,
            };
        },
        markFileReady(request) {
            calls.push("cdb.ready");
            status = "ready";
            return {
                fileId: request.fileId as never,
                organizationId: request.organizationId,
                table: "messages",
                column: "attachment",
                objectKey: `v1/${request.organizationId}/${request.fileId}`,
                contentType: "image/png",
                size: request.size,
                sha256: request.sha256,
                status,
                rowId: null,
                createdAt: request.nowMs,
                updatedAt: request.nowMs,
            };
        },
    };
    const upload = (refreshAuthority: () => Promise<AuthCtx> = async () => auth) =>
        uploadOrganizationFile({
            recoveryGeneration: 0,
            cdb,
            bucket,
            fileId: FileId("file_a"),
            organizationId: "org-1",
            table: "messages",
            column: "attachment",
            contentType: "IMAGE/PNG",
            bytes: new TextEncoder().encode("exact bytes"),
            nowMs: 100,
            domainSchemaEpoch: 2,
            schemaEpoch: 3,
            auth,
            refreshAuthority: async () => {
                calls.push("auth.refresh");
                return refreshAuthority();
            },
        });
    return { calls, upload, object: () => objects.get("v1/org-1/file_a"), objects };
}

describe("organization file upload sequence", () => {
    test("reserves, retains immutable bytes, refreshes authority, and marks ready in order", async () => {
        const f = fixture();
        const result = await f.upload();
        expect(result).toEqual({
            fileId: FileId("file_a"),
            size: 11,
            sha256: "e38e581aade78b64cc86f7ac9f3555ca78c2dcca747942a7f1d9b3275a834f75",
        });
        expect(f.calls).toEqual(["cdb.reserve", "r2.put", "auth.refresh", "cdb.ready"]);
        expect(f.object()).toBeUndefined();
        expect(f.objects.get(`_chardb/retained/sha256/${result.sha256}`)).toMatchObject({
            size: 11,
            customMetadata: { chardbRetainedSha256: result.sha256, chardbRetainedSize: "11" },
        });
    });

    test("reuses the same retained object after a lost response", async () => {
        const f = fixture();
        const first = await f.upload();
        f.calls.splice(0);
        const retry = await f.upload();
        expect(retry).toEqual(first);
        expect(f.calls).toEqual(["cdb.reserve", "r2.put", "auth.refresh", "cdb.ready"]);
    });

    test("does not mark ready when the post-write authority refresh fails", async () => {
        const f = fixture();
        await expect(
            f.upload(async () => {
                throw new Error("membership revoked");
            })
        ).rejects.toThrow(/membership revoked/);
        expect(f.calls).toEqual(["cdb.reserve", "r2.put", "auth.refresh"]);
        expect(f.object()).toBeUndefined();
        expect(f.objects.size).toBe(1);
    });

    test("leaves only an invisible retained orphan when a recovery fence wins after the write", async () => {
        const f = fixture();
        await expect(
            f.upload(async () => {
                throw new CdbError({ code: "CDB_STALE_EPOCH", message: "point-in-time restore is in progress" });
            })
        ).rejects.toMatchObject({ code: "CDB_STALE_EPOCH" });
        expect(f.calls).toEqual(["cdb.reserve", "r2.put", "auth.refresh"]);
        expect(f.object()).toBeUndefined();
        expect([...f.objects.keys()]).toEqual([
            "_chardb/retained/sha256/e38e581aade78b64cc86f7ac9f3555ca78c2dcca747942a7f1d9b3275a834f75",
        ]);
    });
});
