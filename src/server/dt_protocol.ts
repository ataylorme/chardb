/**
 * 2PC coordinator/participant protocol (v1.1).
 *
 * The protocol logic is pure SQL against `SyncSql` and a `Participant` RPC
 * surface. Wiring into Durable Objects (Cdb shards as participants, the
 * Worker entrypoint as the coordinator) is intentionally a thin adapter
 * that calls into this module — that adapter lives outside the test path
 * so the protocol stays unit-testable against `bun:sqlite`.
 *
 * ## State machine (`_chardb_dt_state.state`)
 *
 *   preparing  ──(any vote='no' OR participant unreachable on prepare)──▶ aborted
 *      │
 *      ├──(all participants vote='yes')──▶ committed
 *      │
 *      └──(coordinator crash)─▶ recovery scans 'preparing' rows and resolves
 *          via `Participant.getVote(dtId)` against the durable
 *          `_chardb_dt_participant.vote` write each participant made under
 *          its own `transactionSync`. Decision rule:
 *             - any vote='no'      → abort
 *             - all vote='yes'     → commit
 *             - any vote='unknown' → abort (presumed-abort)
 *
 * ## Why presumed-abort?
 *
 * Standard 2PC literature (Bernstein/Hadzilacos/Goodman §7.4, plus the
 * Cloudflare Durable Object failure model where a participant might have
 * forgotten a `prepare` it never durably acked) makes presumed-abort the
 * only safe default: a participant with no record of `dtId` cannot have
 * voted `yes`, because `yes` requires a durable write under its own
 * transaction. Therefore "unknown" is treated as "no" during recovery.
 *
 * ## Atomicity
 *
 * The coordinator's state transitions (preparing→committed/aborted) and
 * the per-participant `vote`/`bookmark` writes each happen inside the
 * caller's `transactionSync`. The driver here issues `exec`/`one` calls
 * that are durable on commit; the caller is responsible for wrapping the
 * appropriate critical sections in a single transaction. See
 * `runCoordinator` for the boundary.
 */

import { CdbError } from "../errors.ts";
import type { SyncSql } from "../oplog/wrapper.ts";

export type DtState = "preparing" | "committed" | "aborted";
export type Vote = "yes" | "no";
/** What a participant returns when asked about a dtId it cannot find. */
export type RecoveryVote = Vote | "unknown";

export interface PreparePlan {
    /** Stable, sorted list of participant shard ids; same set across retries. */
    readonly participants: readonly string[];
    /** Opaque payload the participants will execute under their own tx. */
    readonly payload: string;
}

export interface ParticipantPrepareResponse {
    readonly vote: Vote;
    /** Op-log bookmark the participant durably recorded for this dtId. */
    readonly bookmark: number;
}

/**
 * RPC contract a participant must implement. The actual Durable Object
 * adapter calls into the participant's `Cdb` over service binding.
 */
export interface Participant {
    /**
     * Run the prepare phase under the participant's own transaction. Must
     * durably record the vote in `_chardb_dt_participant` before returning.
     * Throws iff the participant could not durably record `vote='no'`
     * either (network failure, sqlite I/O error, etc.).
     */
    prepare(dtId: string, payload: string): Promise<ParticipantPrepareResponse>;
    /** Apply the committed state. Idempotent on `dtId`. */
    commit(dtId: string): Promise<void>;
    /** Discard any prepared state. Idempotent on `dtId`. */
    abort(dtId: string): Promise<void>;
    /** Recovery query: what vote did this participant durably record? */
    getVote(dtId: string): Promise<RecoveryVote>;
}

/**
 * Coordinator handle. Implementations of these calls write into
 * `_chardb_dt_state` and `_chardb_dt_participant`.
 */
export interface CoordinatorStore {
    readonly sql: SyncSql;
    /** Wall clock for `opened_at` / `decided_at`. */
    now(): number;
}

/* -------------------------------------------------------------------------- */
/*                              Coordinator API                               */
/* -------------------------------------------------------------------------- */

/**
 * Opens a new dtId in `preparing` and persists the participant set.
 * Caller MUST wrap this in `transactionSync` so the state row and
 * the per-participant rows commit atomically.
 */
export function openDt(
    store: CoordinatorStore,
    args: {
        readonly dtId: string;
        readonly initiatorPrincipal: string;
        readonly plan: PreparePlan;
    }
): void {
    const sortedParticipants = [...args.plan.participants].sort();
    const seen = new Set(sortedParticipants);
    if (seen.size !== sortedParticipants.length) {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: "duplicate participant ids in PreparePlan",
        });
    }
    if (sortedParticipants.length === 0) {
        throw new CdbError({ code: "CDB_INVARIANT", message: "PreparePlan.participants is empty" });
    }
    store.sql.exec(
        `INSERT INTO _chardb_dt_state (dt_id, state, initiator_principal, partition_plan, opened_at, decided_at)
     VALUES (?, 'preparing', ?, ?, ?, NULL)`,
        args.dtId,
        args.initiatorPrincipal,
        JSON.stringify({ participants: sortedParticipants, payload: args.plan.payload }),
        store.now()
    );
    for (const sid of sortedParticipants) {
        store.sql.exec(
            "INSERT INTO _chardb_dt_participant (dt_id, shard_id, vote, bookmark) VALUES (?, ?, NULL, NULL)",
            args.dtId,
            sid
        );
    }
}

/** Read the coordinator state row, or null if dtId is unknown. */
export function readDtState(
    store: CoordinatorStore,
    dtId: string
): { state: DtState; participants: readonly string[]; payload: string } | null {
    const row = store.sql.one<{ state: DtState; partition_plan: string }>(
        "SELECT state, partition_plan FROM _chardb_dt_state WHERE dt_id = ?",
        dtId
    );
    if (!row) return null;
    const plan = JSON.parse(row.partition_plan) as {
        participants: readonly string[];
        payload: string;
    };
    return { state: row.state, participants: plan.participants, payload: plan.payload };
}

/** Write a vote/bookmark for a participant. Caller wraps in tx. */
export function recordVote(
    store: CoordinatorStore,
    args: {
        readonly dtId: string;
        readonly shardId: string;
        readonly vote: Vote;
        readonly bookmark: number;
    }
): void {
    store.sql.exec(
        "UPDATE _chardb_dt_participant SET vote = ?, bookmark = ? WHERE dt_id = ? AND shard_id = ?",
        args.vote,
        args.bookmark,
        args.dtId,
        args.shardId
    );
}

/** Atomically transition to a terminal state. Idempotent: a no-op if already terminal. */
export function decideDt(store: CoordinatorStore, dtId: string, decision: "committed" | "aborted"): void {
    const cur = store.sql.one<{ state: DtState }>("SELECT state FROM _chardb_dt_state WHERE dt_id = ?", dtId);
    if (!cur) throw new CdbError({ code: "CDB_INVARIANT", message: `decideDt: unknown dtId ${dtId}` });
    if (cur.state === decision) return;
    if (cur.state !== "preparing") {
        throw new CdbError({
            code: "CDB_INVARIANT",
            message: `decideDt: dtId ${dtId} is already ${cur.state}, cannot transition to ${decision}`,
        });
    }
    store.sql.exec(
        "UPDATE _chardb_dt_state SET state = ?, decided_at = ? WHERE dt_id = ?",
        decision,
        store.now(),
        dtId
    );
}

/* -------------------------------------------------------------------------- */
/*                             Driver: full 2PC                               */
/* -------------------------------------------------------------------------- */

export interface RunCoordinatorArgs {
    readonly store: CoordinatorStore;
    readonly dtId: string;
    readonly initiatorPrincipal: string;
    readonly plan: PreparePlan;
    readonly participantsByShard: ReadonlyMap<string, Participant>;
    /** Wrap a critical section in the coordinator's `transactionSync`. */
    readonly transaction: <T>(fn: () => T) => T;
}

export interface RunCoordinatorResult {
    readonly outcome: "committed" | "aborted";
    readonly votes: ReadonlyMap<string, Vote>;
    readonly bookmarks: ReadonlyMap<string, number>;
}

/**
 * Drive the protocol from open through decision and notify. The function
 * is idempotent on `dtId`: replaying after a coordinator restart calls
 * `recoverCoordinator` instead.
 *
 * Failure model:
 *   - `Participant.prepare` throws  → treated as `vote='no'` for that
 *     shard, transaction aborts (and we still notify abort to every
 *     participant we did successfully prepare).
 *   - coordinator dies after `openDt`     → recovery resolves via
 *     `getVote`.
 *   - coordinator dies after `decideDt`   → recovery sees the terminal
 *     state and re-fans the matching commit/abort RPCs.
 */
export async function runCoordinator(args: RunCoordinatorArgs): Promise<RunCoordinatorResult> {
    // 1. open. Single tx so the state row and the participant rows arrive together.
    args.transaction(() => {
        if (readDtState(args.store, args.dtId) !== null) return;
        openDt(args.store, {
            dtId: args.dtId,
            initiatorPrincipal: args.initiatorPrincipal,
            plan: args.plan,
        });
    });

    const sortedParticipants = [...args.plan.participants].sort();
    const votes = new Map<string, Vote>();
    const bookmarks = new Map<string, number>();
    let anyNo = false;

    // 2. prepare fan-out.
    await Promise.all(
        sortedParticipants.map(async sid => {
            const p = args.participantsByShard.get(sid);
            if (!p) {
                votes.set(sid, "no");
                bookmarks.set(sid, 0);
                anyNo = true;
                return;
            }
            try {
                const r = await p.prepare(args.dtId, args.plan.payload);
                votes.set(sid, r.vote);
                bookmarks.set(sid, r.bookmark);
                if (r.vote === "no") anyNo = true;
            } catch {
                votes.set(sid, "no");
                bookmarks.set(sid, 0);
                anyNo = true;
            }
        })
    );

    // 3. record votes + decide, atomically, on the coordinator.
    args.transaction(() => {
        for (const sid of sortedParticipants) {
            recordVote(args.store, {
                dtId: args.dtId,
                shardId: sid,
                vote: votes.get(sid) ?? "no",
                bookmark: bookmarks.get(sid) ?? 0,
            });
        }
        decideDt(args.store, args.dtId, anyNo ? "aborted" : "committed");
    });

    // 4. notify. Idempotent per participant.
    await notifyDecision(args.dtId, anyNo ? "aborted" : "committed", sortedParticipants, args.participantsByShard);

    return { outcome: anyNo ? "aborted" : "committed", votes, bookmarks };
}

async function notifyDecision(
    dtId: string,
    decision: "committed" | "aborted",
    participants: readonly string[],
    bound: ReadonlyMap<string, Participant>
): Promise<void> {
    await Promise.all(
        participants.map(async sid => {
            const p = bound.get(sid);
            if (!p) return;
            if (decision === "committed") await p.commit(dtId);
            else await p.abort(dtId);
        })
    );
}

/* -------------------------------------------------------------------------- */
/*                                  Recovery                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rerun on coordinator startup: scan `_chardb_dt_state` for any
 * `preparing` rows, resolve each via the participants, and re-issue the
 * notify phase for terminal rows that may have been written before a
 * crash interrupted notify.
 */
export async function recoverCoordinator(args: {
    readonly store: CoordinatorStore;
    readonly participantsByShard: ReadonlyMap<string, Participant>;
    readonly transaction: <T>(fn: () => T) => T;
}): Promise<ReadonlyArray<{ readonly dtId: string; readonly outcome: "committed" | "aborted" }>> {
    const rows = args.store.sql.all<{ dt_id: string; state: DtState; partition_plan: string }>(
        `SELECT dt_id, state, partition_plan FROM _chardb_dt_state WHERE state IN ('preparing','committed','aborted')`
    );
    const out: { dtId: string; outcome: "committed" | "aborted" }[] = [];
    for (const r of rows) {
        const plan = JSON.parse(r.partition_plan) as { participants: readonly string[] };
        const sorted = [...plan.participants].sort();
        if (r.state === "preparing") {
            // Resolve by polling each participant. presumed-abort if any unknown.
            const recoveryVotes = await Promise.all(
                sorted.map(async sid => {
                    const p = args.participantsByShard.get(sid);
                    if (!p) return "unknown" as RecoveryVote;
                    try {
                        return await p.getVote(r.dt_id);
                    } catch {
                        return "unknown" as RecoveryVote;
                    }
                })
            );
            const decision: "committed" | "aborted" = recoveryVotes.every(v => v === "yes") ? "committed" : "aborted";
            args.transaction(() => {
                for (let i = 0; i < sorted.length; i++) {
                    const sid = sorted[i];
                    const v = recoveryVotes[i];
                    if (!sid || !v) throw new Error("participant and recovery vote arrays must stay aligned");
                    recordVote(args.store, {
                        dtId: r.dt_id,
                        shardId: sid,
                        vote: v === "yes" ? "yes" : "no",
                        bookmark: 0,
                    });
                }
                decideDt(args.store, r.dt_id, decision);
            });
            await notifyDecision(r.dt_id, decision, sorted, args.participantsByShard);
            out.push({ dtId: r.dt_id, outcome: decision });
        } else {
            // Already decided; re-issue notify in case the previous run crashed mid-fanout.
            await notifyDecision(r.dt_id, r.state, sorted, args.participantsByShard);
            out.push({ dtId: r.dt_id, outcome: r.state });
        }
    }
    return out;
}
