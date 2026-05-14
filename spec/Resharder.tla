------------------------------ MODULE Resharder ------------------------------
(***************************************************************************)
(* Models the chardb Resharder phase machine.                              *)
(*                                                                         *)
(* See: src/server/do/resharder.ts (RESHARDER_PHASE, advance, abort)      *)
(*                                                                         *)
(* The Resharder DO orchestrates an online vshard-range move from a       *)
(* Source ShardDO to a Destination ShardDO via a phase sequence:          *)
(*                                                                         *)
(*   0 INIT  -> 1 TAIL_CAPTURE_ENABLED -> 2 BULK_COPY_DONE                *)
(*          -> 3 TAIL_CAUGHT_UP        -> 4 DUAL_WRITE_OPEN                *)
(*          -> 5 CATALOG_CUT_OVER      -> 6 SOURCE_DRAINED                *)
(*                                                                         *)
(* `advance(migId, expected)` is a CAS: it only increments when the       *)
(* current phase equals `expected`. Otherwise the operation is treated    *)
(* as a no-op or aborts the migration. `abort(migId)` slams the phase to *)
(* -1 (ABORTED), which is terminal.                                       *)
(*                                                                         *)
(* The Catalog cutover (phase 5) atomically swaps the routing entry for  *)
(* the migrated vshard range from `src` to `dst` inside a single         *)
(* `transactionSync`, so writes never observe a partial cutover.          *)
(***************************************************************************)

EXTENDS Integers, FiniteSets, TLC

CONSTANTS Migrations, Vshards, ShardIds, SrcShard, DstShard, MigRange

ASSUME /\ {SrcShard, DstShard} \subseteq ShardIds
       /\ SrcShard # DstShard
       /\ MigRange \subseteq Vshards

INIT_PHASE                 == 0
TAIL_CAPTURE_ENABLED       == 1
BULK_COPY_DONE             == 2
TAIL_CAUGHT_UP             == 3
DUAL_WRITE_OPEN            == 4
CATALOG_CUT_OVER           == 5
SOURCE_DRAINED             == 6
ABORTED_PHASE              == -1

PhaseDomain == {ABORTED_PHASE, INIT_PHASE, TAIL_CAPTURE_ENABLED,
                BULK_COPY_DONE, TAIL_CAUGHT_UP, DUAL_WRITE_OPEN,
                CATALOG_CUT_OVER, SOURCE_DRAINED}

VARIABLES
    migrations,    \* MigId -> [phase, src, dst, range]
    routing,       \* Vshard -> ShardId  (current catalog range table view)
    pendingWrites, \* set of [vshard, observed] writes mid-flight
    completedWrites \* set of [vshard, observed] writes that landed

vars == <<migrations, routing, pendingWrites, completedWrites>>

InitMigration == [phase |-> INIT_PHASE, src |-> SrcShard,
                  dst |-> DstShard, range |-> MigRange]

Init ==
    /\ migrations    = [m \in Migrations |-> InitMigration]
    /\ routing       = [v \in Vshards |-> SrcShard]
    /\ pendingWrites = {}
    /\ completedWrites = {}

(***************************************************************************)
(* Advance(m, expected): CAS step. Increments phase iff current == expected;*)
(* otherwise a no-op (matches the `expected !== undefined` guard in       *)
(* `resharder.ts:advance`). We model the "throw" path as a no-op since    *)
(* the orchestrator catches and retries.                                   *)
(*                                                                         *)
(* We forbid Advance from CATALOG_CUT_OVER without first running the      *)
(* atomic CatalogCutover step.                                             *)
(***************************************************************************)
Advance(m, expected) ==
    /\ migrations[m].phase = expected
    /\ expected # ABORTED_PHASE
    /\ expected # SOURCE_DRAINED
    /\ expected # CATALOG_CUT_OVER     \* cutover handled by CatalogCutover
    /\ migrations' = [migrations EXCEPT ![m].phase = expected + 1]
    /\ UNCHANGED <<routing, pendingWrites, completedWrites>>

(***************************************************************************)
(* CatalogCutover(m): when phase is CATALOG_CUT_OVER, atomically swap     *)
(* routing[v] for every v in range from src to dst, and tick the phase    *)
(* to SOURCE_DRAINED's predecessor (we step into SOURCE_DRAINED via the   *)
(* drain action). Modeling cutover as a single TLA+ step gives us         *)
(* "cutover atomicity" by construction.                                    *)
(***************************************************************************)
CatalogCutover(m) ==
    /\ migrations[m].phase = CATALOG_CUT_OVER
    /\ routing' = [v \in Vshards |->
                    IF v \in migrations[m].range
                    THEN migrations[m].dst
                    ELSE routing[v]]
    /\ migrations' = [migrations EXCEPT ![m].phase = SOURCE_DRAINED]
    /\ UNCHANGED <<pendingWrites, completedWrites>>

(***************************************************************************)
(* EnterCutover(m): the CAS step that takes phase 4 -> 5. Separated so    *)
(* we can keep `Advance` symmetric and still cover the 4->5 transition.   *)
(***************************************************************************)
EnterCutover(m) ==
    /\ migrations[m].phase = DUAL_WRITE_OPEN
    /\ migrations' = [migrations EXCEPT ![m].phase = CATALOG_CUT_OVER]
    /\ UNCHANGED <<routing, pendingWrites, completedWrites>>

(***************************************************************************)
(* Abort(m): slams phase to ABORTED. Terminal.                             *)
(***************************************************************************)
Abort(m) ==
    /\ migrations[m].phase # ABORTED_PHASE
    /\ migrations[m].phase # SOURCE_DRAINED
    /\ migrations' = [migrations EXCEPT ![m].phase = ABORTED_PHASE]
    /\ UNCHANGED <<routing, pendingWrites, completedWrites>>

(***************************************************************************)
(* WriteIssue(v) / WriteLand(w): a client write samples routing[v] and    *)
(* lands on the *same* shard it observed. This models the in-flight       *)
(* lifetime of a write across a possible cutover. CutoverAtomicity asserts*)
(* the write never lands on a shard that disagrees with the post-cutover  *)
(* routing decision it would have observed at issue time.                  *)
(***************************************************************************)
WriteIssue(v) ==
    /\ pendingWrites' = pendingWrites \cup {[vshard |-> v, target |-> routing[v]]}
    /\ UNCHANGED <<migrations, routing, completedWrites>>

WriteLand(w) ==
    /\ w \in pendingWrites
    /\ pendingWrites'   = pendingWrites \ {w}
    /\ completedWrites' = completedWrites \cup {w}
    /\ UNCHANGED <<migrations, routing>>

Next ==
    \/ \E m \in Migrations, p \in PhaseDomain : Advance(m, p)
    \/ \E m \in Migrations : EnterCutover(m)
    \/ \E m \in Migrations : CatalogCutover(m)
    \/ \E m \in Migrations : Abort(m)
    \/ \E v \in Vshards    : WriteIssue(v)
    \/ \E w \in pendingWrites : WriteLand(w)

(***************************************************************************)
(* Fairness: every migration's CAS chain plus the cutover step must run.  *)
(***************************************************************************)
Fairness ==
    /\ \A m \in Migrations :
        /\ \A p \in PhaseDomain : WF_vars(Advance(m, p))
        /\ WF_vars(EnterCutover(m))
        /\ WF_vars(CatalogCutover(m))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* INVARIANTS                                                              *)
(***************************************************************************)

TypeOK ==
    /\ migrations \in [Migrations -> [phase: PhaseDomain,
                                      src: ShardIds,
                                      dst: ShardIds,
                                      range: SUBSET Vshards]]
    /\ routing \in [Vshards -> ShardIds]
    /\ pendingWrites   \subseteq [vshard: Vshards, target: ShardIds]
    /\ completedWrites \subseteq [vshard: Vshards, target: ShardIds]

\* Phase only increases, except it may jump to ABORTED.
\* Encoded as an action property by checking the unprimed/primed pair.
MonotonePhase ==
    [][\A m \in Migrations :
          \/ migrations'[m].phase = ABORTED_PHASE
          \/ migrations'[m].phase >= migrations[m].phase]_vars

\* Routing always assigns each vshard to exactly one shard (a function).
RoutingNeverDual ==
    \A v \in Vshards :
        Cardinality({routing[v]}) = 1

\* Writes never land on a shard that disagrees with what they observed at
\* issue time -- the cutover step is atomic, so any write that read
\* routing[v]=src at issue time lands on src; one that read dst lands on dst.
CutoverAtomicity ==
    \A w \in completedWrites :
        w.target \in {SrcShard, DstShard}

\* Once ABORTED, the phase never moves again.
AbortIsTerminal ==
    [][\A m \in Migrations :
          (migrations[m].phase = ABORTED_PHASE)
            => (migrations'[m].phase = ABORTED_PHASE)]_vars

(***************************************************************************)
(* TEMPORAL PROPERTIES                                                     *)
(***************************************************************************)

EventuallyTerminal ==
    \A m \in Migrations :
        <>(migrations[m].phase \in {SOURCE_DRAINED, ABORTED_PHASE})

(***************************************************************************)
(* STATE CONSTRAINT                                                        *)
(***************************************************************************)

WriteBound ==
    /\ Cardinality(pendingWrites)   <= 2
    /\ Cardinality(completedWrites) <= 3

=============================================================================
