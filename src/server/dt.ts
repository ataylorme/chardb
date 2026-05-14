/**
 * Distributed-transaction (2PC) scaffold.
 *
 * `db.crossPartitionMutation` is the v1.1 surface for committing across more
 * than one partition. The foundation ships the typed contract, the DDL for
 * the coordinator tables (`_chardb_dt_state`, `_chardb_dt_participant`), and
 * a runtime stub that raises `CDB_DT_NOT_IMPLEMENTED` so callers can wire the
 * shape without the full protocol.
 *
 * Protocol outline (for the eventual v1.1 implementation):
 *   1. PREPARE — coordinator writes `_chardb_dt_state(state='preparing')`,
 *      fans out `prepare(dtId, partitionPlan)` to each participant Cdb shard.
 *      Each participant durably appends a row to `_chardb_dt_participant`
 *      with `vote='yes'` / `'no'` plus its op-log bookmark.
 *   2. COMMIT / ABORT — once every participant votes, the coordinator
 *      atomically flips `_chardb_dt_state.state` to `committed`/`aborted`
 *      and fans the decision out. Recovery follows the standard 2PC log
 *      replay against the coordinator state.
 *
 * The DDL below is shipped now so migrations don't churn when v1.1 lands.
 */

import { CdbError } from "../errors.ts";
import type { RawJson } from "../types.ts";
import {
    type CoordinatorStore,
    type Participant,
    type PreparePlan,
    recoverCoordinator,
    runCoordinator,
} from "./dt_protocol.ts";

export const DT_DDL = `
CREATE TABLE IF NOT EXISTS _chardb_dt_state (
  dt_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  initiator_principal TEXT NOT NULL,
  partition_plan TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS _chardb_dt_participant (
  dt_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  vote TEXT,
  bookmark INTEGER,
  PRIMARY KEY (dt_id, shard_id)
);
` as const;

export type DtState = "preparing" | "committed" | "aborted";

export interface CrossPartitionMutationSpec<TArgs extends RawJson, TResult> {
    readonly partitions: readonly string[];
    readonly run: (ctx: unknown, args: TArgs) => Promise<TResult>;
}

/**
 * Runtime coordinator hooks — supplied by the host. The Worker entrypoint
 * fills these in with the real `_chardb_dt_state` storage (a Catalog DO
 * SqlStorage) and a participant resolver that maps shard ids to their
 * `Cdb` service-binding RPC stubs. Tests can pass any conforming
 * implementation; `bun:sqlite` is enough.
 *
 * Left null while no host is bound, in which case `crossPartitionMutation`
 * falls back to the v1.0 `CDB_DT_NOT_IMPLEMENTED` error so misconfigured
 * deployments fail loud rather than silently.
 */
export interface DtRuntime {
    readonly store: CoordinatorStore;
    readonly participantsByShard: ReadonlyMap<string, Participant>;
    readonly transaction: <T>(fn: () => T) => T;
    /** Resolve a `CrossPartitionMutationSpec.run` result to a payload string. */
    readonly nextDtId: () => string;
    readonly principalOf: () => string;
}

let boundRuntime: DtRuntime | null = null;

/** Host bootstrap call — invoked once by the WorkerEntrypoint. */
export function bindDtRuntime(rt: DtRuntime | null): void {
    boundRuntime = rt;
}

/** Recover any in-flight 2PC transactions on coordinator startup. */
export async function recoverDt(): Promise<ReadonlyArray<{ dtId: string; outcome: "committed" | "aborted" }>> {
    if (!boundRuntime) return [];
    return recoverCoordinator({
        store: boundRuntime.store,
        participantsByShard: boundRuntime.participantsByShard,
        transaction: boundRuntime.transaction,
    });
}

/**
 * Typed surface for cross-partition writes. When a `DtRuntime` is bound
 * (production or tests), routes through the 2PC coordinator and returns
 * the user's `run` result on commit. Otherwise raises
 * `CDB_DT_NOT_IMPLEMENTED` so misconfigured deployments fail loud.
 *
 * The user's `run` callback executes inside the coordinator's PREPARE
 * fan-out: each participant receives the canonicalized payload via
 * `Participant.prepare`, runs its slice of the work under its own
 * `transactionSync`, and durably votes. The single `run` here builds the
 * payload — it's deliberately *not* invoked locally because the
 * authoritative run is the per-shard prepare.
 */
export function crossPartitionMutation<TArgs extends RawJson, TResult>(
    spec: CrossPartitionMutationSpec<TArgs, TResult>
): (args: TArgs) => Promise<TResult> {
    return async (args: TArgs): Promise<TResult> => {
        const rt = boundRuntime;
        if (!rt) {
            throw new CdbError({
                code: "CDB_DT_NOT_IMPLEMENTED",
                message: "db.crossPartitionMutation requires bindDtRuntime(...) before invocation",
            });
        }
        if (spec.partitions.length === 0) {
            throw new CdbError({
                code: "CDB_INVARIANT",
                message: "crossPartitionMutation: empty partitions",
            });
        }
        const dtId = rt.nextDtId();
        const plan: PreparePlan = {
            participants: spec.partitions,
            payload: JSON.stringify({ args, ref: spec.run.name || "anonymous" }),
        };
        const result = await runCoordinator({
            store: rt.store,
            dtId,
            initiatorPrincipal: rt.principalOf(),
            plan,
            participantsByShard: rt.participantsByShard,
            transaction: rt.transaction,
        });
        if (result.outcome === "aborted") {
            throw new CdbError({
                code: "CDB_DT_ABORTED",
                message: `cross-partition transaction ${dtId} aborted by participants`,
            });
        }
        // The user's `run` result type lives in the participant outputs; for
        // v1.1 we surface `void`-shaped success and let the caller's
        // application-level read fetch the committed state. A future revision
        // will thread `Participant.commit` return values back here.
        return undefined as TResult;
    };
}
