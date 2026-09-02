import { CdbError, isCdbError } from "../errors.ts";
import type { StoredFile } from "./do/cdb-file-store.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const RETAINED_PREFIX = "_chardb/retained/sha256/";

export async function fileProviderCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (isCdbError(error)) throw error;
        throw new CdbError({
            code: "CDB_SHARD_UNAVAILABLE",
            message: "file object storage is unavailable",
            cause: error,
        });
    }
}

function invariant(message: string): never {
    throw new CdbError({ code: "CDB_INVARIANT", message: `file retention: ${message}` });
}

function retainedKey(sha256: string): string {
    if (!SHA256.test(sha256)) invariant("file digest is invalid");
    return `${RETAINED_PREFIX}${sha256}`;
}

function retainedMetadata(sha256: string, size: number): Record<string, string> {
    return { chardbRetainedSha256: sha256, chardbRetainedSize: String(size) };
}

function retainedObjectMatches(object: R2Object, sha256: string, size: number): boolean {
    return (
        object.size === size &&
        object.customMetadata?.chardbRetainedSha256 === sha256 &&
        object.customMetadata?.chardbRetainedSize === String(size)
    );
}

function liveObjectMatches(object: R2Object, file: StoredFile): boolean {
    return (
        file.sha256 !== null &&
        object.size === file.size &&
        object.customMetadata?.chardbFileId === file.fileId &&
        object.customMetadata?.chardbSha256 === file.sha256
    );
}

async function digest(bytes: Uint8Array): Promise<string> {
    const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function bodyBytes(object: R2ObjectBody): Promise<Uint8Array> {
    return new Uint8Array(await new Response(object.body).arrayBuffer());
}

async function putRetained(
    bucket: R2Bucket,
    input: { readonly sha256: string; readonly size: number; readonly contentType: string },
    bytes: Uint8Array
): Promise<void> {
    if (bytes.byteLength !== input.size) invariant("source bytes do not match their recorded size");
    await bucket.put(retainedKey(input.sha256), bytes, {
        httpMetadata: { contentType: input.contentType },
        customMetadata: retainedMetadata(input.sha256, input.size),
    });
}

/** Store authoritative immutable bytes before the upload becomes visible in SQLite. */
export async function retainUploadedFile(
    bucket: R2Bucket,
    input: {
        readonly sha256: string;
        readonly size: number;
        readonly contentType: string;
        readonly bytes: Uint8Array;
    }
): Promise<void> {
    await putRetained(bucket, input, input.bytes);
}

/** Import verified bytes from a legacy live key before a restore scrub. */
export async function refreshRecoverableFile(bucket: R2Bucket, file: StoredFile): Promise<void> {
    if (file.sha256 === null) invariant("recoverable file has no digest");
    const live = await bucket.get(file.objectKey);
    const source = live ?? (await bucket.get(retainedKey(file.sha256)));
    if (!source) invariant("live and retained objects are both missing before recovery scrub");
    if (live ? !liveObjectMatches(live, file) : !retainedObjectMatches(source, file.sha256, file.size)) {
        invariant(
            live ? "live object does not match its SQLite metadata" : "retained object does not match its metadata"
        );
    }
    const bytes = await bodyBytes(source);
    if (bytes.byteLength !== file.size || (await digest(bytes)) !== file.sha256) {
        invariant(`${live ? "live" : "retained"} object body does not match its digest`);
    }
    await putRetained(bucket, { sha256: file.sha256, size: file.size, contentType: file.contentType }, bytes);
}

/** Preserve recoverable bytes before releasing the live key. */
export async function deleteRecoverableFile(bucket: R2Bucket, file: StoredFile): Promise<void> {
    if (file.sha256 !== null) {
        const live = await bucket.get(file.objectKey);
        if (live) {
            if (!liveObjectMatches(live, file)) invariant("live object does not match its SQLite metadata");
            const bytes = await bodyBytes(live);
            if ((await digest(bytes)) !== file.sha256) invariant("live object body does not match its digest");
            await putRetained(bucket, { sha256: file.sha256, size: file.size, contentType: file.contentType }, bytes);
        } else {
            const retained = await bucket.get(retainedKey(file.sha256));
            if (!retained || !retainedObjectMatches(retained, file.sha256, file.size)) {
                invariant("live and retained objects are both missing");
            }
            const bytes = await bodyBytes(retained);
            if (bytes.byteLength !== file.size || (await digest(bytes)) !== file.sha256) {
                invariant("retained object body does not match its digest");
            }
            await putRetained(bucket, { sha256: file.sha256, size: file.size, contentType: file.contentType }, bytes);
        }
    }
    await bucket.delete(file.objectKey);
}

/** Read and verify attached bytes from the immutable content-addressed copy. */
export async function readRecoverableFile(
    bucket: R2Bucket,
    file: StoredFile
): Promise<{ readonly body: ReadableStream<Uint8Array> }> {
    if (file.sha256 === null) invariant("attached file has no digest");
    const retained = await bucket.get(retainedKey(file.sha256));
    if (!retained || !retainedObjectMatches(retained, file.sha256, file.size)) {
        invariant("retained object is missing or does not match its metadata");
    }
    const bytes = await bodyBytes(retained);
    if (bytes.byteLength !== file.size || (await digest(bytes)) !== file.sha256) {
        invariant("retained object body does not match its digest");
    }
    const body = new Response(Uint8Array.from(bytes).buffer).body;
    if (!body) invariant("retained object body is unavailable");
    return { body };
}

/** Restore one authoritative live key during recovery without returning its body. */
export async function rehydrateRecoverableFile(bucket: R2Bucket, file: StoredFile): Promise<void> {
    if (file.sha256 === null) invariant("recoverable file has no digest");
    const retained = await readRecoverableFile(bucket, file);
    const bytes = new Uint8Array(await new Response(retained.body).arrayBuffer());
    await bucket.put(file.objectKey, bytes, {
        httpMetadata: { contentType: file.contentType },
        customMetadata: { chardbFileId: file.fileId, chardbSha256: file.sha256 },
    });
}
