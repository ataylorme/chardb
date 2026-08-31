import { afterEach, describe, expect, mock, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createFileClient, file, fileRef } from "../../src/files/index.ts";

const documents = sqliteTable("documents", {
    id: text("id").primaryKey(),
    attachment: file("attachment", { contentTypes: ["image/png"] }),
});
const tinyDocuments = sqliteTable("tiny_documents", {
    attachment: file("attachment", { maxSize: 1, contentTypes: ["image/png"] }),
});
const HASH = "a".repeat(64);

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("public file client", () => {
    test("derives the exact locator, uploads a Blob, and validates the branded response", async () => {
        const fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            expect(String(input)).toBe("/_chardb/files/upload?organizationId=org-1&table=documents&column=attachment");
            expect(init).toMatchObject({
                method: "PUT",
                headers: { "content-type": "image/png", "idempotency-key": "stable-retry" },
            });
            expect(await new Response(init?.body).text()).toBe("pixels");
            return Response.json({ file: { fileId: "fil_example", size: 6, sha256: HASH } });
        });
        globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

        const result = await createFileClient(documents.attachment).upload({
            organizationId: "org-1",
            file: new Blob(["pixels"], { type: "image/png" }),
            idempotencyKey: "stable-retry",
        });

        expect(String(result.fileId)).toBe("fil_example");
        expect(result.size).toBe(6);
        expect(result.sha256).toBe(HASH);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test("builds policy-checked download URLs and returns the streaming response", async () => {
        const fetch = mock(async (input: string | URL | Request) => {
            expect(String(input)).toBe(
                "/_chardb/files/download?organizationId=org%2F1&table=documents&column=attachment&rowId=row%3F1"
            );
            return new Response("exact", { headers: { "content-type": "image/png" } });
        });
        globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
        const client = createFileClient(documents.attachment);
        const input = { organizationId: "org/1", rowId: "row?1" };

        expect(client.downloadUrl(input)).toBe(
            "/_chardb/files/download?organizationId=org%2F1&table=documents&column=attachment&rowId=row%3F1"
        );
        expect(await (await client.download(input)).text()).toBe("exact");
    });

    test("supports a browser-safe locator without importing a server schema", () => {
        expect(
            createFileClient(fileRef("documents", "attachment")).downloadUrl({
                organizationId: "org-1",
                rowId: "row-1",
            })
        ).toBe("/_chardb/files/download?organizationId=org-1&table=documents&column=attachment&rowId=row-1");
        expect(() => fileRef("", "attachment")).toThrow("file table");
    });

    test("rejects non-file columns, invalid blobs, server failures, and malformed successes", async () => {
        expect(() => createFileClient(documents.id)).toThrow("requires a chardb file column or fileRef");
        const client = createFileClient(documents.attachment);
        await expect(client.upload({ organizationId: "org-1", file: new Blob([]) })).rejects.toThrow("non-empty Blob");
        await expect(
            client.upload({ organizationId: "org-1", file: new Blob(["x"], { type: "text/plain" }) })
        ).rejects.toThrow("content type");
        await expect(
            createFileClient(tinyDocuments.attachment).upload({
                organizationId: "org-1",
                file: new Blob(["xx"], { type: "image/png" }),
            })
        ).rejects.toThrow("configured column size");

        globalThis.fetch = mock(async () =>
            Response.json({ error: { code: "CDB_FORBIDDEN" } }, { status: 403 })
        ) as unknown as typeof globalThis.fetch;
        await expect(
            client.upload({ organizationId: "org-1", file: new Blob(["x"], { type: "image/png" }) })
        ).rejects.toMatchObject({ code: "CDB_FORBIDDEN", retryable: false });

        globalThis.fetch = mock(async () =>
            Response.json({ file: { fileId: "bad/id", size: 1, sha256: HASH } })
        ) as unknown as typeof globalThis.fetch;
        await expect(
            client.upload({ organizationId: "org-1", file: new Blob(["x"], { type: "image/png" }) })
        ).rejects.toThrow("invalid Chardb FileId");
    });
});
