import { describe, expect, test } from "bun:test";
import type { StoredFile } from "../../src/server/do/cdb-file-store.ts";
import { deleteRecoverableFile, readRecoverableFile, retainUploadedFile } from "../../src/server/file-retention.ts";

const BYTES = new TextEncoder().encode("recover me");
const SHA256 = "bc54d1d8c0a99336ea2c89cccee81d1545b9e5c10791b3e5a7140803035213fb";

interface ObjectRecord {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly size: number;
    readonly customMetadata: Record<string, string>;
}

function bucketFixture() {
    const objects = new Map<string, ObjectRecord>();
    const calls: string[] = [];
    const project = (record: ObjectRecord) => ({
        ...record,
        body: new Response(Uint8Array.from(record.bytes)).body,
    });
    const bucket = {
        async put(key: string, value: Uint8Array, options: R2PutOptions) {
            calls.push(`put:${key}`);
            if (objects.has(key) && options.onlyIf) return null;
            const record = {
                key,
                bytes: Uint8Array.from(value),
                size: value.byteLength,
                customMetadata: options.customMetadata ?? {},
            };
            objects.set(key, record);
            return record;
        },
        async head(key: string) {
            calls.push(`head:${key}`);
            return objects.get(key) ?? null;
        },
        async get(key: string) {
            calls.push(`get:${key}`);
            const record = objects.get(key);
            return record ? project(record) : null;
        },
        async delete(key: string) {
            calls.push(`delete:${key}`);
            objects.delete(key);
        },
    } as unknown as R2Bucket;
    return { bucket, calls, objects };
}

const file: StoredFile = {
    fileId: "file_a" as StoredFile["fileId"],
    organizationId: "org-1",
    table: "messages",
    column: "attachment",
    objectKey: "v1/org-1/file_a",
    contentType: "text/plain",
    size: BYTES.byteLength,
    sha256: SHA256,
    status: "attached",
    rowId: "message-1",
    createdAt: 100,
    updatedAt: 101,
};

describe("R2 file recovery retention", () => {
    test("writes one content-addressed recovery object and accepts an exact retry", async () => {
        const fixture = bucketFixture();
        const input = { sha256: SHA256, size: BYTES.byteLength, contentType: "text/plain", bytes: BYTES };
        await retainUploadedFile(fixture.bucket, input);
        await retainUploadedFile(fixture.bucket, input);

        const key = `_chardb/retained/sha256/${SHA256}`;
        expect(fixture.objects.get(key)).toMatchObject({
            size: BYTES.byteLength,
            customMetadata: { chardbRetainedSha256: SHA256, chardbRetainedSize: String(BYTES.byteLength) },
        });
        expect(fixture.calls).toEqual([`put:${key}`, `put:${key}`]);
    });

    test("retains before delete and self-heals the live key after SQLite rewind", async () => {
        const fixture = bucketFixture();
        await fixture.bucket.put(file.objectKey, BYTES, {
            customMetadata: { chardbFileId: file.fileId, chardbSha256: SHA256 },
        });
        await deleteRecoverableFile(fixture.bucket, file);
        expect(fixture.objects.has(file.objectKey)).toBe(false);
        await deleteRecoverableFile(fixture.bucket, file);
        expect(fixture.calls.filter(call => call === `put:_chardb/retained/sha256/${SHA256}`)).toHaveLength(2);

        const restored = await readRecoverableFile(fixture.bucket, file);
        expect(await new Response(restored.body).text()).toBe("recover me");
        expect(fixture.objects.get(file.objectKey)).toMatchObject({
            customMetadata: { chardbFileId: file.fileId, chardbSha256: SHA256 },
        });
    });

    test("rejects corrupt retained bytes instead of restoring them", async () => {
        const fixture = bucketFixture();
        const key = `_chardb/retained/sha256/${SHA256}`;
        fixture.objects.set(key, {
            key,
            bytes: new TextEncoder().encode("wrong bytes"),
            size: BYTES.byteLength,
            customMetadata: { chardbRetainedSha256: SHA256, chardbRetainedSize: String(BYTES.byteLength) },
        });
        await expect(readRecoverableFile(fixture.bucket, file)).rejects.toThrow(/body does not match its digest/);
        expect(fixture.objects.has(file.objectKey)).toBe(false);
    });

    test("does not finish a retrying delete from corrupt retained bytes", async () => {
        const fixture = bucketFixture();
        const key = `_chardb/retained/sha256/${SHA256}`;
        fixture.objects.set(key, {
            key,
            bytes: new TextEncoder().encode("wrong bytes"),
            size: BYTES.byteLength,
            customMetadata: { chardbRetainedSha256: SHA256, chardbRetainedSize: String(BYTES.byteLength) },
        });

        await expect(deleteRecoverableFile(fixture.bucket, file)).rejects.toThrow(/body does not match its digest/);
        expect(fixture.calls).not.toContain(`delete:${file.objectKey}`);
    });

    test("does not delete a live object whose body disagrees with its metadata", async () => {
        const fixture = bucketFixture();
        await fixture.bucket.put(file.objectKey, new TextEncoder().encode("bad bytes!"), {
            customMetadata: { chardbFileId: file.fileId, chardbSha256: SHA256 },
        });

        await expect(deleteRecoverableFile(fixture.bucket, file)).rejects.toThrow(/body does not match its digest/);
        expect(fixture.objects.has(file.objectKey)).toBe(true);
    });
});
