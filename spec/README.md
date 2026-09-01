# chardb TLA+ specs

This TLA+ specification models the online resharding phase machine so it can be
exhaustively checked with TLC.

| Spec | Models | Source it mirrors |
| --- | --- | --- |
| `Resharder.tla` | Online resharding phase machine | [`src/server/do/resharder.ts`](../src/server/do/resharder.ts) |

## Installing TLA+

The specs are checked with the standard TLC model checker shipped in the
TLA+ tools.

1. Grab the latest `tla2tools.jar` from the official release page:
   <https://github.com/tlaplus/tlaplus/releases>
2. Drop it somewhere on your machine (e.g. `~/bin/tla2tools.jar`).
3. Make sure you have a JDK 11+ on `PATH` (`java -version`).

The graphical TLA+ Toolbox is also fine if you prefer it; just open the
`.tla` files and load the matching `.cfg` as the model. See
<https://github.com/tlaplus/tlaplus> for an overview.

## Running TLC

From the repo root:

```bash
java -jar /path/to/tla2tools.jar -workers auto -config spec/Resharder.cfg spec/Resharder.tla
```

The model uses one migration over two vshards and two shards, so it finishes in
a few seconds on a laptop.

## What the specs prove

### `Resharder.tla`

The Resharder DO orchestrates online vshard-range moves through a
seven-phase machine (`INIT … SOURCE_DRAINED`) plus an `ABORTED` terminal
phase. Phase advancement is a CAS: `advance(migId, expected)` only
increments when the persisted phase equals `expected`. The Catalog cutover
(phase 5) is performed in a single `transactionSync` so writes never
observe a partial routing swap.

The spec checks:

- **`MonotonePhase`** (action property) — the persisted phase only ever
  increases or jumps to `ABORTED`. Catches any bug where a stale CAS
  retries could roll the phase backwards.
- **`RoutingNeverDual`** — every vshard maps to exactly one ShardId at
  every instant; no transient state where a vshard is "owned by both".
- **`CutoverAtomicity`** — by modeling `CatalogCutover` as a single TLA+
  step, every completed write lands on the shard that the *atomic*
  routing snapshot it observed at issue time selected. Surfaces designs
  where a write could be split across the routing change.
- **`AbortIsTerminal`** (action property) — once a migration is
  `ABORTED`, no further `Advance` step can move its phase. Encodes the
  contract that abort is irrevocable (the orchestrator must mint a new
  `migId` to retry).
- **`EventuallyTerminal`** (liveness) — under fair scheduling every
  migration eventually reaches `SOURCE_DRAINED` or `ABORTED`, ruling
  out designs where a migration could be stuck mid-phase forever.

## Notes on model bounds

- `Resharder.cfg` bounds the number of in-flight and completed writes
  via the `WriteBound` constraint, also for finiteness.
- The bounds can be raised in the cfg if you want a deeper search at
  the cost of a longer TLC run.
