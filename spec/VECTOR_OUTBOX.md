# Vector ownership and range movement

Status: public experimental organization slice. Local browser, Workerd, movement, and benchmark proofs pass. The expanded disposable Vectorize proof exists, but its live, adversarial-candidate, and bounded-unproven cases do not yet have admitted Cloudflare evidence from the release candidate.

## Public contract

The public `vector()` custom type emits an organization-scoped `VectorResourceV1` descriptor. Dimension, metric, binding, table, column, scalar primary key, and organization column join the migration digest, and Wrangler TOML or JSONC binding checks validate the descriptor's required binding. TOML is the primary generated format. The runtime derives one canonical resource ID from that descriptor.

`ctx.vector.set()` and `ctx.vector.delete()` stage the domain pointer, authoritative vector head, and durable outbox in one SQLite transaction. Generated guards reject unstaged pointers, early deletes, and primary-key or organization moves. The alarm runtime resolves only configured own-data Vectorize bindings, uses versioned physical IDs, persists attempts before delivery, retries response loss, and cleans exact superseded or deleted versions after the settlement bound. `searchVector()` runs through the existing `api.query()` and `useQuery()` path. It refreshes Better Auth authority through Catalog before and after the external query and validates every candidate against the current SQLite head plus row and column policy. Exact-resource live dependencies join the existing durable invalidation path only after delivery settles.

Vectorize is external and eventually consistent. Chardb routes vector state through the owning organization's virtual shard, then invalidates the existing live-query subscription only after delivery settles. Search can return fewer than `limit`: Chardb asks for at most 16 extra candidates, removes stale or policy-hidden results, and has no continuation cursor.

`inlineVector()` stores a BLOB and remains rejected by the generic reshard preflight. That is the correct behavior until inline search has its own bounded query contract.

## Resource identity

A Vectorize-backed column needs a normalized migration resource:

```ts
interface VectorResourceV1 {
    readonly kind: "vector";
    readonly version: 1;
    readonly table: string;
    readonly column: string;
    readonly primaryKey: string;
    readonly organizationColumn: string;
    readonly binding: string;
    readonly dimensions: number;
    readonly metric: "cosine" | "euclidean" | "dot-product";
}
```

The resource participates in the migration digest. Wrangler doctor validates the binding in TOML and JSONC. A changed dimension, metric, binding, ownership column, or primary key requires an explicit migration and fails boot if the packaged journal disagrees.

The first release stays organization-scoped with one scalar row key. User, global, composite-key, and cross-organization vector search remain unsupported.

## SQLite is authoritative

The application row stores a branded logical `VectorId`. Cdb owns the embedding and delivery state:

```sql
CREATE TABLE IF NOT EXISTS _chardb_vectors (
  vector_id          TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL,
  placement_vshard   INTEGER NOT NULL CHECK (placement_vshard BETWEEN 0 AND 16383),
  resource_id        TEXT NOT NULL,
  row_pk             TEXT NOT NULL,
  dimensions         INTEGER NOT NULL CHECK (dimensions > 0 AND dimensions <= 4096),
  version            INTEGER NOT NULL CHECK (version > 0),
  delivered_version  INTEGER NOT NULL DEFAULT 0 CHECK (delivered_version >= 0),
  values_enc         BLOB,
  metadata_json      TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'deleting')),
  updated_at         INTEGER NOT NULL,
  UNIQUE (resource_id, organization_id, row_pk)
);

CREATE TABLE IF NOT EXISTS _chardb_vector_outbox (
  vector_id       TEXT PRIMARY KEY,
  target_version  INTEGER NOT NULL CHECK (target_version > 0),
  operation       TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  attempts        INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  leased_until    INTEGER,
  last_error      TEXT
);

CREATE TABLE IF NOT EXISTS _chardb_vector_attempts (
  vector_id        TEXT NOT NULL,
  physical_version INTEGER NOT NULL CHECK (physical_version > 0),
  first_sent_at    INTEGER NOT NULL,
  settle_after     INTEGER NOT NULL,
  delete_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (delete_confirmed IN (0, 1)),
  PRIMARY KEY (vector_id, physical_version)
);
```

The mutation that changes the domain column also writes `_chardb_vectors` and coalesces its outbox row in the same SQLite transaction. The caller never supplies `organization_id`, `placement_vshard`, resource identity, or version. Cdb derives them from the authorized mutation and increments the durable version.

`ctx.vector.set()` returns a `VectorId`, but only stages SQLite state. It does not call Vectorize from inside the domain transaction.

## Reordering defense

Idempotent upsert is not enough. A delayed source upsert can arrive after a newer destination update and replace it.

Each logical vector version therefore uses a distinct physical Vectorize document ID:

```text
v1/{resourceId}/{vectorId}/{version}
```

Delivery never overwrites a different version. After a new version is accepted, the same durable outbox row enters superseded-cleanup mode and deletes only attempted physical versions below the accepted head version. The current attempt remains in the ledger for a later logical delete. A late duplicate can recreate only its old versioned ID, never overwrite the current version.

Every search result is provisional. Cdb validates the returned logical ID and version against `_chardb_vectors`, checks organization and row policy, and returns only the current `ready` head. Queries overfetch by a fixed 16 candidates, within Vectorize's 100-result cap, to compensate for stale candidates. If validation cannot fill the requested page within that bound, the public path returns a short page. Continuation is not wired yet.

Delete makes the authoritative SQLite head non-queryable and queues physical version cleanup. A late external upsert is invisible because no `ready` head validates it. Cleanup retries the exact versioned IDs.

"Response lost" includes a request that reaches Vectorize after the local caller times out. Deletion cannot forget which physical versions were attempted. The sender records `_chardb_vector_attempts` before each external upsert. A delete retains its non-queryable `deleting` head until every attempted physical version passes a measured settlement deadline and a later delete of that exact ID succeeds. Only then may Cdb remove the head, outbox row, and attempt ledger. This prevents a timed-out old upsert from recreating an untracked document after cleanup.

Superseded cleanup uses the same rule. It waits for each older attempted version's settlement deadline, pages exact physical IDs through the delete adapter, and removes an older attempt ledger row only after that delete is acknowledged. Cleanup response loss repeats the same IDs after lease expiry. If a logical delete replaces cleanup while its remote request is unresolved, the delete outbox retains every attempted version and safely issues the exact deletions again.

The settlement deadline is a configured conservative wait, not a proven platform hard bound and not an SLA. After Vectorize accepts a delete, the runtime will not settle that delete before `acceptedAt + 120_000` milliseconds, even when older attempt deadlines expire sooner. Cleanup pages by `(vector_id, physical_version)`, caps IDs and encoded bytes per Vectorize call, and survives response loss without skipping an attempted version. Visibility-unconfirmed or response-ambiguous deletion consumes one organization-wide budget of 32 unproven turns, then enters typed `failed_unproven` for manual intervention. The conservative production-cap model reaches a terminal state within 147,482 post-acceptance alarm turns. That bound proves finite local behavior, not external deletion.

Vectorize exposes one opaque processed-mutation watermark for a shared index. Chardb accepts only exact equality with the delete mutation as proof and commits that proof to the durable attempt ledger before local settlement. A different watermark has no safe ordering meaning. Chardb treats it as indeterminate, never as proof or ordinary absence. Continuous unrelated traffic can therefore replace the exact watermark before observation and lead to `failed_unproven` even if Vectorize completed the delete.

## Delivery ownership

One Cdb owns delivery for a vshard at a time. Every alarm queue and claim transaction checks:

- the stored organization hashes to `placement_vshard`;
- the domain schema epoch is active;
- the physical routing generation admits the vshard;
- no source delivery fence covers it;
- the outbox lease and target version still match the current vector head.

Each current alarm invocation claims at most one row and records its result in a second SQLite transaction. Response loss repeats the same physical ID and payload. A newer operation cannot deliver until the current version settles or its lease expires. Lease expiry permits another worker to repeat the same operation. It does not prove the earlier remote request failed. Every retry extends the attempt's settlement deadline before sending. Capacity limits cover pending rows, encoded embedding bytes, retries, attempt-ledger rows, and dead letters. A future multi-row turn must keep explicit ID and byte caps.

Ownership filtering prevents a fenced or closed destination vshard from blocking admissible work. Within admitted work, a backward-compatible singleton stores the next vshard turn. Each alarm searches circularly from that cursor, claims the selected vshard's oldest due row, and advances the cursor only after the lease commits. The cursor survives reconstruction, wraps at 16,384, and does not move when every due row is fenced or belongs to a closed destination. This is one turn per due vshard, not weighted throughput fairness.

## Range movement

Vector state uses the existing topology state machine and ordered side-state lane. It does not create another routing or movement protocol.

1. Bind the exact vector resource descriptors on source and destination.
2. Persist and verify placement for every vector head and outbox row.
3. Capture vector metadata and outbox changes in the same ordered transaction stream as domain rows and file metadata.
4. Copy current heads, encoded values, cleanup state, and pending delivery intent. Snapshot membership uses a non-reusable head creation sequence, not SQLite `rowid`; one migration-owned cursor and idempotent page identity prevent phase skipping, watermark changes, and replay drift. External Vectorize records do not move.
5. Keep destination delivery disabled before cutover.
6. Fence source vector writes and alarm claims for the range.
7. Wait for already claimed source work to settle or expire, then replay the final ordered tail. Per-record snapshot provenance distinguishes transitions already reflected by the fuzzy bounded scan from later alarm and mutation changes.
8. Cut over Catalog and enable destination delivery.
9. Drain source SQLite metadata directly. Do not issue Vectorize deletes merely because ownership moved.

Versioned physical IDs make a delayed source request harmless, but the source fence still matters. It bounds duplicate traffic and ensures the destination owns all later versions.

Abort fences destination apply and delivery before taking a cleanup watermark. It removes only metadata inserted by the migration, restores source delivery, and never deletes an external document that the source still owns.

## Query and auth contract

Vector search is organization-native. Catalog resolves Better Auth authority and physical placement in one turn. The query targets one configured resource and one organization filter. Cdb validates every candidate through the same row and column policies used by SQL reads.

An auth revocation invalidates live vector results through the shared scoped auth invalidation path. A vector delivery completion dirties only subscriptions that depend on that vector resource. Neither event creates a second client protocol.

## Proof contract

The local proofs and the deployed proof answer different questions. A local fake index can verify routing, SQLite state, alarm scheduling, and live invalidation, but it cannot prove Vectorize behavior. A prior deployed component run cannot admit a new tarball.

| Proof | State | Claim |
| --- | --- | --- |
| Packed public-vector browser | Implemented | A clean consumer installs the exact tarball, typechecks Better Auth organization vector usage, keeps server code out of the browser graph, and observes pending, ready, refetching, and live replacement states. Its wire peer is local. |
| Local Workerd | Implemented | Real Durable Object actors and SQLite reconstruct across set, replace, delete, search, live invalidation, organization isolation, and movement. The index is a fake Durable Object. |
| Local benchmark | Implemented | Named organization and shard layouts record raw samples and correctness flags. It does not measure Vectorize or Cloudflare network cost. |
| Expanded Cloudflare lifecycle | Driver and validators implemented, release pass open | The disposable proof includes the public packaged SDK, a real Worker WebSocket, direct stale and policy-hidden candidate injection, response loss, settlement limits, paired timing, and cleanup. No release claim exists until that driver passes against the admitted tarball. |

### Deployed requirements

A complete public proof uses one packed candidate and a disposable real Vectorize index. It must cover:

1. exact dimensions, metric, resource digest, organization placement, binding, and required metadata-index validation;
2. Better Auth organization creation and fresh authority checks;
3. public set, replace, delete, search, and a real packaged-SDK WebSocket subscription;
4. upsert and delete response loss without replaying a write-bearing method;
5. replacement and delete with stable physical IDs and immutable acceptance evidence;
6. redeploy to an immutable second Worker version with exact 100 percent traffic and state continuity;
7. direct stale-candidate injection, cross-organization isolation, and policy-hidden candidate rejection against SQLite;
8. the accepted-delete 120-second settlement floor and the 32-turn unproven budget;
9. a named local and deployed benchmark using the same candidate and workload;
10. exact cleanup of every attempted physical version, Worker, and index;
11. secret scanning, report-schema validation, and checksum verification.

The live case must hold a replacement behind the delivery gate, observe no new result while it is pending, release delivery, then observe exactly one new live result. The report records the subscription acknowledgement, reconnect state, and bounded event counts. Duplicate results fail the proof.

The proof passes only when it emits a validated lifecycle report, comparison report, and cleanup receipt for the exact tarball admitted with the other preview evidence. `failed_unproven` is a bounded local terminal state for operator intervention. It never proves that the external record was deleted or absent.
