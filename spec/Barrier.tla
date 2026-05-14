------------------------------- MODULE Barrier -------------------------------
(***************************************************************************)
(* Models the chardb distributed PITR barrier protocol.                    *)
(*                                                                         *)
(* See:                                                                    *)
(*   src/server/do/catalog.ts   - openBarrier / ackBarrier / openBarriers  *)
(*   src/server/do/cdb.ts       - barrierBookmark                          *)
(*   src/server/entrypoint.ts   - runBarrierTick                           *)
(*                                                                         *)
(* The Catalog DO holds a `catalog_barrier` row per barrier. Each shard,   *)
(* on observing a barrier, snapshots its current `_chardb_op_log` MAX     *)
(* rowid and acks the barrier. When every expected shard has acked, the   *)
(* (barrierId -> bookmarks) map is the durable PITR snapshot coordinate.   *)
(***************************************************************************)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS Shards, BarrierIds

ASSUME /\ Shards \subseteq STRING
       /\ BarrierIds \subseteq STRING

\* Sentinel used in `bookmarks` to mean "this shard has not yet acked".
NoBookmark == -1

VARIABLES
    barriers,    \* BarrierId -> [expectedShards, ackShards, bookmarks, opened]
    shardOps,    \* ShardId  -> Seq(Nat)  (op-log row ids in append order)
    completed,   \* set of BarrierId observed complete
    frozen       \* BarrierId -> [ShardId -> Int]  bookmarks at completion time

vars == <<barriers, shardOps, completed, frozen>>

EmptyBookmarks == [s \in Shards |-> NoBookmark]

NoBarrier == [expectedShards |-> {}, ackShards |-> {},
              bookmarks |-> EmptyBookmarks, opened |-> FALSE]

Init ==
    /\ barriers = [b \in BarrierIds |-> NoBarrier]
    /\ shardOps = [s \in Shards |-> << >>]
    /\ completed = {}
    /\ frozen   = [b \in BarrierIds |-> EmptyBookmarks]

(***************************************************************************)
(* OpenBarrier(b): record a fresh barrier whose expected set is the        *)
(* current cluster shard set. Splits/range-table evolution are out of      *)
(* scope of this spec.                                                     *)
(***************************************************************************)
OpenBarrier(b) ==
    /\ ~ barriers[b].opened
    /\ barriers' = [barriers EXCEPT ![b] =
            [expectedShards |-> Shards, ackShards |-> {},
             bookmarks |-> EmptyBookmarks, opened |-> TRUE]]
    /\ UNCHANGED <<shardOps, completed, frozen>>

(***************************************************************************)
(* ShardWrite(s): append a new op-log row id to shard s.                   *)
(***************************************************************************)
ShardWrite(s) ==
    /\ shardOps' = [shardOps EXCEPT ![s] = Append(@, Len(@) + 1)]
    /\ UNCHANGED <<barriers, completed, frozen>>

(***************************************************************************)
(* AckBarrier(b, s): shard s snapshots its current op-log length and acks. *)
(* Mirrors `cdb.ts` barrierBookmark + `catalog.ts` ackBarrier.             *)
(***************************************************************************)
AckBarrier(b, s) ==
    /\ barriers[b].opened
    /\ s \in barriers[b].expectedShards
    /\ s \notin barriers[b].ackShards
    /\ barriers' =
        [barriers EXCEPT ![b] =
            [@ EXCEPT !.ackShards = @ \cup {s},
                      !.bookmarks = [@ EXCEPT ![s] = Len(shardOps[s])]]]
    /\ UNCHANGED <<shardOps, completed, frozen>>

(***************************************************************************)
(* CompleteBarrier(b): when ackShards == expectedShards, the barrier is    *)
(* observed complete. Freeze its bookmarks so we can later assert shard    *)
(* writes do not mutate them.                                              *)
(***************************************************************************)
CompleteBarrier(b) ==
    /\ barriers[b].opened
    /\ b \notin completed
    /\ barriers[b].ackShards = barriers[b].expectedShards
    /\ completed' = completed \cup {b}
    /\ frozen'    = [frozen EXCEPT ![b] = barriers[b].bookmarks]
    /\ UNCHANGED <<barriers, shardOps>>

Next ==
    \/ \E b \in BarrierIds : OpenBarrier(b)
    \/ \E s \in Shards     : ShardWrite(s)
    \/ \E b \in BarrierIds, s \in Shards : AckBarrier(b, s)
    \/ \E b \in BarrierIds : CompleteBarrier(b)

Fairness ==
    /\ \A b \in BarrierIds : WF_vars(OpenBarrier(b))
    /\ \A b \in BarrierIds, s \in Shards : WF_vars(AckBarrier(b, s))
    /\ \A b \in BarrierIds : WF_vars(CompleteBarrier(b))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* INVARIANTS                                                              *)
(***************************************************************************)

TypeOK ==
    /\ barriers \in [BarrierIds ->
            [expectedShards: SUBSET Shards,
             ackShards: SUBSET Shards,
             bookmarks: [Shards -> Int],
             opened: BOOLEAN]]
    /\ shardOps \in [Shards -> Seq(Nat)]
    /\ completed \subseteq BarrierIds
    /\ frozen \in [BarrierIds -> [Shards -> Int]]

\* Every bookmark in a complete barrier points at a real op-log entry; the
\* op-log is append-only so the bookmark recorded at ack time is still <=
\* the current op-log length.
BarrierMonotone ==
    \A b \in completed :
        \A s \in barriers[b].expectedShards :
            /\ barriers[b].bookmarks[s] # NoBookmark
            /\ barriers[b].bookmarks[s] <= Len(shardOps[s])

\* A complete barrier has no missing acks.
NoMissingAcks ==
    \A b \in completed : barriers[b].ackShards = barriers[b].expectedShards

\* Once a barrier is complete, future shard writes do NOT mutate its
\* recorded bookmarks (the snapshot coordinate is stable).
BookmarkSurvivesWrites ==
    \A b \in completed :
        \A s \in barriers[b].expectedShards :
            barriers[b].bookmarks[s] = frozen[b][s]

(***************************************************************************)
(* TEMPORAL PROPERTIES                                                     *)
(***************************************************************************)

EventuallyComplete ==
    \A b \in BarrierIds :
        (barriers[b].opened) ~> (b \in completed)

(***************************************************************************)
(* STATE CONSTRAINT (keeps TLC's search finite).                           *)
(***************************************************************************)

OpLogBound == \A s \in Shards : Len(shardOps[s]) <= 3

=============================================================================
