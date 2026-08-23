/**
 * `_chardb_op_log` write-path wrapper.
 *
 * Implements per-shard at-most-once mutation dedup atomically with each base
 * mutation. The shape:
 *
 *   transactionSync(() => {
 *     INSERT OR IGNORE INTO _chardb_op_log
 *       (principal_id, mut_id, payload_hash, ...) VALUES (...);
 *     if (changes() == 0) {
 *       SELECT payload_hash, payload_enc
 *       FROM _chardb_op_log WHERE principal_id = ? AND mut_id = ?;
 *       if (incoming.payload_hash != stored.payload_hash)
 *         throw CDB_MUT_ID_COLLISION;
 *       return decodeEnvelope(decrypt(payload_enc));   // user closure does NOT run
 *     }
 *     result = runUserMutation();                       // user closure runs exactly here
 *     UPDATE _chardb_op_log SET payload_enc = ?, touched_keys = ?, byte_size = ?
 *     WHERE principal_id = ? AND mut_id = ?;
 *   });
 *
 * Detection mechanism: SQLite's `SELECT changes()` after `INSERT OR IGNORE`
 * is the documented and stable primitive. The Cloudflare DO `SqlStorage`
 * cursor exposes `rowsRead` / `rowsWritten` only as metering counters — they
 * are NOT semantically `sqlite3_changes()`, so a separate
 * `db.exec("SELECT changes()")` is required to detect the OR-IGNORE outcome.
 * Because both statements share the same `transactionSync` closure, they are
 * atomic against concurrent retries.
 *
 * The wrapper is parameterized over a `SyncSql` executor (so we can unit-test
 * against bun:sqlite), a payload codec (default identity; the DO-level code
 * wires real envelope encryption for GDPR crypto-shred support), and a clock.
 * The caller is responsible for placing the entire call inside
 * `transactionSync` (DO) or `transaction(...)` (bun:sqlite).
 */

import { CdbError } from "../errors.ts";
import type { MutId, PrincipalId, RawJson } from "../types.ts";
import type { Cookie } from "../types.ts";
import { bytesEq, sha256Hex } from "../util/canonical.ts";
import { type MutationReplayEnvelope, decodeEnvelope, encodeEnvelope } from "./envelope.ts";

/**
 * Tiny synchronous SQL surface. Maps onto both bun:sqlite and DO `SqlStorage`.
 *
 * `T` is unconstrained on `one`/`all` because column projections frequently
 * include JSON columns that decode to nested objects / booleans — values
 * `SqlValue` (the storage primitive set) intentionally rejects. The runtime
 * still returns whatever shape the underlying storage hands back; `T` here
 * is a programmer-supplied claim about that shape, validated at the
 * call-site by the surrounding decode logic, not by the adapter.
 */
export interface SyncSql {
    exec(sql: string, ...params: SqlParam[]): void;
    /** Single-row read; null if no rows. The caller is responsible for the row shape. */
    one<T = Record<string, SqlValue>>(sql: string, ...params: SqlParam[]): T | null;
    /** Multi-row read. Returns all rows as plain objects. */
    all<T = Record<string, SqlValue>>(sql: string, ...params: SqlParam[]): T[];
    /** Number of rows affected by the last data-modifying statement on this connection. */
    changes(): number;
}

export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlParam = SqlValue;

/**
 * Brand for SQLite TEXT columns whose body is a JSON document — typically
 * `json_object(...)` outputs from a trigger projection. The brand is a
 * compile-time hint: the runtime value is still a plain `string`, but the
 * type forces the caller through `parseJsonColumn` rather than a casual
 * `JSON.parse(... as any)` at the use-site.
 *
 * Used by `_chardb_split_log` rows (`before`, `after`) and any other
 * JSON-affinity column in chardb-internal tables.
 */
export type JsonText = string & { readonly __brand: "chardb.JsonText" };

export interface JsonParseFailure {
    readonly column: string;
    readonly cause: unknown;
}

/**
 * Parse a JSON-affinity column into a typed `Record<string, RawJson>`.
 * Returns `null` when the column is `null`/empty so callers can distinguish
 * "column was never set" (e.g. a `del` op-log row has no `after`) from
 * "column was set to `{}`".
 *
 * Throws `TypeError` on malformed JSON or non-object roots — those are
 * indicative of trigger corruption or a third-party tool writing into
 * `_chardb_split_log` and should fail loudly rather than silently degrade.
 */
export function parseJsonColumn(
    column: string,
    value: JsonText | string | null | undefined
): { readonly [k: string]: RawJson } | null {
    if (value === null || value === undefined || value === "") return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (cause) {
        throw new TypeError(`chardb: failed to parse JSON column ${column}: ${(cause as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError(`chardb: JSON column ${column} must decode to an object, got ${typeof parsed}`);
    }
    return parsed as { readonly [k: string]: RawJson };
}

export interface PayloadCodec {
    encrypt(plaintext: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array): Uint8Array;
}

/** No-op codec (identity). The DO-level code wires real envelope encryption. */
export const IDENTITY_CODEC: PayloadCodec = {
    encrypt: b => b,
    decrypt: b => b,
};

const TEXT = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export interface RunWrappedMutationArgs<R> {
    readonly sql: SyncSql;
    readonly principalId: PrincipalId;
    readonly mutId: MutId;
    /** Canonical JSON of `{ ref, args }`; the dedup hash basis. */
    readonly canonicalRequest: string;
    readonly schemaEpoch: number;
    readonly nowMs: number;
    /** `() => R` runs at most once per `(principal_id, mut_id)` inside the same tx. */
    readonly run: () => MutationOutcome<R>;
    /** Cookie issued by the gateway/shard for G13 alignment. */
    readonly cookie: Cookie;
    readonly codec?: PayloadCodec;
}

export type MutationOutcome<R> =
    | {
          readonly status: "ok";
          readonly result: R;
          /** SQLite `changes()` for the handler's final data-modifying statement, not a sum across the handler. */
          readonly rowsAffected: number;
          readonly lastInsertRowid?: number | null | undefined;
          readonly returning?: readonly RawJson[] | undefined;
          readonly touchedKeys?: readonly { table: string; pk: string }[] | undefined;
          readonly warnings?: readonly string[] | undefined;
      }
    | {
          readonly status: "user_error";
          readonly errorCode: import("../errors.ts").CdbErrorCode;
          readonly errorMessage: string;
          readonly touchedKeys?: readonly { table: string; pk: string }[] | undefined;
      };

export interface RunWrappedMutationResult {
    /** True if this call ran the user closure (false → cached replay). */
    readonly ran: boolean;
    readonly envelope: MutationReplayEnvelope;
}

/**
 * Execute the op-log wrapper. Caller is responsible for placing the entire
 * call inside `transactionSync` (DO) or `transaction(...)` (bun:sqlite).
 */
export function runWrappedMutation<R>(args: RunWrappedMutationArgs<R>): RunWrappedMutationResult {
    const codec = args.codec ?? IDENTITY_CODEC;
    const incomingHash = sha256Hex(args.canonicalRequest);
    const incomingHashBytes = hexToBytes(incomingHash);

    args.sql.exec(
        `INSERT OR IGNORE INTO _chardb_op_log (principal_id, mut_id, payload_hash, payload_enc, committed_at, schema_epoch, touched_keys, byte_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args.principalId,
        args.mutId,
        incomingHashBytes,
        new Uint8Array(0),
        args.nowMs,
        args.schemaEpoch,
        "[]",
        0
    );

    if (args.sql.changes() === 0) {
        const row = args.sql.one<{
            payload_hash: Uint8Array | ArrayBuffer;
            payload_enc: Uint8Array | ArrayBuffer;
        }>(
            "SELECT payload_hash, payload_enc FROM _chardb_op_log WHERE principal_id = ? AND mut_id = ?",
            args.principalId,
            args.mutId
        );
        if (!row) {
            throw new CdbError({
                code: "CDB_MUT_ID_COLLISION",
                message: "INSERT OR IGNORE reported 0 changes but no existing row found",
            });
        }
        const storedHash = asBytes(row.payload_hash);
        const storedPayload = asBytes(row.payload_enc);
        if (!bytesEq(storedHash, incomingHashBytes)) {
            throw new CdbError({
                code: "CDB_MUT_ID_COLLISION",
                message: `mutId=${args.mutId} matches an existing op-log row but payload_hash differs`,
                hint: "regenerate mutId; client RNG is reusing values across distinct payloads",
            });
        }
        if (storedPayload.length === 0) {
            // Concurrent in-progress mutation lost a race; surface as transient.
            throw new CdbError({
                code: "CDB_TXN_ABORTED_EVICTION",
                message: "op-log row exists but payload not yet finalized (concurrent in-flight)",
            });
        }
        const envelope = decodeEnvelope(TEXT_DECODER.decode(codec.decrypt(storedPayload)));
        return { ran: false, envelope };
    }

    const outcome = args.run();
    const envelope: MutationReplayEnvelope =
        outcome.status === "ok"
            ? {
                  v: 1,
                  status: "ok",
                  rowsAffected: outcome.rowsAffected,
                  result: toRawJsonResult(outcome.result),
                  ...(outcome.lastInsertRowid !== undefined ? { lastInsertRowid: outcome.lastInsertRowid } : {}),
                  ...(outcome.returning ? { returning: outcome.returning } : {}),
                  cookie: args.cookie,
                  ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
              }
            : {
                  v: 1,
                  status: "user_error",
                  rowsAffected: 0,
                  errorCode: outcome.errorCode,
                  errorMessage: outcome.errorMessage,
                  cookie: args.cookie,
              };

    const enc = codec.encrypt(TEXT.encode(encodeEnvelope(envelope)));
    const touchedJson = JSON.stringify(outcome.touchedKeys ?? []);
    args.sql.exec(
        "UPDATE _chardb_op_log SET payload_enc = ?, touched_keys = ?, byte_size = ? WHERE principal_id = ? AND mut_id = ?",
        enc,
        touchedJson,
        enc.length,
        args.principalId,
        args.mutId
    );

    return { ran: true, envelope };
}

function hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2) throw new Error("odd hex length");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function toRawJsonResult(value: unknown): RawJson {
    const active = new WeakSet<object>();

    const fail = (path: string, reason: string): never => {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: `mutation result is not JSON at ${path}: ${reason}`,
            hint: "return only null, booleans, finite numbers, strings, arrays, and plain objects",
        });
    };

    const visit = (current: unknown, path: string): void => {
        if (current === null || typeof current === "string" || typeof current === "boolean") return;
        if (typeof current === "number") {
            if (!Number.isFinite(current) || Object.is(current, -0)) {
                fail(path, "numbers must be finite and must not be negative zero");
            }
            return;
        }
        if (typeof current !== "object") fail(path, `${typeof current} is unsupported`);
        const objectValue = current as object;
        if (active.has(objectValue)) fail(path, "cyclic references are unsupported");
        active.add(objectValue);

        if (Array.isArray(objectValue)) {
            const ownKeys = Reflect.ownKeys(objectValue);
            if (ownKeys.some(key => typeof key === "symbol")) fail(path, "symbol properties are unsupported");
            if (ownKeys.length !== objectValue.length + 1)
                fail(path, "arrays cannot be sparse or have extra properties");
            for (let i = 0; i < objectValue.length; i++) {
                if (!Object.hasOwn(objectValue, i)) fail(`${path}[${i}]`, "sparse array entries are unsupported");
                visit(objectValue[i], `${path}[${i}]`);
            }
        } else {
            const prototype = Object.getPrototypeOf(objectValue);
            if (prototype !== Object.prototype && prototype !== null) fail(path, "objects must be plain objects");
            for (const key of Reflect.ownKeys(objectValue)) {
                if (typeof key !== "string") fail(path, "symbol properties are unsupported");
                const stringKey = key as string;
                const descriptor = Object.getOwnPropertyDescriptor(objectValue, stringKey);
                if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
                    fail(`${path}.${stringKey}`, "properties must be enumerable data properties");
                }
                visit((descriptor as PropertyDescriptor & { value: unknown }).value, `${path}.${stringKey}`);
            }
        }

        active.delete(objectValue);
    };

    visit(value, "$");
    return value as RawJson;
}

/** Convenience: build a canonical request string for hashing. */
export function canonicalRequest(ref: string, args: RawJson): string {
    return JSON.stringify({ ref, args: canonicalize(args) });
}

function canonicalize(value: RawJson): RawJson {
    if (Array.isArray(value)) return value.map(canonicalize) as RawJson[];
    if (value && typeof value === "object") {
        const out: { [k: string]: RawJson } = {};
        for (const k of Object.keys(value).sort())
            out[k] = canonicalize((value as { [k: string]: RawJson })[k] as RawJson);
        return out;
    }
    return value;
}
