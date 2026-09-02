import { CdbError, rehydrateCdbRpcError } from "../errors.ts";
import { FileId, type FileId as FileIdType } from "../files/index.ts";
import type { AuthCtx } from "./define.ts";
import type { CdbFileReadyRequest, CdbFileReserveRequest } from "./do/cdb-file-runtime.ts";
import type { StoredFile } from "./do/cdb-file-store.ts";
import { fileProviderCall, retainUploadedFile } from "./file-retention.ts";

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
    readonly recoveryGeneration: number;
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
            recoveryGeneration: input.recoveryGeneration,
            auth: input.auth,
        });
    } catch (error) {
        throw rehydrateCdbRpcError(error);
    }
    // Ordinary uploads write only the content-addressed retained object. The
    // SQLite ready transition makes it visible; recovery alone materializes a
    // live v1 key. A late upload can therefore leave only an invisible orphan.
    await fileProviderCall(() =>
        retainUploadedFile(input.bucket, {
            sha256,
            size: ownedBytes.byteLength,
            contentType: reserved.contentType,
            bytes: ownedBytes,
        })
    );

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
            recoveryGeneration: input.recoveryGeneration,
            auth: refreshedAuth,
        });
    } catch (error) {
        const normalized = rehydrateCdbRpcError(error);
        // Retained objects are immutable and content-addressed. Failed
        // readiness leaves an invisible orphan that another identical upload
        // can reuse safely.
        throw normalized;
    }
    if (ready.status !== "ready" && ready.status !== "attached") {
        throw new CdbError({ code: "CDB_INVARIANT", message: "file upload completed without a ready state" });
    }
    return Object.freeze({ fileId, size: ownedBytes.byteLength, sha256 });
}
