/**
 * Op-log dedup under realistic load. We drive 1000 mutations across 50
 * partitions through `runWrappedMutation` against bun:sqlite (the same
 * engine workerd's `durable-sqlite` ships with) and assert the four
 * invariants the workerd-level Cdb DO is built on top of.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CdbError } from "../../../../../src/errors.ts";
import { OP_LOG_DDL } from "../../../../../src/oplog/schema.ts";
import {
    type SqlParam,
    type SqlValue,
    type SyncSql,
    canonicalRequest,
    runWrappedMutation,
} from "../../../../../src/oplog/wrapper.ts";
import { Cookie, MutId, PrincipalId } from "../../../../../src/types.ts";
import { vshardOf } from "../../../../../src/vshard.ts";

const PARTITIONS = 50;
const MUTS_PER_PARTITION = 20;
const TOTAL = PARTITIONS * MUTS_PER_PARTITION;

function xorshift32(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s;
    };
}

/**
 * The runtime adapter we hand to `runWrappedMutation`. We don't annotate
 * the return as `SyncSql` because TS's contravariant check on generic
 * method parameters complains about a constraint mismatch even when the
 * underlying calls are correct; the parameter type on `runWrappedMutation`
 * does the structural enforcement we need.
 */
function makeSyncSql(db: Database): SyncSql {
    let lastChanges = 0;
    const sql: SyncSql = {
        exec(sqlText: string, ...params: SqlParam[]): void {
            const r = db.prepare(sqlText).run(...(params as unknown as never[]));
            lastChanges = r.changes;
        },
        one: ((sqlText: string, ...params: SqlParam[]) => {
            const row = db.prepare(sqlText).get(...(params as unknown as never[]));
            return (row ?? null) as Record<string, SqlValue> | null;
        }) as SyncSql["one"],
        all: ((sqlText: string, ...params: SqlParam[]) =>
            db.prepare(sqlText).all(...(params as unknown as never[])) as Record<string, SqlValue>[]) as SyncSql["all"],
        changes: () => lastChanges,
    };
    return sql;
}

interface PlannedMutation {
    readonly orgId: string;
    readonly principalId: string;
    readonly mutId: string;
    readonly payload: { readonly seq: number; readonly orgId: string };
}

function planMutations(seed: number): readonly PlannedMutation[] {
    const rng = xorshift32(seed);
    const out: PlannedMutation[] = [];
    for (let p = 0; p < PARTITIONS; p++) {
        const orgId = `org-${p.toString().padStart(3, "0")}`;
        for (let m = 0; m < MUTS_PER_PARTITION; m++) {
            const mutId = `mut-${p}-${m}-${rng().toString(16)}`;
            out.push({
                orgId,
                principalId: orgId,
                mutId,
                payload: { seq: m, orgId },
            });
        }
    }
    return out;
}

function setupDb() {
    const db = new Database(":memory:");
    for (const stmt of OP_LOG_DDL.split(";")
        .map(s => s.trim())
        .filter(Boolean))
        db.run(stmt);
    return { db, sql: makeSyncSql(db) };
}

describe("e2e oplog — 1000 mutations across 50 partitions", () => {
    test("(a) deterministic vshard routing — vshardOf is pure and stable", () => {
        const muts = planMutations(0xc0ffee);
        const a = muts.map(m => Number(vshardOf([m.orgId])));
        const b = muts.map(m => Number(vshardOf([m.orgId])));
        expect(a).toEqual(b);
        const distinctOrgs = new Set(muts.map(m => m.orgId));
        expect(distinctOrgs.size).toBe(PARTITIONS);
        const distinctVshards = new Set(a);
        expect(distinctVshards.size).toBeGreaterThan(1);
    });

    test("(b) replay returns cached envelope, user closure runs exactly once per (principal, mutId)", () => {
        const { db, sql } = setupDb();
        const muts = planMutations(0xc0ffee);
        let firstRunCount = 0;
        for (const m of muts) {
            db.transaction(() => {
                runWrappedMutation({
                    sql,
                    principalId: PrincipalId(m.principalId),
                    mutId: MutId(m.mutId),
                    canonicalRequest: canonicalRequest("postMessage", m.payload),
                    schemaEpoch: 1,
                    nowMs: 1_700_000_000_000,
                    cookie: Cookie("c-1"),
                    run: () => {
                        firstRunCount++;
                        return { status: "ok", result: { id: m.mutId }, rowsAffected: 1 };
                    },
                });
            })();
        }
        expect(firstRunCount).toBe(TOTAL);

        let replayRunCount = 0;
        const replayedEnvs: { ran: boolean }[] = [];
        for (const m of muts) {
            db.transaction(() => {
                const r = runWrappedMutation({
                    sql,
                    principalId: PrincipalId(m.principalId),
                    mutId: MutId(m.mutId),
                    canonicalRequest: canonicalRequest("postMessage", m.payload),
                    schemaEpoch: 1,
                    nowMs: 1_700_000_000_001,
                    cookie: Cookie("c-2"),
                    run: () => {
                        replayRunCount++;
                        return { status: "ok", result: { id: m.mutId }, rowsAffected: 1 };
                    },
                });
                replayedEnvs.push({ ran: r.ran });
            })();
        }
        expect(replayRunCount).toBe(0);
        expect(replayedEnvs.every(r => r.ran === false)).toBe(true);

        const { count } = db.prepare("SELECT COUNT(*) AS count FROM _chardb_op_log").get() as {
            count: number;
        };
        expect(count).toBe(TOTAL);
        db.close();
    });

    test("(c) same mutId + different payload raises CDB_MUT_ID_COLLISION", () => {
        const { db, sql } = setupDb();
        const principal = PrincipalId("org-collide");
        const mutId = MutId("mut-collide");
        db.transaction(() => {
            runWrappedMutation({
                sql,
                principalId: principal,
                mutId,
                canonicalRequest: canonicalRequest("postMessage", { x: 1 }),
                schemaEpoch: 1,
                nowMs: 1,
                cookie: Cookie("c"),
                run: () => ({ status: "ok", result: null, rowsAffected: 1 }),
            });
        })();
        let caught: unknown;
        try {
            db.transaction(() => {
                runWrappedMutation({
                    sql,
                    principalId: principal,
                    mutId,
                    canonicalRequest: canonicalRequest("postMessage", { x: 2 }),
                    schemaEpoch: 1,
                    nowMs: 2,
                    cookie: Cookie("c"),
                    run: () => ({ status: "ok", result: null, rowsAffected: 1 }),
                });
            })();
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CdbError);
        expect((caught as CdbError).code).toBe("CDB_MUT_ID_COLLISION");
        db.close();
    });

    test("(d) per-partition serial commit order is preserved (event_id monotonic per principal)", () => {
        const { db, sql } = setupDb();
        const muts = planMutations(0xbadf00d);
        for (const m of muts) {
            db.transaction(() => {
                runWrappedMutation({
                    sql,
                    principalId: PrincipalId(m.principalId),
                    mutId: MutId(m.mutId),
                    canonicalRequest: canonicalRequest("postMessage", m.payload),
                    schemaEpoch: 1,
                    nowMs: 1,
                    cookie: Cookie("c"),
                    run: () => ({ status: "ok", result: null, rowsAffected: 1 }),
                });
            })();
        }
        const rows = db
            .prepare("SELECT principal_id, mut_id, event_id FROM _chardb_op_log ORDER BY event_id")
            .all() as { principal_id: string; mut_id: string; event_id: number }[];
        expect(rows.length).toBe(TOTAL);
        const lastByPrincipal = new Map<string, number>();
        const insertionOrder = new Map<string, string[]>();
        for (const m of muts) {
            const arr = insertionOrder.get(m.principalId) ?? [];
            arr.push(m.mutId);
            insertionOrder.set(m.principalId, arr);
        }
        const observedOrder = new Map<string, string[]>();
        for (const r of rows) {
            const prev = lastByPrincipal.get(r.principal_id);
            if (prev !== undefined) expect(r.event_id).toBeGreaterThan(prev);
            lastByPrincipal.set(r.principal_id, r.event_id);
            const arr = observedOrder.get(r.principal_id) ?? [];
            arr.push(r.mut_id);
            observedOrder.set(r.principal_id, arr);
        }
        for (const [pid, expected] of insertionOrder) {
            expect(observedOrder.get(pid)).toEqual(expected);
        }
        db.close();
    });
});
