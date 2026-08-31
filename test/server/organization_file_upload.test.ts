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
    let object:
        | { readonly key: string; readonly size: number; readonly customMetadata: Record<string, string> }
        | undefined;
    const bucket = {
        async put(key: string, value: Uint8Array, options: R2PutOptions) {
            calls.push("r2.put");
            if (object) return null;
            object = { key, size: value.byteLength, customMetadata: options.customMetadata ?? {} };
            return object;
        },
        async head(key: string) {
            calls.push("r2.head");
            return object?.key === key ? object : null;
        },
        async delete(key: string) {
            calls.push("r2.delete");
            if (object?.key === key) object = undefined;
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
    return { calls, upload, object: () => object };
}

describe("organization file upload sequence", () => {
    test("reserves, writes immutable bytes, refreshes authority, and marks ready in order", async () => {
        const f = fixture();
        const result = await f.upload();
        expect(result).toEqual({
            fileId: FileId("file_a"),
            size: 11,
            sha256: "e38e581aade78b64cc86f7ac9f3555ca78c2dcca747942a7f1d9b3275a834f75",
        });
        expect(f.calls).toEqual(["cdb.reserve", "r2.put", "auth.refresh", "cdb.ready"]);
        expect(f.object()).toMatchObject({
            key: "v1/org-1/file_a",
            size: 11,
            customMetadata: { chardbFileId: "file_a", chardbSha256: result.sha256 },
        });
    });

    test("reuses the same immutable object after a lost response", async () => {
        const f = fixture();
        const first = await f.upload();
        f.calls.splice(0);
        const retry = await f.upload();
        expect(retry).toEqual(first);
        expect(f.calls).toEqual(["cdb.reserve", "r2.put", "r2.head", "auth.refresh", "cdb.ready"]);
    });

    test("does not mark ready when the post-write authority refresh fails", async () => {
        const f = fixture();
        await expect(
            f.upload(async () => {
                throw new Error("membership revoked");
            })
        ).rejects.toThrow(/membership revoked/);
        expect(f.calls).toEqual(["cdb.reserve", "r2.put", "auth.refresh"]);
        expect(f.object()).toBeDefined();
    });

    test("removes a late object when organization deletion wins the post-write refresh", async () => {
        const f = fixture();
        await expect(
            f.upload(async () => {
                throw new CdbError({ code: "CDB_FORBIDDEN", message: "organization deleted" });
            })
        ).rejects.toMatchObject({ code: "CDB_FORBIDDEN" });
        expect(f.calls).toEqual(["cdb.reserve", "r2.put", "auth.refresh", "r2.delete"]);
        expect(f.object()).toBeUndefined();
    });
});
