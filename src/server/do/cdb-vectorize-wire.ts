import { sha256 } from "@noble/hashes/sha2";
import { stableJson } from "../../util/canonical.ts";

export const CDB_VECTORIZE_MAX_DIMENSIONS = 1_536;
export const CDB_VECTORIZE_MAX_ID_BYTES = 64;
export const CDB_VECTORIZE_MAX_METADATA_STRING_BYTES = 64;
export const CDB_VECTORIZE_MAX_NAMESPACE_BYTES = 64;

const TEXT = new TextEncoder();
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX = "0123456789abcdef";
const RESOURCE_ID = /^vr1_([0-9a-f]{64})$/;
const VECTOR_ID = /^vec1_([0-9a-f]{64})$/;
const CANONICAL_PHYSICAL_ID = /^v1\/(vr1_[0-9a-f]{64})\/(vec1_[0-9a-f]{64})\/([1-9][0-9]*)$/;
const WIRE_PHYSICAL_ID = /^p1_([A-Za-z0-9_-]{43})_([0-9a-z]+)$/;

function bytesFromHex(value: string): Uint8Array {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError("digest must be 64 lowercase hexadecimal characters");
    const result = new Uint8Array(32);
    for (let index = 0; index < result.length; index++) {
        result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return result;
}

function hexFromBytes(value: Uint8Array): string {
    if (value.byteLength !== 32) throw new TypeError("digest must contain 32 bytes");
    let result = "";
    for (const byte of value) result += `${HEX[byte >>> 4]}${HEX[byte & 0x0f]}`;
    return result;
}

function base64Url32(value: Uint8Array): string {
    if (value.byteLength !== 32) throw new TypeError("digest must contain 32 bytes");
    let result = "";
    for (let offset = 0; offset < value.length; offset += 3) {
        const first = value[offset] as number;
        const second = value[offset + 1];
        const third = value[offset + 2];
        result += BASE64URL[first >>> 2];
        result += BASE64URL[((first & 0x03) << 4) | ((second ?? 0) >>> 4)];
        if (second !== undefined) result += BASE64URL[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)];
        if (third !== undefined) result += BASE64URL[third & 0x3f];
    }
    if (result.length !== 43) throw new TypeError("digest did not produce a 43-character base64url value");
    return result;
}

function bytesFromBase64Url32(value: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const result: number[] = [];
    let accumulator = 0;
    let bits = 0;
    for (const character of value) {
        const digit = BASE64URL.indexOf(character);
        if (digit < 0) return null;
        accumulator = (accumulator << 6) | digit;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            result.push((accumulator >>> bits) & 0xff);
            accumulator &= (1 << bits) - 1;
        }
    }
    if (result.length !== 32 || bits !== 2 || accumulator !== 0) return null;
    const bytes = Uint8Array.from(result);
    return base64Url32(bytes) === value ? bytes : null;
}

function safeVersion(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError("vector version must be a positive safe integer");
    return value;
}

function parseBase36SafeInteger(value: string): number | null {
    if (!/^[0-9a-z]+$/.test(value) || value[0] === "0") return null;
    let result = 0;
    for (const character of value) {
        const digit = Number.parseInt(character, 36);
        if (!Number.isSafeInteger(digit) || digit < 0 || digit >= 36) return null;
        if (result > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 36)) return null;
        result = result * 36 + digit;
    }
    return result >= 1 && result.toString(36) === value ? result : null;
}

function boundedAscii(value: string, maximum: number, subject: string): string {
    if (TEXT.encode(value).byteLength > maximum) throw new TypeError(`${subject} exceeds ${maximum} UTF-8 bytes`);
    return value;
}

/** Compact descriptor digest used only as indexed Vectorize metadata. */
export function cdbVectorizeResourceFilter(resourceId: string): string {
    const digest = RESOURCE_ID.exec(resourceId)?.[1];
    if (!digest) throw new TypeError("Vectorize resource id is not a production vr1 identity");
    return boundedAscii(
        `r1_${base64Url32(bytesFromHex(digest))}`,
        CDB_VECTORIZE_MAX_METADATA_STRING_BYTES,
        "Vectorize resource filter"
    );
}

/** Opaque organization namespace. Logical organization ids never cross the Vectorize boundary. */
export function cdbVectorizeOrganizationNamespace(organizationId: string): string {
    if (
        typeof organizationId !== "string" ||
        organizationId.length === 0 ||
        TEXT.encode(organizationId).byteLength > 256
    ) {
        throw new TypeError("organization id is invalid");
    }
    const digest = sha256(TEXT.encode(stableJson(["chardb.vectorize-organization.v1", organizationId])));
    return boundedAscii(`o1_${base64Url32(digest)}`, CDB_VECTORIZE_MAX_NAMESPACE_BYTES, "Vectorize namespace");
}

/**
 * Compact Vectorize document id. The 32-byte logical-vector digest and the
 * safe-integer version round-trip without consulting metadata.
 */
export function cdbVectorizePhysicalId(vectorId: string, version: number): string {
    const digest = VECTOR_ID.exec(vectorId)?.[1];
    if (!digest) throw new TypeError("Vectorize logical id is not a production vec1 identity");
    const result = `p1_${base64Url32(bytesFromHex(digest))}_${safeVersion(version).toString(36)}`;
    return boundedAscii(result, CDB_VECTORIZE_MAX_ID_BYTES, "Vectorize physical id");
}

export interface CdbVectorizePhysicalIdentity {
    readonly vectorId: `vec1_${string}`;
    readonly version: number;
}

export function parseCdbVectorizePhysicalId(value: string): CdbVectorizePhysicalIdentity | null {
    if (typeof value !== "string" || TEXT.encode(value).byteLength > CDB_VECTORIZE_MAX_ID_BYTES) return null;
    const match = WIRE_PHYSICAL_ID.exec(value);
    if (!match) return null;
    const digest = bytesFromBase64Url32(match[1] as string);
    const version = parseBase36SafeInteger(match[2] as string);
    if (!digest || version === null) return null;
    const vectorId = `vec1_${hexFromBytes(digest)}` as const;
    return cdbVectorizePhysicalId(vectorId, version) === value ? Object.freeze({ vectorId, version }) : null;
}

export interface CdbCanonicalVectorPhysicalIdentity extends CdbVectorizePhysicalIdentity {
    readonly resourceId: `vr1_${string}`;
}

/** Translate the durable SQLite identity without changing what SQLite stores. */
export function cdbVectorizePhysicalIdFromCanonical(value: string): {
    readonly identity: CdbCanonicalVectorPhysicalIdentity;
    readonly wireId: string;
} {
    const match = CANONICAL_PHYSICAL_ID.exec(value);
    if (!match) throw new TypeError("canonical vector physical id is not a production identity");
    const resourceId = match[1] as `vr1_${string}`;
    const vectorId = match[2] as `vec1_${string}`;
    const version = Number(match[3]);
    safeVersion(version);
    const identity = Object.freeze({ resourceId, vectorId, version });
    return Object.freeze({ identity, wireId: cdbVectorizePhysicalId(vectorId, version) });
}
