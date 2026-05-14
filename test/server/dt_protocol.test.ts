/**
 * 2PC v1.1 protocol tests against `bun:sqlite`.
 *
 * Covers the full state machine:
 *   - happy path: all yes → committed, every participant gets `commit`,
 *   - one-no abort: any participant 'no' → aborted, every participant
 *     (including yes-voters) gets `abort`,
 *   - prepare failure: thrown error during prepare counts as 'no',
 *   - recovery from preparing: presumed-abort if any participant returns
 *     'unknown', commit if all 'yes',
 *   - recovery from terminal state: re-fans the matching commit/abort,
 *   - openDt rejects empty / duplicate participant sets,
 *   - decideDt is idempotent on its terminal state.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CdbError } from "../../src/errors.ts";
import type { SqlParam, SqlValue, SyncSql } from "../../src/oplog/wrapper.ts";
import { DT_DDL, bindDtRuntime, crossPartitionMutation } from "../../src/server/dt.ts";
import {
    type Participant,
    type RecoveryVote,
    decideDt,
    openDt,
    readDtState,
    recordVote,
    recoverCoordinator,
    runCoordinator,
} from "../../src/server/dt_protocol.ts";

function syncSqlOver(db: Database): SyncSql {
    return {
        exec: (sql: string, ...params: SqlParam[]) => {
            db.run(sql, params as SqlValue[]);
        },
        one: <T = Record<string, SqlValue>>(sql: string, ...params: SqlParam[]): T | null => {
            const rows = db.prepare(sql).all(...(params as SqlValue[]));
            return (rows[0] ?? null) as T | null;
        },
        all: <T = Record<string, SqlValue>>(sql: string, ...params: SqlParam[]): T[] => {
            return db.prepare(sql).all(...(params as SqlValue[])) as T[];
        },
        changes: () => Number(db.run("SELECT 1").changes),
    };
}

function setupCoordinator() {
    const db = new Database(":memory:");
    for (const stmt of DT_DDL.split(";")
        .map(s => s.trim())
        .filter(Boolean)) {
        db.run(stmt);
    }
    let nowMs = 1_000;
    const sql = syncSqlOver(db);
    return {
        db,
        store: { sql, now: () => nowMs },
        transaction: <T>(fn: () => T): T => db.transaction(fn)(),
        advance: (ms: number) => {
            nowMs += ms;
        },
    };
}

function fakeParticipant(opts: {
    vote?: "yes" | "no";
    prepareThrows?: boolean;
    recoveryVote?: RecoveryVote;
}): {
    participant: Participant;
    calls: { prepare: number; commit: number; abort: number; getVote: number };
} {
    const calls = { prepare: 0, commit: 0, abort: 0, getVote: 0 };
    const participant: Participant = {
        async prepare() {
            calls.prepare++;
            if (opts.prepareThrows) throw new Error("prepare boom");
            return { vote: opts.vote ?? "yes", bookmark: 42 };
        },
        async commit() {
            calls.commit++;
        },
        async abort() {
            calls.abort++;
        },
        async getVote() {
            calls.getVote++;
            return opts.recoveryVote ?? "unknown";
        },
    };
    return { participant, calls };
}

describe("2PC coordinator — happy path", () => {
    test("all participants vote yes → state=committed, commit RPC fans to all", async () => {
        const c = setupCoordinator();
        const a = fakeParticipant({ vote: "yes" });
        const b = fakeParticipant({ vote: "yes" });
        const result = await runCoordinator({
            store: c.store,
            dtId: "dt-1",
            initiatorPrincipal: "p-1",
            plan: { participants: ["s-a", "s-b"], payload: "{}" },
            participantsByShard: new Map([
                ["s-a", a.participant],
                ["s-b", b.participant],
            ]),
            transaction: c.transaction,
        });
        expect(result.outcome).toBe("committed");
        expect(result.votes.get("s-a")).toBe("yes");
        expect(result.votes.get("s-b")).toBe("yes");
        expect(a.calls).toEqual({ prepare: 1, commit: 1, abort: 0, getVote: 0 });
        expect(b.calls).toEqual({ prepare: 1, commit: 1, abort: 0, getVote: 0 });
        const state = readDtState(c.store, "dt-1");
        expect(state?.state).toBe("committed");
    });
});

describe("2PC coordinator — abort paths", () => {
    test("one no-vote → aborted, every participant gets abort (including yes-voter)", async () => {
        const c = setupCoordinator();
        const a = fakeParticipant({ vote: "yes" });
        const b = fakeParticipant({ vote: "no" });
        const result = await runCoordinator({
            store: c.store,
            dtId: "dt-2",
            initiatorPrincipal: "p-1",
            plan: { participants: ["s-a", "s-b"], payload: "{}" },
            participantsByShard: new Map([
                ["s-a", a.participant],
                ["s-b", b.participant],
            ]),
            transaction: c.transaction,
        });
        expect(result.outcome).toBe("aborted");
        expect(a.calls.abort).toBe(1);
        expect(a.calls.commit).toBe(0);
        expect(b.calls.abort).toBe(1);
        expect(b.calls.commit).toBe(0);
    });

    test("prepare throws → counts as no and forces abort", async () => {
        const c = setupCoordinator();
        const a = fakeParticipant({ vote: "yes" });
        const b = fakeParticipant({ prepareThrows: true });
        const result = await runCoordinator({
            store: c.store,
            dtId: "dt-3",
            initiatorPrincipal: "p-1",
            plan: { participants: ["s-a", "s-b"], payload: "{}" },
            participantsByShard: new Map([
                ["s-a", a.participant],
                ["s-b", b.participant],
            ]),
            transaction: c.transaction,
        });
        expect(result.outcome).toBe("aborted");
        expect(result.votes.get("s-b")).toBe("no");
    });

    test("missing participant binding → counts as no and forces abort", async () => {
        const c = setupCoordinator();
        const a = fakeParticipant({ vote: "yes" });
        const result = await runCoordinator({
            store: c.store,
            dtId: "dt-4",
            initiatorPrincipal: "p-1",
            plan: { participants: ["s-a", "s-b"], payload: "{}" },
            participantsByShard: new Map([["s-a", a.participant]]),
            transaction: c.transaction,
        });
        expect(result.outcome).toBe("aborted");
        expect(result.votes.get("s-b")).toBe("no");
    });
});

describe("2PC coordinator — recovery", () => {
    test("preparing row + all participants report yes → committed via getVote", async () => {
        const c = setupCoordinator();
        c.transaction(() => {
            openDt(c.store, {
                dtId: "dt-5",
                initiatorPrincipal: "p-1",
                plan: { participants: ["s-a", "s-b"], payload: "{}" },
            });
        });
        const a = fakeParticipant({ recoveryVote: "yes" });
        const b = fakeParticipant({ recoveryVote: "yes" });
        const out = await recoverCoordinator({
            store: c.store,
            participantsByShard: new Map([
                ["s-a", a.participant],
                ["s-b", b.participant],
            ]),
            transaction: c.transaction,
        });
        expect(out).toEqual([{ dtId: "dt-5", outcome: "committed" }]);
        expect(a.calls.commit).toBe(1);
        expect(b.calls.commit).toBe(1);
    });

    test("preparing row + any unknown vote → presumed-abort", async () => {
        const c = setupCoordinator();
        c.transaction(() => {
            openDt(c.store, {
                dtId: "dt-6",
                initiatorPrincipal: "p-1",
                plan: { participants: ["s-a", "s-b"], payload: "{}" },
            });
        });
        const a = fakeParticipant({ recoveryVote: "yes" });
        const b = fakeParticipant({ recoveryVote: "unknown" });
        const out = await recoverCoordinator({
            store: c.store,
            participantsByShard: new Map([
                ["s-a", a.participant],
                ["s-b", b.participant],
            ]),
            transaction: c.transaction,
        });
        expect(out).toEqual([{ dtId: "dt-6", outcome: "aborted" }]);
        expect(a.calls.abort).toBe(1);
        expect(b.calls.abort).toBe(1);
    });

    test("already-terminal row re-fans the matching decision (idempotent recovery)", async () => {
        const c = setupCoordinator();
        c.transaction(() => {
            openDt(c.store, {
                dtId: "dt-7",
                initiatorPrincipal: "p-1",
                plan: { participants: ["s-a"], payload: "{}" },
            });
            recordVote(c.store, { dtId: "dt-7", shardId: "s-a", vote: "yes", bookmark: 42 });
            decideDt(c.store, "dt-7", "committed");
        });
        const a = fakeParticipant({});
        const out = await recoverCoordinator({
            store: c.store,
            participantsByShard: new Map([["s-a", a.participant]]),
            transaction: c.transaction,
        });
        expect(out).toEqual([{ dtId: "dt-7", outcome: "committed" }]);
        expect(a.calls.commit).toBe(1);
        expect(a.calls.getVote).toBe(0);
    });
});

describe("2PC primitives — invariant guards", () => {
    test("openDt rejects empty participants", () => {
        const c = setupCoordinator();
        expect(() =>
            c.transaction(() => {
                openDt(c.store, {
                    dtId: "dt-x",
                    initiatorPrincipal: "p-1",
                    plan: { participants: [], payload: "" },
                });
            })
        ).toThrow(/empty/);
    });

    test("openDt rejects duplicate participants", () => {
        const c = setupCoordinator();
        expect(() =>
            c.transaction(() => {
                openDt(c.store, {
                    dtId: "dt-x",
                    initiatorPrincipal: "p-1",
                    plan: { participants: ["s-a", "s-a"], payload: "" },
                });
            })
        ).toThrow(/duplicate/);
    });

    test("decideDt is idempotent on its own terminal state but rejects flips", () => {
        const c = setupCoordinator();
        c.transaction(() => {
            openDt(c.store, {
                dtId: "dt-flip",
                initiatorPrincipal: "p-1",
                plan: { participants: ["s-a"], payload: "" },
            });
            decideDt(c.store, "dt-flip", "committed");
            decideDt(c.store, "dt-flip", "committed");
        });
        expect(() =>
            c.transaction(() => {
                decideDt(c.store, "dt-flip", "aborted");
            })
        ).toThrow(/already committed/);
    });
});

describe("crossPartitionMutation runtime binding", () => {
    test("returns CDB_DT_NOT_IMPLEMENTED when no runtime is bound", async () => {
        bindDtRuntime(null);
        const fn = crossPartitionMutation<{ x: number }, void>({
            partitions: ["s-a", "s-b"],
            run: async () => {},
        });
        let captured: CdbError | undefined;
        try {
            await fn({ x: 1 });
        } catch (e) {
            if (e instanceof CdbError) captured = e;
        }
        expect(captured?.code).toBe("CDB_DT_NOT_IMPLEMENTED");
    });

    test("with runtime bound: commits and resolves on all-yes", async () => {
        const c = setupCoordinator();
        const a = fakeParticipant({ vote: "yes" });
        const b = fakeParticipant({ vote: "yes" });
        let n = 0;
        bindDtRuntime({
            store: c.store,
            participantsByShard: new Map([
                ["s-a", a.participant],
                ["s-b", b.participant],
            ]),
            transaction: c.transaction,
            nextDtId: () => `dt-${++n}`,
            principalOf: () => "p-1",
        });
        const fn = crossPartitionMutation<{ x: number }, void>({
            partitions: ["s-a", "s-b"],
            run: async () => {},
        });
        await fn({ x: 1 });
        expect(a.calls.commit).toBe(1);
        expect(b.calls.commit).toBe(1);
        bindDtRuntime(null);
    });

    test("with runtime bound: rejects with CDB_DT_ABORTED on a no-vote", async () => {
        const c = setupCoordinator();
        const a = fakeParticipant({ vote: "yes" });
        const b = fakeParticipant({ vote: "no" });
        let n = 100;
        bindDtRuntime({
            store: c.store,
            participantsByShard: new Map([
                ["s-a", a.participant],
                ["s-b", b.participant],
            ]),
            transaction: c.transaction,
            nextDtId: () => `dt-${++n}`,
            principalOf: () => "p-1",
        });
        const fn = crossPartitionMutation<{ x: number }, void>({
            partitions: ["s-a", "s-b"],
            run: async () => {},
        });
        let captured: CdbError | undefined;
        try {
            await fn({ x: 1 });
        } catch (e) {
            if (e instanceof CdbError) captured = e;
        }
        expect(captured?.code).toBe("CDB_DT_ABORTED");
        bindDtRuntime(null);
    });
});
