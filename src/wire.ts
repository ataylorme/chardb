/**
 * Wire envelope at `protocolV: 3`.
 *
 * The set of fields, the tag values for `Up` / `Down` messages, every error
 * `code` identifier, every `retryable` polarity and every `mustRefetch` reason
 * are part of the locked surface; adding new fields under `featureSet`
 * advertisement is permitted, renaming or repurposing existing ones is not.
 * Adding new error codes and new `mustRefetch` reasons is additive. The
 * decoder normalizes unknown reasons to `lagged` and unknown error codes to
 * `CDB_INVARIANT`, preserving a sound local tagged union while remaining
 * forward-compatible with newer peers.
 */

import { type CdbErrorCode, docsUrlFor, isCdbErrorCode, isRetryable } from "./errors.ts";
import type { ChardbRef, ClientId, Cookie, CorrelationId, MutId, RawJson, SubId } from "./types.ts";

export type { RawJson } from "./types.ts";

export const PROTOCOL_V = 3 as const;
export type ProtocolV = typeof PROTOCOL_V;

export interface Envelope {
    readonly protocolV: ProtocolV;
    readonly serverVersion: string;
    readonly featureSet: readonly string[];
    readonly correlationId: CorrelationId;
}

export interface CdbIntent {
    readonly kind: "select" | "insert" | "update" | "delete" | "execute";
    readonly tables: readonly string[];
    readonly partitionKey?:
        | { readonly table: string; readonly column: string; readonly values: readonly RawJson[] }
        | undefined;
    readonly joinShape?: "colocated" | "reference" | "cross-partition" | undefined;
    readonly intervals?:
        | readonly {
              readonly table: string;
              readonly indexName: string;
              readonly intervals: readonly WireInterval[];
          }[]
        | undefined;
    readonly relational?: { readonly plan: RawJson } | undefined;
}

export type WireInterval =
    | { readonly kind: "full" }
    | {
          readonly kind: "range";
          readonly lo: WireEndpoint;
          readonly hi: WireEndpoint;
      };

export type WireEndpoint =
    | { readonly kind: "neg_inf" }
    | { readonly kind: "pos_inf" }
    | { readonly kind: "value"; readonly value: readonly RawJson[]; readonly inclusive: boolean };

export type RowPatchOp = "put" | "del" | "edit";

export interface RowPatch {
    readonly op: RowPatchOp;
    readonly subId: SubId;
    readonly rowKey: string;
    readonly row?: RawJson;
}

export type MustRefetchReason =
    | "lagged"
    | "authChanged"
    | "schemaChanged"
    | "protocolMismatch"
    | "shardsChanged"
    | "pitrIdempotencyReset"
    | "gsiLag";

export type MutResult =
    | {
          readonly mutId: MutId;
          readonly ok: true;
          readonly result: RawJson;
          readonly cookie: Cookie;
      }
    | {
          readonly mutId: MutId;
          readonly ok: false;
          readonly error: {
              readonly code: CdbErrorCode;
              readonly retryable: boolean;
              readonly docs: string;
          };
      };

export type Up =
    | {
          readonly t: "hello";
          readonly protocolV: ProtocolV;
          readonly clientId: ClientId;
          readonly resume?: Cookie | undefined;
          readonly resumeFromCookie?: Cookie | undefined;
          readonly jwt: string;
      }
    | {
          readonly t: "sub";
          readonly subId: SubId;
          readonly ref: ChardbRef;
          readonly args: RawJson;
          readonly ttlMs?: number | undefined;
      }
    | { readonly t: "unsub"; readonly subId: SubId }
    | { readonly t: "mut"; readonly mutId: MutId; readonly ref: ChardbRef; readonly args: RawJson }
    | { readonly t: "updateAuth"; readonly jwt: string }
    | { readonly t: "ack"; readonly cookie: Cookie }
    | { readonly t: "ping" };

export type Down =
    | {
          readonly t: "welcome";
          readonly protocolV: ProtocolV;
          readonly baseCookie: Cookie;
          readonly region: string;
          readonly colo?: string | undefined;
          readonly resumedFromCookie?: Cookie | undefined;
      }
    | {
          readonly t: "poke";
          readonly cookie: Cookie;
          readonly patches: readonly RowPatch[];
          readonly mutResults?: readonly MutResult[] | undefined;
      }
    | {
          readonly t: "snapshot";
          readonly subId: SubId;
          readonly cookie: Cookie;
          readonly rows: readonly RawJson[];
      }
    | {
          readonly t: "mustRefetch";
          readonly subIds: readonly SubId[];
          readonly reason: MustRefetchReason;
      }
    | {
          readonly t: "error";
          readonly code: CdbErrorCode;
          readonly subId?: SubId | undefined;
          readonly retryable: boolean;
          readonly correlationId: CorrelationId;
          readonly docs: string;
      };

export type WireMessage = Up | Down;

/** Stable JSON encoding of a wire message — no field reordering. */
export function encodeWire(msg: WireMessage): string {
    return JSON.stringify(msg);
}

/**
 * Locked tag whitelists for `Up` and `Down`. Any decoded message whose `t` is
 * not in one of these sets is rejected — the wire format is closed; new tags
 * require a `protocolV` bump per the locked-surface contract.
 */
const UP_TAG_RECORD = {
    hello: true,
    sub: true,
    unsub: true,
    mut: true,
    updateAuth: true,
    ack: true,
    ping: true,
} as const satisfies Record<Up["t"], true>;

const DOWN_TAG_RECORD = {
    welcome: true,
    poke: true,
    snapshot: true,
    mustRefetch: true,
    error: true,
} as const satisfies Record<Down["t"], true>;

export const UP_TAGS = Object.freeze(Object.keys(UP_TAG_RECORD)) as readonly Up["t"][];
export const DOWN_TAGS = Object.freeze(Object.keys(DOWN_TAG_RECORD)) as readonly Down["t"][];

const ALL_TAGS = new Set<string>([...UP_TAGS, ...DOWN_TAGS]);
const UP_TAG_SET = new Set<string>(UP_TAGS);
const DOWN_TAG_SET = new Set<string>(DOWN_TAGS);

type WireObject = Record<string, unknown>;

function malformed(path: string, expected: string): never {
    throw new TypeError(`malformed wire message: ${path} must ${expected}`);
}

function objectValue(value: unknown, path: string): WireObject {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return malformed(path, "be an object");
    }
    return value as WireObject;
}

function required(object: WireObject, key: string, path: string): unknown {
    if (!Object.hasOwn(object, key)) return malformed(`${path}.${key}`, "be present");
    return object[key];
}

function optional(object: WireObject, key: string): unknown {
    return Object.hasOwn(object, key) ? object[key] : undefined;
}

function onlyKeys(object: WireObject, path: string, keys: readonly string[]): void {
    const allowed = new Set(keys);
    for (const key of Object.keys(object)) {
        if (!allowed.has(key)) malformed(`${path}.${key}`, "not be present");
    }
}

function stringValue(value: unknown, path: string): string {
    if (typeof value !== "string") return malformed(path, "be a string");
    return value;
}

function booleanValue(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") return malformed(path, "be a boolean");
    return value;
}

function finiteNumber(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return malformed(path, "be a finite number");
    return value;
}

function nonnegativeNumber(value: unknown, path: string): number {
    const number = finiteNumber(value, path);
    if (number < 0) return malformed(path, "be nonnegative");
    return number;
}

function integerId(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        return malformed(path, "be a nonnegative safe integer");
    }
    return value;
}

function arrayValue(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) return malformed(path, "be an array");
    return value;
}

function enumValue<const T extends string>(value: unknown, path: string, allowed: ReadonlySet<T>): T {
    if (typeof value !== "string" || !allowed.has(value as T)) {
        return malformed(path, `be one of ${[...allowed].join(", ")}`);
    }
    return value as T;
}

function rawJson(value: unknown, path: string, depth = 0): void {
    if (depth > 100) malformed(path, "have nesting depth at most 100");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
        finiteNumber(value, path);
        return;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) rawJson(value[index], `${path}[${index}]`, depth + 1);
        return;
    }
    if (typeof value === "object") {
        for (const [key, child] of Object.entries(value as WireObject)) {
            rawJson(child, `${path}.${key}`, depth + 1);
        }
        return;
    }
    malformed(path, "be JSON-compatible");
}

const PATCH_OPS = new Set<RowPatchOp>(["put", "del", "edit"]);
const REFETCH_REASONS = new Set<MustRefetchReason>([
    "lagged",
    "authChanged",
    "schemaChanged",
    "protocolMismatch",
    "shardsChanged",
    "pitrIdempotencyReset",
    "gsiLag",
]);

function validateRowPatch(value: unknown, path: string): void {
    const patch = objectValue(value, path);
    onlyKeys(patch, path, ["op", "subId", "rowKey", "row"]);
    enumValue(required(patch, "op", path), `${path}.op`, PATCH_OPS);
    integerId(required(patch, "subId", path), `${path}.subId`);
    stringValue(required(patch, "rowKey", path), `${path}.rowKey`);
    const row = optional(patch, "row");
    if (row !== undefined) rawJson(row, `${path}.row`);
}

function validateMutResult(value: unknown, path: string): void {
    const result = objectValue(value, path);
    stringValue(required(result, "mutId", path), `${path}.mutId`);
    const ok = booleanValue(required(result, "ok", path), `${path}.ok`);
    if (ok) {
        onlyKeys(result, path, ["mutId", "ok", "result", "cookie"]);
        rawJson(required(result, "result", path), `${path}.result`);
        stringValue(required(result, "cookie", path), `${path}.cookie`);
        return;
    }
    onlyKeys(result, path, ["mutId", "ok", "error"]);
    const error = objectValue(required(result, "error", path), `${path}.error`);
    onlyKeys(error, `${path}.error`, ["code", "retryable", "docs"]);
    validateErrorFields(error, `${path}.error`);
}

function validateErrorFields(error: WireObject, path: string): void {
    const code = stringValue(required(error, "code", path), `${path}.code`);
    const retryable = booleanValue(required(error, "retryable", path), `${path}.retryable`);
    stringValue(required(error, "docs", path), `${path}.docs`);
    if (!isCdbErrorCode(code)) {
        error.code = "CDB_INVARIANT";
        error.retryable = false;
        error.docs = docsUrlFor("CDB_INVARIANT");
        return;
    }
    if (retryable !== isRetryable(code)) malformed(`${path}.retryable`, `match the locked polarity for ${code}`);
}

function validateMessage(message: WireObject, tag: string): void {
    const path = tag;
    switch (tag) {
        case "hello": {
            onlyKeys(message, path, ["t", "protocolV", "clientId", "resume", "resumeFromCookie", "jwt"]);
            integerId(required(message, "protocolV", path), `${path}.protocolV`);
            stringValue(required(message, "clientId", path), `${path}.clientId`);
            stringValue(required(message, "jwt", path), `${path}.jwt`);
            const resume = optional(message, "resume");
            if (resume !== undefined) stringValue(resume, `${path}.resume`);
            const resumeFromCookie = optional(message, "resumeFromCookie");
            if (resumeFromCookie !== undefined) stringValue(resumeFromCookie, `${path}.resumeFromCookie`);
            return;
        }
        case "sub": {
            onlyKeys(message, path, ["t", "subId", "ref", "args", "ttlMs"]);
            integerId(required(message, "subId", path), `${path}.subId`);
            validateRef(required(message, "ref", path), `${path}.ref`);
            rawJson(required(message, "args", path), `${path}.args`);
            const ttlMs = optional(message, "ttlMs");
            if (ttlMs !== undefined) nonnegativeNumber(ttlMs, `${path}.ttlMs`);
            return;
        }
        case "unsub":
            onlyKeys(message, path, ["t", "subId"]);
            integerId(required(message, "subId", path), `${path}.subId`);
            return;
        case "mut":
            onlyKeys(message, path, ["t", "mutId", "ref", "args"]);
            stringValue(required(message, "mutId", path), `${path}.mutId`);
            validateRef(required(message, "ref", path), `${path}.ref`);
            rawJson(required(message, "args", path), `${path}.args`);
            return;
        case "updateAuth":
            onlyKeys(message, path, ["t", "jwt"]);
            stringValue(required(message, "jwt", path), `${path}.jwt`);
            return;
        case "ack":
            onlyKeys(message, path, ["t", "cookie"]);
            stringValue(required(message, "cookie", path), `${path}.cookie`);
            return;
        case "ping":
            onlyKeys(message, path, ["t"]);
            return;
        case "welcome": {
            onlyKeys(message, path, ["t", "protocolV", "baseCookie", "region", "colo", "resumedFromCookie"]);
            integerId(required(message, "protocolV", path), `${path}.protocolV`);
            stringValue(required(message, "baseCookie", path), `${path}.baseCookie`);
            stringValue(required(message, "region", path), `${path}.region`);
            const colo = optional(message, "colo");
            if (colo !== undefined) stringValue(colo, `${path}.colo`);
            const resumedFromCookie = optional(message, "resumedFromCookie");
            if (resumedFromCookie !== undefined) stringValue(resumedFromCookie, `${path}.resumedFromCookie`);
            return;
        }
        case "poke": {
            onlyKeys(message, path, ["t", "cookie", "patches", "mutResults"]);
            stringValue(required(message, "cookie", path), `${path}.cookie`);
            const patches = arrayValue(required(message, "patches", path), `${path}.patches`);
            for (let index = 0; index < patches.length; index++) {
                validateRowPatch(patches[index], `${path}.patches[${index}]`);
            }
            const mutResults = optional(message, "mutResults");
            if (mutResults !== undefined) {
                const results = arrayValue(mutResults, `${path}.mutResults`);
                for (let index = 0; index < results.length; index++) {
                    validateMutResult(results[index], `${path}.mutResults[${index}]`);
                }
            }
            return;
        }
        case "snapshot": {
            onlyKeys(message, path, ["t", "subId", "cookie", "rows"]);
            integerId(required(message, "subId", path), `${path}.subId`);
            stringValue(required(message, "cookie", path), `${path}.cookie`);
            const rows = arrayValue(required(message, "rows", path), `${path}.rows`);
            for (let index = 0; index < rows.length; index++) rawJson(rows[index], `${path}.rows[${index}]`);
            return;
        }
        case "mustRefetch": {
            onlyKeys(message, path, ["t", "subIds", "reason"]);
            const subIds = arrayValue(required(message, "subIds", path), `${path}.subIds`);
            for (let index = 0; index < subIds.length; index++) integerId(subIds[index], `${path}.subIds[${index}]`);
            const reason = stringValue(required(message, "reason", path), `${path}.reason`);
            if (!REFETCH_REASONS.has(reason as MustRefetchReason)) message.reason = "lagged";
            return;
        }
        case "error": {
            onlyKeys(message, path, ["t", "code", "subId", "retryable", "correlationId", "docs"]);
            const subId = optional(message, "subId");
            if (subId !== undefined) integerId(subId, `${path}.subId`);
            stringValue(required(message, "correlationId", path), `${path}.correlationId`);
            validateErrorFields(message, path);
            return;
        }
        default:
            throw new TypeError(`malformed wire message: unknown tag "${tag}" — closed at protocolV=${PROTOCOL_V}`);
    }
}

function validateRef(value: unknown, path: string): void {
    const ref = stringValue(value, path);
    if (ref.length === 0 || !ref.includes("#")) malformed(path, "be a nonempty ChardbRef containing #");
}

/**
 * Parse and structurally validate a wire message.
 *
 * Throws `TypeError` for malformed JSON or unknown tags so callers can
 * distinguish a structurally-broken envelope from a semantically-rejected
 * one. Every field is validated before the value crosses into an Up/Down
 * handler; no unchecked cast is exposed to the rest of the runtime.
 */
export function decodeWire(raw: string): WireMessage {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new TypeError(
            `malformed wire message: invalid JSON (${err instanceof Error ? err.message : String(err)})`
        );
    }
    rawJson(parsed, "$root");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("malformed wire message: not an object");
    }
    const tag = (parsed as { t?: unknown }).t;
    if (typeof tag !== "string") {
        throw new TypeError("malformed wire message: missing string tag");
    }
    if (!ALL_TAGS.has(tag)) {
        throw new TypeError(`malformed wire message: unknown tag "${tag}" — closed at protocolV=${PROTOCOL_V}`);
    }
    validateMessage(parsed as WireObject, tag);
    return parsed as WireMessage;
}

/** Decode one client-to-server message and reject a valid tag sent in the wrong direction. */
export function decodeUp(raw: string): Up {
    const message = decodeWire(raw);
    if (!UP_TAG_SET.has(message.t)) {
        throw new TypeError(`malformed wire message: tag "${message.t}" is not valid client-to-server`);
    }
    return message as Up;
}

/** Decode one server-to-client message and reject a valid tag sent in the wrong direction. */
export function decodeDown(raw: string): Down {
    const message = decodeWire(raw);
    if (!DOWN_TAG_SET.has(message.t)) {
        throw new TypeError(`malformed wire message: tag "${message.t}" is not valid server-to-client`);
    }
    return message as Down;
}

/**
 * Validate the outer `protocolV` of a `welcome` or `hello` envelope.
 *
 * Returns `null` if the version matches; otherwise returns a `mustRefetch`
 * Down envelope with `reason: "protocolMismatch"` so the caller can dispatch
 * it directly. Adding new reasons is additive (clients MUST treat unknown
 * reasons as `lagged`) — but the polarity of `protocolMismatch` itself is
 * locked.
 */
export function checkProtocolV(advertisedV: unknown): null | {
    readonly t: "mustRefetch";
    readonly subIds: readonly SubId[];
    readonly reason: MustRefetchReason;
} {
    if (advertisedV === PROTOCOL_V) return null;
    return { t: "mustRefetch", subIds: [], reason: "protocolMismatch" };
}
