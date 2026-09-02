/** `@chardb/core/files` — first-class file columns and their same-origin HTTP client. */

import { type Column, getTableName } from "drizzle-orm";
import { customType } from "drizzle-orm/sqlite-core";
import { normalizePublicWorkerUrl } from "../client/public-url.ts";
import { CdbError, isCdbErrorCode } from "../errors.ts";
import type { Brand } from "../types.ts";

export const CDB_FILE_MAX_BYTES = 25 * 1_024 * 1_024;
export const CDB_FILE_MAX_CONTENT_TYPES = 32;
export const CDB_FILE_ID_MAX_LENGTH = 128;

export type FileId = Brand<string, "FileId">;

const FILE_ID = /^[A-Za-z0-9_-]+$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export function FileId(value: string): FileId {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > CDB_FILE_ID_MAX_LENGTH ||
        !FILE_ID.test(value)
    ) {
        throw new TypeError("invalid CharDB FileId");
    }
    return value as FileId;
}

export interface FileColumnConfig {
    /** Maximum accepted object size. V1 is capped at the proxied-upload limit. */
    readonly maxSize?: number;
    /** Exact accepted MIME types, or `*` to accept any declared type. */
    readonly contentTypes?: readonly string[] | "*";
}

export interface NormalizedFileColumnConfig {
    readonly maxSize: number;
    readonly contentTypes: readonly string[] | "*";
}

export function normalizeFileColumnConfig(config: FileColumnConfig | undefined): NormalizedFileColumnConfig {
    const maxSize = config?.maxSize ?? CDB_FILE_MAX_BYTES;
    if (!Number.isSafeInteger(maxSize) || maxSize < 1 || maxSize > CDB_FILE_MAX_BYTES) {
        throw new TypeError(`file maxSize must be an integer from 1 through ${CDB_FILE_MAX_BYTES}`);
    }

    const requested = config?.contentTypes ?? "*";
    if (requested === "*") return Object.freeze({ maxSize, contentTypes: "*" });
    if (!Array.isArray(requested) || requested.length === 0 || requested.length > CDB_FILE_MAX_CONTENT_TYPES) {
        throw new TypeError(`file contentTypes must contain 1 through ${CDB_FILE_MAX_CONTENT_TYPES} MIME types`);
    }
    if (requested.some(value => typeof value !== "string")) {
        throw new TypeError("file contentTypes must be unique valid MIME types");
    }
    const contentTypes = [...new Set(requested.map(value => value.trim().toLowerCase()))].sort();
    if (contentTypes.length !== requested.length || contentTypes.some(value => !CONTENT_TYPE.test(value))) {
        throw new TypeError("file contentTypes must be unique valid MIME types");
    }
    return Object.freeze({ maxSize, contentTypes: Object.freeze(contentTypes) });
}

const fileTypeParams = {
    dataType(config: FileColumnConfig | undefined): string {
        normalizeFileColumnConfig(config);
        return "text";
    },
    toDriver(value: FileId): string {
        return FileId(value);
    },
    fromDriver(value: string): FileId {
        return FileId(value);
    },
};

/**
 * An opaque, nullable file reference stored as one SQLite TEXT value. Bucket names,
 * object keys, upload state, hashes, and URLs never enter application rows.
 */
export const file = customType<{
    data: FileId;
    driverData: string;
    config: FileColumnConfig;
}>(fileTypeParams);

export function isChardbFileColumn(column: Column): boolean {
    if (column.dataType !== "custom") return false;
    const config = (column as unknown as { config?: { customTypeParams?: object } }).config;
    return config?.customTypeParams === fileTypeParams;
}

export function getChardbFileColumnConfig(column: Column): NormalizedFileColumnConfig | undefined {
    if (!isChardbFileColumn(column)) return undefined;
    const config = (column as unknown as { config?: { fieldConfig?: FileColumnConfig } }).config;
    return normalizeFileColumnConfig(config?.fieldConfig);
}

export interface FileUploadInput {
    readonly organizationId: string;
    readonly file: Blob;
    /** Stable retry identity. A fresh UUID is generated when omitted. */
    readonly idempotencyKey?: string;
}

export interface FileDownloadInput {
    readonly organizationId: string;
    readonly rowId: string;
}

export interface FileUploadResult {
    readonly fileId: FileId;
    readonly size: number;
    readonly sha256: string;
}

export interface ChardbFileClient {
    upload(input: FileUploadInput): Promise<FileUploadResult>;
    download(input: FileDownloadInput): Promise<Response>;
    downloadUrl(input: FileDownloadInput): string;
}

export interface FileClientOptions {
    /**
     * Public CharDB Worker origin. Relative file routes are used when omitted.
     * Browser file requests must remain same-origin with the Worker.
     */
    readonly baseUrl?: string;
}

export interface FileRef {
    readonly table: string;
    readonly column: string;
}

interface FileResponseError {
    readonly error?: {
        readonly code?: unknown;
        readonly message?: unknown;
        readonly correlationId?: unknown;
        readonly retryAfterMs?: unknown;
        readonly hint?: unknown;
    };
}

function locatorPart(value: string, label: string): string {
    if (!value || new TextEncoder().encode(value).byteLength > 256) {
        throw new TypeError(`file ${label} must contain 1 through 256 bytes`);
    }
    return value;
}

/** Browser-safe locator for schemas that import server-only Better Auth definitions. */
export function fileRef(table: string, column: string): FileRef {
    return Object.freeze({ table: locatorPart(table, "table"), column: locatorPart(column, "column") });
}

function fileLocator(column: Column | FileRef): { readonly table: string; readonly column: string } {
    if (!(column instanceof Object) || !("dataType" in column)) {
        return fileRef(column.table, column.column);
    }
    if (!isChardbFileColumn(column)) throw new TypeError("createFileClient requires a chardb file column or fileRef");
    const value = column as Column & { readonly table: Parameters<typeof getTableName>[0]; readonly name: string };
    return Object.freeze({ table: getTableName(value.table), column: value.name });
}

function requestPath(
    action: "upload" | "download",
    locator: { readonly table: string; readonly column: string },
    input: FileDownloadInput | Pick<FileUploadInput, "organizationId">
): string {
    const query = new URLSearchParams({
        organizationId: input.organizationId,
        table: locator.table,
        column: locator.column,
    });
    if ("rowId" in input) query.set("rowId", input.rowId);
    return `/_chardb/files/${action}?${query}`;
}

function fileRequestUrl(path: string, baseUrl: string | undefined): string {
    if (baseUrl === undefined) return path;
    return new URL(path, baseUrl).toString();
}

async function fileRequestError(response: Response): Promise<Error> {
    let error: FileResponseError["error"];
    try {
        error = ((await response.clone().json()) as FileResponseError).error;
    } catch {
        // The status remains useful when an intermediary replaces the JSON body.
    }
    if (isCdbErrorCode(error?.code)) {
        return new CdbError({
            code: error.code,
            ...(typeof error.message === "string" ? { message: error.message } : {}),
            ...(typeof error.correlationId === "string" ? { correlationId: error.correlationId } : {}),
            ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
            ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
        });
    }
    return new Error(`chardb file request failed (${response.status})`);
}

/**
 * Bind one schema file column to CharDB's same-origin upload and download routes.
 * Better Auth's session cookie is sent by the browser automatically.
 */
export function createFileClient(column: Column | FileRef, options: FileClientOptions = {}): ChardbFileClient {
    const locator = fileLocator(column);
    const config = "dataType" in column ? getChardbFileColumnConfig(column) : undefined;
    const baseUrl = options.baseUrl === undefined ? undefined : normalizePublicWorkerUrl(options.baseUrl);
    const path = (action: "upload" | "download", input: FileDownloadInput | Pick<FileUploadInput, "organizationId">) =>
        fileRequestUrl(requestPath(action, locator, input), baseUrl);
    return Object.freeze({
        async upload(input: FileUploadInput) {
            if (!(input.file instanceof Blob) || input.file.size < 1 || !input.file.type) {
                throw new TypeError("file must be a non-empty Blob with a content type");
            }
            const contentType = input.file.type.trim().toLowerCase();
            if (config && input.file.size > config.maxSize)
                throw new TypeError("file exceeds the configured column size");
            if (config && config.contentTypes !== "*" && !config.contentTypes.includes(contentType)) {
                throw new TypeError("file content type is not accepted by the column");
            }
            const response = await globalThis.fetch(path("upload", input), {
                method: "PUT",
                credentials: "include",
                headers: {
                    "content-type": contentType,
                    "idempotency-key": input.idempotencyKey ?? crypto.randomUUID(),
                },
                body: input.file,
            });
            if (!response.ok) throw await fileRequestError(response);
            const body = (await response.json()) as {
                readonly file?: { readonly fileId?: unknown; readonly size?: unknown; readonly sha256?: unknown };
            };
            if (
                !body.file ||
                typeof body.file.fileId !== "string" ||
                !Number.isSafeInteger(body.file.size) ||
                body.file.size !== input.file.size ||
                typeof body.file.sha256 !== "string" ||
                !/^[0-9a-f]{64}$/.test(body.file.sha256)
            ) {
                throw new Error("chardb file upload returned an invalid response");
            }
            return Object.freeze({
                fileId: FileId(body.file.fileId),
                size: body.file.size as number,
                sha256: body.file.sha256,
            });
        },
        async download(input: FileDownloadInput) {
            const response = await globalThis.fetch(path("download", input), { credentials: "include" });
            if (!response.ok) throw await fileRequestError(response);
            return response;
        },
        downloadUrl(input: FileDownloadInput) {
            return path("download", input);
        },
    });
}
