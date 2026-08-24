/**
 * The op-log wrapper is exercised against bun:sqlite (the same SQLite that
 * underlies durable-sqlite). bun:sqlite's `transaction` API gives us exactly
 * the same atomicity contract we'll get on workerd via `transactionSync`.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import { OP_LOG_DDL } from "../../src/oplog/schema.ts";
import { type SyncSql, canonicalRequest, runWrappedMutation } from "../../src/oplog/wrapper.ts";
import { Cookie, MutId, PrincipalId, type RawJson } from "../../src/types.ts";

let db: Database;
let sql: SyncSql;

beforeEach(() => {
    db = new Database(":memory:");
    for (const stmt of OP_LOG_DDL.split(";")
        .map(s => s.trim())
        .filter(Boolean)) {
        db.run(stmt);
    }
    let lastChanges = 0;
    sql = {
        exec(sqlText, ...params) {
            const stmt = db.prepare(sqlText);
            stmt.run(...(params as unknown as never[]));
            lastChanges = db.run("SELECT changes()").changes;
            // bun:sqlite returns rows-affected in `run()` directly; capture it.
            // Above call is a no-op; we re-derive via the previous run().
        },
        one<T = Record<string, unknown>>(sqlText: string, ...params: unknown[]): T | null {
            const stmt = db.prepare(sqlText);
            const row = stmt.get(...(params as unknown as never[]));
            return (row ?? null) as T | null;
        },
        all<T = Record<string, unknown>>(sqlText: string, ...params: unknown[]): T[] {
            const stmt = db.prepare(sqlText);
            return stmt.all(...(params as unknown as never[])) as T[];
        },
        changes() {
            return lastChanges;
        },
    };
    // Patch exec to set lastChanges from the actual run()
    sql.exec = (sqlText, ...params) => {
        const stmt = db.prepare(sqlText);
        const r = stmt.run(...(params as unknown as never[]));
        lastChanges = r.changes;
    };
});

afterEach(() => db.close());

const PRINCIPAL = PrincipalId("user-1");
const MUT_ID = MutId("01H0000000000000000000");

function runOnce(args: { sameMutId?: boolean; payload?: RawJson } = {}) {
    let ran = 0;
    const result = db.transaction(() => {
        return runWrappedMutation({
            sql,
            principalId: PRINCIPAL,
            mutId: args.sameMutId ? MUT_ID : MutId(`mut-${Math.random()}`),
            canonicalRequest: canonicalRequest("postMessage", args.payload ?? { x: 1 }),
            schemaEpoch: 1,
            nowMs: 1_700_000_000_000,
            cookie: Cookie("c-1"),
            run: () => {
                ran++;
                return {
                    status: "ok",
                    result: { id: "row-1" },
                    rowsAffected: 1,
                    touchedKeys: [{ table: "messages", pk: "row-1" }],
                };
            },
        });
    })();
    return { ran, result };
}

describe("op-log wrapper — D3 idempotency", () => {
    test("first call runs user closure and writes envelope", () => {
        const { ran, result } = runOnce({ sameMutId: true });
        expect(ran).toBe(1);
        expect(result.ran).toBe(true);
        expect(result.envelope.status).toBe("ok");

        const stored = db
            .prepare("SELECT principal_id, mut_id, length(payload_enc) AS sz, touched_keys FROM _chardb_op_log")
            .all() as { principal_id: string; mut_id: string; sz: number; touched_keys: string }[];
        expect(stored.length).toBe(1);
        expect((stored[0] as { sz: number }).sz).toBeGreaterThan(0);
        expect(JSON.parse((stored[0] as { touched_keys: string }).touched_keys)).toEqual([
            { table: "messages", pk: "row-1" },
        ]);
    });

    test("retry with same payload returns cached envelope and does NOT run closure", () => {
        runOnce({ sameMutId: true });
        const { ran, result } = runOnce({ sameMutId: true });
        expect(ran).toBe(0);
        expect(result.ran).toBe(false);
        expect(result.envelope.status).toBe("ok");
    });

    test("retry with mismatching payload raises CDB_MUT_ID_COLLISION with matching code", () => {
        runOnce({ sameMutId: true, payload: { x: 1 } });
        let captured: CdbError | undefined;
        try {
            runOnce({ sameMutId: true, payload: { x: 2 } });
        } catch (e) {
            if (e instanceof CdbError) captured = e;
        }
        expect(captured).toBeInstanceOf(CdbError);
        expect(captured?.code).toBe("CDB_MUT_ID_COLLISION");
        expect(captured?.toJSON().docs).toBe("https://chardb.dev/errors/cdb_mut_id_collision");
    });

    test("two distinct mutIds insert two rows", () => {
        runOnce({ sameMutId: false });
        runOnce({ sameMutId: false });
        const { count } = db.prepare("SELECT COUNT(*) AS count FROM _chardb_op_log").get() as {
            count: number;
        };
        expect(count).toBe(2);
    });

    test("canonicalRequest is order-stable across object key permutations", () => {
        const a = canonicalRequest("ref", { a: 1, b: 2 } as never);
        const b = canonicalRequest("ref", { b: 2, a: 1 } as never);
        expect(b).toBe(a);
    });

    test("canonicalRequest preserves own __proto__ data for replay identity", () => {
        const payload = (value: string): RawJson => {
            const object = { stable: true } as Record<string, RawJson>;
            Object.defineProperty(object, "__proto__", {
                value: { value },
                enumerable: true,
                writable: true,
                configurable: true,
            });
            return object;
        };

        expect(canonicalRequest("ref", payload("a"))).toBe(
            '{"ref":"ref","args":{"__proto__":{"value":"a"},"stable":true}}'
        );
        expect(runOnce({ sameMutId: true, payload: payload("a") }).result.ran).toBe(true);
        expect(runOnce({ sameMutId: true, payload: payload("a") })).toMatchObject({ ran: 0, result: { ran: false } });
        expect(() => runOnce({ sameMutId: true, payload: payload("b") })).toThrowError(
            expect.objectContaining({ code: "CDB_MUT_ID_COLLISION" })
        );
    });

    test("concurrent in-flight: row with empty payload_enc raises CDB_TXN_ABORTED_EVICTION", () => {
        // Simulate the race: an INSERT OR IGNORE landed (claiming the slot)
        // but the wrapping txn hasn't yet UPDATE-ed the payload. A second call
        // observing the bare row sees a transient eviction, not a collision —
        // the same mutId is still in flight. Drive the first call normally to
        // produce the correct payload_hash, then zero out the payload_enc to
        // recreate the partial-write state and re-run.
        runOnce({ sameMutId: true, payload: { x: 99 } });
        db.run("UPDATE _chardb_op_log SET payload_enc = ? WHERE principal_id = ? AND mut_id = ?", [
            new Uint8Array(0),
            PRINCIPAL,
            MUT_ID,
        ]);
        let captured: CdbError | undefined;
        try {
            runOnce({ sameMutId: true, payload: { x: 99 } });
        } catch (e) {
            if (e instanceof CdbError) captured = e;
        }
        expect(captured).toBeInstanceOf(CdbError);
        expect(captured?.code).toBe("CDB_TXN_ABORTED_EVICTION");
        expect(captured?.toJSON().retryable).toBe(true);
    });

    test("a non-JSON handler result raises a typed error and rolls back its provisional op-log row", () => {
        let captured: CdbError | undefined;
        try {
            db.transaction(() =>
                runWrappedMutation({
                    sql,
                    principalId: PRINCIPAL,
                    mutId: MutId("invalid-result"),
                    canonicalRequest: canonicalRequest("invalidResult", {}),
                    schemaEpoch: 1,
                    nowMs: 1_700_000_000_000,
                    cookie: Cookie("c-invalid"),
                    run: () => ({ status: "ok", result: 1n, rowsAffected: 0 }),
                })
            )();
        } catch (error) {
            if (error instanceof CdbError) captured = error;
        }

        expect(captured?.code).toBe("CDB_INVARIANT");
        expect(captured?.message).toContain("mutation result is not JSON at $");
        expect((db.prepare("SELECT COUNT(*) AS count FROM _chardb_op_log").get() as { count: number }).count).toBe(0);
    });
});
