/**
 * xxhash64 (XXH64) — pure TypeScript, BigInt-based.
 *
 * The chardb vshard router hashes every partition key with `xxhash64(seed=0)`.
 * Because the routing namespace must remain stable for the life of the major
 * version, this implementation is deliberately straightforward: BigInt, no
 * SIMD, no pre-allocated buffers. Test vectors are pinned in
 * `test/hash/xxhash64.test.ts` and validated against the reference C
 * implementation at https://github.com/Cyan4973/xxHash.
 *
 * Partition keys are tens of bytes; the BigInt overhead does not register
 * compared to the SQL round-trip on the hot path.
 */

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;

const MASK64 = 0xffffffffffffffffn;

const u64 = (n: bigint): bigint => n & MASK64;
const rotl64 = (n: bigint, r: bigint): bigint => u64((n << r) | (n >> (64n - r)));

function round(acc: bigint, lane: bigint): bigint {
    let a = u64(acc + u64(lane * PRIME64_2));
    a = rotl64(a, 31n);
    return u64(a * PRIME64_1);
}

function mergeRound(acc: bigint, val: bigint): bigint {
    const v = round(0n, val);
    let a = acc ^ v;
    a = u64(a * PRIME64_1);
    return u64(a + PRIME64_4);
}

function readLE64(view: DataView, off: number): bigint {
    return view.getBigUint64(off, true);
}
function readLE32(view: DataView, off: number): bigint {
    return BigInt(view.getUint32(off, true));
}
function readLE8(view: DataView, off: number): bigint {
    return BigInt(view.getUint8(off));
}

export function xxhash64(input: Uint8Array, seed = 0n): bigint {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const len = input.byteLength;
    let h64: bigint;
    let off = 0;

    if (len >= 32) {
        let v1 = u64(seed + PRIME64_1 + PRIME64_2);
        let v2 = u64(seed + PRIME64_2);
        let v3 = u64(seed + 0n);
        let v4 = u64(seed - PRIME64_1);
        const limit = len - 32;
        for (; off <= limit; off += 32) {
            v1 = round(v1, readLE64(view, off));
            v2 = round(v2, readLE64(view, off + 8));
            v3 = round(v3, readLE64(view, off + 16));
            v4 = round(v4, readLE64(view, off + 24));
        }
        h64 = u64(rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n));
        h64 = mergeRound(h64, v1);
        h64 = mergeRound(h64, v2);
        h64 = mergeRound(h64, v3);
        h64 = mergeRound(h64, v4);
    } else {
        h64 = u64(seed + PRIME64_5);
    }

    h64 = u64(h64 + BigInt(len));

    while (off + 8 <= len) {
        const k1 = round(0n, readLE64(view, off));
        h64 = u64(rotl64(h64 ^ k1, 27n) * PRIME64_1 + PRIME64_4);
        off += 8;
    }
    if (off + 4 <= len) {
        h64 = u64(rotl64(h64 ^ u64(readLE32(view, off) * PRIME64_1), 23n) * PRIME64_2 + PRIME64_3);
        off += 4;
    }
    while (off < len) {
        h64 = u64(rotl64(h64 ^ u64(readLE8(view, off) * PRIME64_5), 11n) * PRIME64_1);
        off += 1;
    }

    h64 ^= h64 >> 33n;
    h64 = u64(h64 * PRIME64_2);
    h64 ^= h64 >> 29n;
    h64 = u64(h64 * PRIME64_3);
    h64 ^= h64 >> 32n;
    return h64;
}
