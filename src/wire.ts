/**
 * Wire envelope at `protocolV: 1`.
 *
 * The set of fields, the tag values for `Up` / `Down` messages, every error
 * `code` identifier, every `retryable` polarity and every `mustRefetch` reason
 * are part of the locked surface; adding new fields under `featureSet`
 * advertisement is permitted, renaming or repurposing existing ones is not.
 * Adding new error codes and new `mustRefetch` reasons is additive — clients
 * MUST treat unknown reasons as `lagged`.
 */

import type { CdbErrorCode } from "./errors.ts";
import type { ChardbRef, ClientId, Cookie, CorrelationId, MutId, RawJson, SubId } from "./types.ts";

export type { RawJson } from "./types.ts";

export const PROTOCOL_V = 1 as const;
export type ProtocolV = typeof PROTOCOL_V;

export const PRESENCE_V = 1 as const;
export type PresenceV = typeof PRESENCE_V;

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
          readonly clientId: ClientId;
          readonly resume?: Cookie | undefined;
          readonly resumeFromCookie?: Cookie | undefined;
          readonly jwt: string;
      }
    | {
          readonly t: "sub";
          readonly subId: SubId;
          readonly queryHash: string;
          readonly intent: CdbIntent;
          readonly ttlMs?: number | undefined;
      }
    | { readonly t: "unsub"; readonly subId: SubId }
    | { readonly t: "mut"; readonly mutId: MutId; readonly ref: ChardbRef; readonly args: RawJson }
    | { readonly t: "updateAuth"; readonly jwt: string }
    | { readonly t: "ack"; readonly cookie: Cookie }
    | {
          readonly t: "presencePub";
          readonly key: string;
          readonly state: RawJson;
          readonly ttlMs?: number;
      }
    | { readonly t: "presenceSub"; readonly key: string }
    | {
          readonly t: "streamReq";
          readonly streamReqId: number;
          readonly ref: ChardbRef;
          readonly args: RawJson;
          readonly mutId: MutId;
      }
    | { readonly t: "ping" };

export type Down =
    | {
          readonly t: "welcome";
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
          readonly t: "mustRefetch";
          readonly subIds: readonly SubId[];
          readonly reason: MustRefetchReason;
      }
    | {
          readonly t: "presence";
          readonly key: string;
          readonly version: PresenceV;
          readonly states: readonly {
              readonly clientId: ClientId;
              readonly state: RawJson;
              readonly ts: number;
          }[];
      }
    | { readonly t: "streamChunk"; readonly streamReqId: number; readonly chunk: RawJson }
    | { readonly t: "streamEnd"; readonly streamReqId: number; readonly finalMutResult: MutResult }
    | {
          readonly t: "error";
          readonly code: CdbErrorCode;
          readonly subId?: SubId | undefined;
          readonly streamReqId?: number | undefined;
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
export const UP_TAGS = [
    "hello",
    "sub",
    "unsub",
    "mut",
    "updateAuth",
    "ack",
    "presencePub",
    "presenceSub",
    "streamReq",
    "ping",
] as const satisfies readonly Up["t"][];

export const DOWN_TAGS = [
    "welcome",
    "poke",
    "mustRefetch",
    "presence",
    "streamChunk",
    "streamEnd",
    "error",
] as const satisfies readonly Down["t"][];

const ALL_TAGS = new Set<string>([...UP_TAGS, ...DOWN_TAGS]);

/**
 * Parse a wire message with a closed-set tag check.
 *
 * Throws `TypeError` for malformed JSON or unknown tags so callers can
 * distinguish a structurally-broken envelope from a semantically-rejected
 * one. Field-level shape validation beyond the tag is the SDK's job — the
 * `Up`/`Down` sum-type guards each individual handler downstream.
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
    return parsed as WireMessage;
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
