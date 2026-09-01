import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_V, type WireMessage, decodeWire, encodeWire } from "../src/wire.ts";

interface Corpus {
    readonly protocolV: number;
    readonly up: readonly unknown[];
    readonly down: readonly unknown[];
}

const fixturePath = fileURLToPath(new URL("../rust/chardb/tests/fixtures/wire_v3.json", import.meta.url));

describe("shared Rust wire corpus", () => {
    test("is accepted byte-for-byte by the authoritative TypeScript codec", async () => {
        const corpus = JSON.parse(await readFile(fixturePath, "utf8")) as Corpus;
        expect(corpus.protocolV).toBe(PROTOCOL_V);
        expect(corpus.up).toHaveLength(7);
        expect(corpus.down).toHaveLength(6);
        for (const fixture of [...corpus.up, ...corpus.down]) {
            const raw = JSON.stringify(fixture);
            const decoded = decodeWire(raw);
            expect(encodeWire(decoded as WireMessage)).toBe(raw);
        }
    });
});
