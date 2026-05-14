/** Canonical JSON + sha256 hash, used by the colocation digest and op-log payload_hash. */

import { sha256 } from "@noble/hashes/sha2";

/**
 * Stable JSON: keys sorted; arrays preserved in given order; primitives as-is.
 * Refuses BigInt and undefined to keep round-trips obvious.
 */
export function stableJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
    if (value === null) return null;
    if (typeof value === "bigint") {
        throw new TypeError("stableJson does not accept bigint; encode explicitly");
    }
    if (typeof value === "undefined") {
        throw new TypeError("stableJson does not accept undefined; use null or omit the key");
    }
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value === "object") {
        const v = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
        return out;
    }
    return value;
}

const HEX = "0123456789abcdef";
function bytesToHex(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i++) {
        const v = b[i] as number;
        s += HEX[v >>> 4];
        s += HEX[v & 0xf];
    }
    return s;
}

const TEXT = new TextEncoder();

export function stableHashHex(value: unknown): string {
    return bytesToHex(sha256(TEXT.encode(stableJson(value))));
}

export function sha256Hex(input: string | Uint8Array): string {
    const bytes = typeof input === "string" ? TEXT.encode(input) : input;
    return bytesToHex(sha256(bytes));
}

export function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let acc = 0;
    for (let i = 0; i < a.length; i++) acc |= (a[i] as number) ^ (b[i] as number);
    return acc === 0;
}
