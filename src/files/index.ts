/**
 * `chardb/files` — `file()` / `fileArray()` Drizzle column types.
 *
 * `await handle.upload(blob)` auto-routes by size:
 *   ≤ 25 MB    → proxied PUT through the worker
 *   25–100 MB  → presigned PUT direct to R2
 *   > 100 MB   → R2 multipart upload
 *     (https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)
 *
 * Server-allocated keys (`<tenantId>/<ulid>`); R2 etag verified before
 * `status='live'` flips on BlobMeta.
 */

import type { Column } from "drizzle-orm";
import { customType } from "drizzle-orm/sqlite-core";

export const PROXIED_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const PRESIGNED_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Brand stamped on `file()` / `fileArray()` columns; consumed by the validator factories. */
export const FILE_DATATYPE = "ChardbFile" as const;
export type FileDatatype = typeof FILE_DATATYPE;

export interface FileColumnConfig {
    /** Max bytes accepted; emit CDB_VALIDATION on overflow. */
    readonly maxSize?: number;
    /** Whitelist of accepted content types; `*` accepts any. */
    readonly contentTypes?: readonly string[] | "*";
    /** Validator from the validator-adapter packages. */
    readonly validator?: { readonly dataType: "custom" } | { readonly parse: (input: unknown) => unknown };
}

export interface FileMeta {
    readonly id: string;
    readonly bucket: string;
    readonly key: string;
    readonly size: number;
    readonly contentType: string;
    readonly sha256: string;
    readonly status: "pending" | "live" | "quarantined";
}

export interface FileHandle {
    readonly meta: FileMeta | null;
    /** Upload a blob. Auto-routes proxied / presigned / multipart. */
    upload(blob: Blob): Promise<FileMeta>;
    /** Issue a presigned GET. */
    url(opts?: { ttlMs?: number; download?: string }): Promise<string>;
    delete(): Promise<void>;
}

const fileToDriver = (value: FileHandle): string => (value.meta ? JSON.stringify(value.meta) : "");
const fileFromDriver = (value: string): FileHandle => materializeHandle(value ? (JSON.parse(value) as FileMeta) : null);
const fileArrayToDriver = (value: FileHandle[]): string =>
    JSON.stringify(value.map(h => h.meta).filter((m): m is FileMeta => m !== null));
const fileArrayFromDriver = (value: string): FileHandle[] =>
    (value ? (JSON.parse(value) as FileMeta[]) : []).map(materializeHandle);

const fileTypeParams = {
    dataType: () => "text",
    toDriver: fileToDriver,
    fromDriver: fileFromDriver,
};

const fileArrayTypeParams = {
    dataType: () => "text",
    toDriver: fileArrayToDriver,
    fromDriver: fileArrayFromDriver,
};

// We can't read drizzle's protected `column.config` through the public type, so we
// register the customTypeParams object identities and consult them in `isChardbFileColumn`.
const FILE_PARAM_OBJECTS = new WeakSet<object>();
FILE_PARAM_OBJECTS.add(fileTypeParams);
FILE_PARAM_OBJECTS.add(fileArrayTypeParams);

const ARRAY_PARAM_OBJECTS = new WeakSet<object>();
ARRAY_PARAM_OBJECTS.add(fileArrayTypeParams);

/**
 * `file('column_name', cfg?)` — single-file column. Stored as JSON-encoded
 * `FileMeta` in SQLite; the BlobMeta DO holds the refcount.
 */
export const file = customType<{
    data: FileHandle;
    driverData: string;
    config: FileColumnConfig;
}>(fileTypeParams);

/**
 * `fileArray('column_name', cfg?)` — multi-file column.
 */
export const fileArray = customType<{
    data: FileHandle[];
    driverData: string;
    config: FileColumnConfig;
}>(fileArrayTypeParams);

/**
 * Returns true when `column` was produced by `file()` or `fileArray()`. Validator
 * adapters use this to substitute a string-id schema (the wire shape of a file).
 */
export function isChardbFileColumn(column: Column): boolean {
    if (column.dataType !== "custom") return false;
    // drizzle's `Column.config` is protected; reach through a single narrow cast.
    const cfg = (column as unknown as { config?: { customTypeParams?: object } }).config;
    return cfg?.customTypeParams ? FILE_PARAM_OBJECTS.has(cfg.customTypeParams) : false;
}

/** Returns true when `column` was produced by `fileArray()` specifically. */
export function isChardbFileArrayColumn(column: Column): boolean {
    if (column.dataType !== "custom") return false;
    const cfg = (column as unknown as { config?: { customTypeParams?: object } }).config;
    return cfg?.customTypeParams ? ARRAY_PARAM_OBJECTS.has(cfg.customTypeParams) : false;
}

function materializeHandle(meta: FileMeta | null): FileHandle {
    // Real implementation is wired by chardb/server with R2 + BlobMeta bindings;
    // the shape here is the user-facing surface.
    return {
        meta,
        async upload(blob): Promise<FileMeta> {
            throw new Error(`file.upload requires the chardb server runtime; got blob of ${blob.size}B`);
        },
        async url(): Promise<string> {
            if (!meta) throw new Error("no file");
            return `https://chardb.dev/_chardb/blob/${meta.id}`;
        },
        async delete(): Promise<void> {
            throw new Error("file.delete requires the chardb server runtime");
        },
    };
}

export type { FileMeta as FileMetaShape };
