import { describe, expect, test } from "bun:test";
import { parsePreviewPrepareArgs, renderPreviewWrangler } from "../scripts/prepare-preview-chat.mjs";

describe("preview deployment preparation", () => {
    test("requires an exact tarball and output while bounding the Worker name", () => {
        expect(
            parsePreviewPrepareArgs([
                "--tarball",
                "artifacts/preview/chardb.tgz",
                "--output",
                "artifacts/preview/staging-app",
                "--name",
                "chardb-preview-pr-42",
            ])
        ).toEqual({
            help: false,
            tarball: "artifacts/preview/chardb.tgz",
            output: "artifacts/preview/staging-app",
            name: "chardb-preview-pr-42",
        });
        expect(() => parsePreviewPrepareArgs(["--output", "staging-app"])).toThrow("--tarball is required");
        expect(() =>
            parsePreviewPrepareArgs(["--tarball", "chardb.tgz", "--output", "staging-app", "--name", "Bad Name"])
        ).toThrow("Cloudflare Worker name");
    });

    test("changes only the Worker identity in the Wrangler template", () => {
        const source = 'name = "chardb-chat-example"\nmain = "src/server/worker.ts"\n';
        expect(renderPreviewWrangler(source, "chardb-preview", "a".repeat(64))).toBe(
            `name = "chardb-preview"\nmain = "src/server/worker.ts"\n\n[vars]\nCDB_RELEASE_SHA256 = "${"a".repeat(64)}"\n`
        );
        expect(() => renderPreviewWrangler('main = "worker.ts"\n', "chardb-preview", "a".repeat(64))).toThrow(
            "no Worker name"
        );
        expect(() => renderPreviewWrangler(source, "chardb-preview", "bad")).toThrow("SHA-256");
    });
});
