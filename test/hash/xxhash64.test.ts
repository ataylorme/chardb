import { describe, expect, test } from "bun:test";
import { xxhash64 } from "../../src/hash/xxhash64.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("xxhash64", () => {
    // Verified against the reference C implementation
    // (https://github.com/Cyan4973/xxHash) — these vectors are widely
    // reproduced and serve as a permanent regression on the partition contract.
    test("canonical seed=0 vectors", () => {
        expect(xxhash64(enc(""), 0n)).toBe(0xef46db3751d8e999n);
        expect(xxhash64(enc("a"), 0n)).toBe(0xd24ec4f1a98c6e5bn);
        expect(xxhash64(enc("as"), 0n)).toBe(0x1c330fb2d66be179n);
        expect(xxhash64(enc("asd"), 0n)).toBe(0x631c37ce72a97393n);
        expect(xxhash64(enc("asdf"), 0n)).toBe(0x415872f599cea71en);
        expect(xxhash64(enc("Nobody inspects the spammish repetition"), 0n)).toBe(0xfbcea83c8a378bf1n);
    });

    test("non-zero seed differs from zero seed for the same input", () => {
        const s = enc("Nobody inspects the spammish repetition");
        expect(xxhash64(s, 0n)).not.toBe(xxhash64(s, 1n));
    });

    test("input boundary: 31 bytes (no main loop iteration)", () => {
        const s = "a".repeat(31);
        expect(xxhash64(enc(s), 0n)).toBeGreaterThan(0n);
    });

    test("input boundary: 32 bytes (exactly one main-loop iteration)", () => {
        const s = "a".repeat(32);
        expect(xxhash64(enc(s), 0n)).toBeGreaterThan(0n);
    });

    test("deterministic across calls", () => {
        const a = xxhash64(enc("partitionKey-12345"), 0n);
        const b = xxhash64(enc("partitionKey-12345"), 0n);
        expect(a).toBe(b);
    });
});
