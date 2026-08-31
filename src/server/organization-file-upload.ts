import { CdbError, isCdbError, rehydrateCdbRpcError } from "../errors.ts";
import { FileId, type FileId as FileIdType } from "../files/index.ts";
import type { AuthCtx } from "./define.ts";
import type { CdbFileReadyRequest, CdbFileReserveRequest } from "./do/cdb-file-runtime.ts";
import type { StoredFile } from "./do/cdb-file-store.ts";

export interface OrganizationFileUploadCdb {
    reserveFile(request: CdbFileReserveRequest & { readonly schemaEpoch: number }): Promise<StoredFile>;
    markFileReady(request: CdbFileReadyRequest & { readonly schemaEpoch: number }): Promise<StoredFile> | StoredFile;
}

export interface OrganizationFileUploadResult {
    readonly fileId: FileIdType;
    readonly size: number;
    readonly sha256: string;
}

function hex(bytes: ArrayBuffer): string {
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Private proxied-upload sequence. The same FileId is the retry identity across every boundary. */
export async function uploadOrganizationFile(input: {
    readonly cdb: OrganizationFileUploadCdb;
    readonly bucket: R2Bucket;
    readonly fileId: string;
    readonly organizationId: string;
    readonly table: string;
    readonly column: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly nowMs: number;
    readonly domainSchemaEpoch: number;
    readonly schemaEpoch: number;
    readonly auth: AuthCtx;
    readonly refreshAuthority: () => Promise<AuthCtx>;
}): Promise<OrganizationFileUploadResult> {
    const fileId = FileId(input.fileId);
    const ownedBytes = Uint8Array.from(input.bytes);
    const sha256 = hex(await crypto.subtle.digest("SHA-256", ownedBytes.buffer));
    let reserved: StoredFile;
    try {
        reserved = await input.cdb.reserveFile({
            fileId,
            organizationId: input.organizationId,
            table: input.table,
            column: input.column,
            contentType: input.contentType,
            size: ownedBytes.byteLength,
            nowMs: input.nowMs,
            domainSchemaEpoch: input.domainSchemaEpoch,
            schemaEpoch: input.schemaEpoch,
            auth: input.auth,
        });
    } catch (error) {
        throw rehydrateCdbRpcError(error);
    }
    const metadata = { chardbFileId: fileId, chardbSha256: sha256 };
    const written = await input.bucket.put(reserved.objectKey, ownedBytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: reserved.contentType },
        customMetadata: metadata,
    });
    if (written === null) {
        const existing = await input.bucket.head(reserved.objectKey);
        if (
            existing === null ||
            existing.size !== ownedBytes.byteLength ||
            existing.customMetadata?.chardbFileId !== fileId ||
            existing.customMetadata?.chardbSha256 !== sha256
        ) {
            throw new CdbError({ code: "CDB_INVARIANT", message: "immutable file object does not match its retry" });
        }
    }

    let ready: StoredFile;
    try {
        const refreshedAuth = await input.refreshAuthority();
        ready = await input.cdb.markFileReady({
            fileId,
            organizationId: input.organizationId,
            sha256,
            size: ownedBytes.byteLength,
            nowMs: input.nowMs,
            domainSchemaEpoch: input.domainSchemaEpoch,
            schemaEpoch: input.schemaEpoch,
            auth: refreshedAuth,
        });
    } catch (error) {
        const normalized = rehydrateCdbRpcError(error);
        if (isCdbError(normalized) && normalized.code === "CDB_FORBIDDEN") {
            try {
                await input.bucket.delete(reserved.objectKey);
            } catch {
                // The retained pending lease lets the shard alarm retry this exact key.
            }
        }
        throw normalized;
    }
    if (ready.status !== "ready" && ready.status !== "attached") {
        throw new CdbError({ code: "CDB_INVARIANT", message: "file upload completed without a ready state" });
    }
    return Object.freeze({ fileId, size: ownedBytes.byteLength, sha256 });
}
