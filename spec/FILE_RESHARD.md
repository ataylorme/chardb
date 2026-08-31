# File metadata range movement

Status: implemented as an internal, operator-driven protocol. Local Workerd and packaged Better Auth browser proofs cover the protocol. A prior deployed component run covered file metadata with stable R2 identity. The combined row, file, and vector driver now exists locally, but no admitted deployed combined result exists.

## Scope and ownership model

File movement transfers SQLite metadata ownership. It does not move R2 bytes.

- R2 keys are `v1/{organizationId}/{fileId}` and contain no Cdb or physical-shard identity.
- Application rows store only `FileId`.
- `_chardb_files` owns the organization, table, column, row, size, hash, object key, lifecycle state, and derived vshard placement.
- `_chardb_deleted_organizations` permanently fences a deleted organization ID on its current owner.
- Better Auth organization deletion is routed through Catalog to the one current Cdb owner.
- Attachment, replacement, and row deletion update file metadata in the owning row transaction.

One organization maps to one vshard. Its pending, ready, attached, deleting, and tombstone records therefore move together. The shared R2 bucket remains stable while Catalog changes the metadata owner.

## Implemented metadata invariants

Both ownership tables persist `placement_vshard` with an index ordered by placement and record ID. New writes derive it with `vshardOf([organizationId])`; callers cannot supply it.

Preparation performs bounded placement backfill and then an exact bounded scan. It recomputes each placement from the organization ID and rejects null, malformed, or mismatched values. Resharding never trusts the index value alone.

The Cdb-local transfer tables are:

```sql
CREATE TABLE IF NOT EXISTS _chardb_split_file_cursor (
  mig_id               TEXT PRIMARY KEY,
  range_lo             INTEGER NOT NULL CHECK (range_lo >= 0 AND range_lo < 16384),
  range_hi             INTEGER NOT NULL CHECK (range_hi >= range_lo AND range_hi < 16384),
  role                 TEXT NOT NULL CHECK (role IN ('source', 'dest')),
  outcome              TEXT NOT NULL DEFAULT 'active'
                       CHECK (outcome IN ('active', 'aborted', 'finished')),
  maintenance_enabled  INTEGER NOT NULL CHECK (maintenance_enabled IN (0, 1)),
  attachments_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (attachments_enabled IN (0, 1)),
  source_fenced        INTEGER NOT NULL DEFAULT 0 CHECK (source_fenced IN (0, 1)),
  updated_at           INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE IF NOT EXISTS _chardb_split_file_applied (
  mig_id               TEXT NOT NULL,
  record_kind          TEXT NOT NULL
                       CHECK (record_kind IN ('file', 'organization_tombstone')),
  record_id            TEXT NOT NULL,
  inserted             INTEGER NOT NULL CHECK (inserted IN (0, 1)),
  snapshot_through_lsn INTEGER
                       CHECK (snapshot_through_lsn IS NULL OR snapshot_through_lsn >= 0),
  PRIMARY KEY (mig_id, record_kind, record_id)
);

CREATE TABLE IF NOT EXISTS _chardb_split_capture_tx (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_id   INTEGER NOT NULL CHECK (next_id >= 0),
  active_id INTEGER CHECK (active_id IS NULL OR active_id < 0),
  active_vshard INTEGER
                CHECK (active_vshard IS NULL OR (active_vshard >= 0 AND active_vshard < 16384)),
  CHECK ((active_id IS NULL) = (active_vshard IS NULL))
);
```

The Resharder owns a separate durable file cursor for preparation, tombstone copy, snapshot copy, parity, drain, abort, and finish progress. That cursor is initialized during Resharder bootstrap before recovery inspects active migrations.

The destination is fresh and closed. It rejects a file or tombstone row that predates the migration, even if the row is byte-identical. `maintenance_enabled = 0` prevents expiry and R2 cleanup before cutover, and file admission rejects the destination until activation.

## Ordered capture

File changes share `_chardb_split_log` with application-row changes.

Migration-scoped triggers capture:

- `_chardb_files` insert, update, and delete;
- `_chardb_deleted_organizations` insert.

Every image contains the exact metadata columns, including `placement_vshard`. The trigger selects the one active source split for the placement, rejects overlapping ownership, requires one transaction identity, charges the shared row, byte, and transaction limits, and appends in the same SQLite transaction as the metadata change.

Mutation-backed file changes use the pending mutation transaction identity. Reserve, ready, expiry, R2 delete completion, and organization fencing use a negative external transaction identity. Every file change committed by one SQLite transaction shares that identity. Positive mutation and negative file-only transactions retain one source LSN order at the destination.

Destination replay accepts only `_chardb_files` and `_chardb_deleted_organizations` as system-tail names. Unknown system tables, unknown application tables, incomplete images, invalid lifecycle states, unstable object keys, and out-of-range placement fail before the durable apply cursor advances.

## Snapshot and tail reconciliation

File snapshot pages use an explicit source tail coordinate. The source reads a bounded metadata page and its tail high-watermark in one synchronous SQLite transaction. The returned `throughLsn` is:

```text
max(source _chardb_split_state.acked_lsn,
    max retained _chardb_split_log.lsn for this migration)
```

`acked_lsn` is the durable high-water coordinate after acknowledged tail rows have been pruned. `_chardb_split_log.lsn` is AUTOINCREMENT, so a later capture remains above that coordinate after prune-to-empty and cold reconstruction.

The destination records `snapshot_through_lsn` for every snapshot-owned file or tombstone. Tail application follows these rules:

1. A differing insert, update, or delete may be skipped only when the exact migration ledger owns the record and `entry.lsn <= snapshot_through_lsn`.
2. A covered skip still requires the destination snapshot row to exist. A missing ledger-owned row is corruption.
3. An existing row without this migration's ledger is a collision, including an exact same-ID row.
4. A tail-only file or tombstone insert records `inserted = 1` with tail provenance so abort owns its cleanup.
5. If a pre-capture file was updated and then disappeared before its snapshot page, an update with no destination row reconstructs its exact validated pre-image, records migration provenance, and applies the transition atomically. A following captured delete removes it.
6. A lone delete of an already-absent, pre-capture deleting row is an idempotent no-op.

Snapshot response-loss retry is also bounded by the watermark. The same watermark requires a byte-exact file image. A higher watermark may replace a migration-owned file snapshot with the newer exact source image. Tombstones are append-only and remain exact. A lower watermark is rejected.

Legacy ledger rows without `snapshot_through_lsn` never authorize a covered-entry skip. They fail closed instead of guessing capture order.

## File routing and maintenance fences

Reserve, ready, and download carry the physical route identity:

```ts
interface FileRouteIdentity {
    readonly schemaEpoch: number;
    readonly vshard: number;
    readonly domainSchemaEpoch: number;
}
```

Cdb verifies the derived vshard, active domain schema, routing generation, and active file owner. Reserve, ready, organization deletion, and maintenance repeat ownership admission inside their SQLite transaction. Download checks admission before policy work and again before returning metadata.

Upload retains the immutable bytes and `FileId`. If the R2 put succeeds but readiness returns `CDB_STALE_EPOCH`, the HTTP path resolves fresh Catalog authority and placement and retries the whole immutable upload exactly once. A second movement fails closed.

Maintenance filters fenced vshards in SQL before `LIMIT` or `MIN`, preventing unrelated fenced rows from starving owned work. A source file fence disables new expiry, tombstone queuing, and R2-delete selection for the moving range. Work committed before the fence is ordered in the shared tail.

Catalog uses a range-scoped organization-deletion barrier. Resharder opens it after source capture is installed, waits until older in-range deletion outbox rows have completed, then performs the final tail convergence. A new in-range Better Auth deletion fails with `CDB_STALE_EPOCH` and rolls its auth mutation and outboxes back. Catalog cutover releases the barrier in the same routing transaction; abort releases it without changing routing.

Organization deletion targets only the current Catalog owner. Before cutover the source commits and captures the tombstone. After cutover a later deletion targets the destination. It does not fan out across physical shards or send an early tombstone to the closed destination.

## Implemented phase order

The Resharder persists and resumes this order:

1. Bind the exact topology, schema, range, stable table list, and resource descriptors.
2. Finish bounded source placement backfill and exact placement validation.
3. Persist closed destination ownership and provision the fresh destination schema.
4. Establish destination file ownership and uninstall exact schema-derived attachment triggers before relational destination admission.
5. Begin relational destination state.
6. Begin source relational capture. The source admits only the exact schema-derived packaged attachment trigger names; every other application trigger still fails closed.
7. Begin source file capture.
8. Copy organization tombstones, then all file lifecycle states, in bounded `(placement_vshard, id)` order with a `throughLsn` on every page.
9. Copy application tables parent first, with destination attachment triggers still disabled.
10. Replay the shared row, file, tombstone, and mutation-outcome tails in source transaction and LSN order.
11. Prepare and activate the durable source routing fence and file-maintenance fence.
12. Open the Catalog organization-deletion barrier and wait for older deletion delivery.
13. Reconverge the shared tail and mutation outcomes.
14. Compare exact source and destination file and tombstone pages in both directions. Missing, changed, and extra destination metadata all stop cutover.
15. Reinstall destination attachment triggers while destination file ownership remains closed.
16. Commit Catalog cutover and barrier release.
17. Activate destination file ownership and relational serving for the exact new generation.
18. Stop source capture and uninstall source attachment triggers.
19. Drain application rows child first.
20. Drain source file metadata and tombstones with direct bounded SQL. This path never calls R2.
21. Finish source and destination transfer state and retain the terminal ownership tombstones needed to reject delayed RPCs.

Every phase is idempotent under exact retry. A post-cutover crash may produce a short retryable outage while destination activation reconstructs; it cannot restore source ownership.

## Lifecycle behavior

`pending`

- Copies the original reservation and timestamps without refreshing its lease.
- Cannot expire on the destination before cutover.
- A stale source ready fails; the same-FileId retry can finish the copied destination reservation.

`ready`

- Copies the exact hash, size, locator, and timestamps.
- Remains attachable after cutover.
- Exact response-loss retry is idempotent.

`attached`

- Metadata is copied while destination attachment triggers are disabled.
- Application rows are reconstructed separately by the relational mover.
- Source attachment triggers are removed before row drain, so drain cannot enqueue live objects for deletion.

`deleting`

- Moves even when no application row references it.
- Destination assumes cleanup ownership only after cutover.
- Source drain removes metadata only and never repeats the object delete.

Organization tombstone

- Moves before file snapshot admission.
- Rejects destination reserve, ready, attach, and download.
- Preserves the existing cleanup semantics after destination activation.

## Abort

Abort is pre-cutover only and starts on the source.

1. Persist the abort outcome and fence delayed apply.
2. Uninstall source file capture and release the Catalog deletion barrier.
3. Restore source file admission, maintenance, and attachment ownership.
4. Keep destination maintenance and serving disabled.
5. Remove copied domain rows child first.
6. Walk `_chardb_split_file_applied` in bounded order. Delete every migration-inserted file or tombstone row; an already-absent inserted row is an idempotent cleanup result.
7. Remove destination transfer ledgers and retain aborted ownership tombstones so delayed begin, snapshot, tail, and activation RPCs fail.

Snapshot-created rows, tail-only inserts, tombstones, and rows synthesized from a captured update all have abort provenance. Fresh-destination admission rejects preexisting system rows, so abort never needs to restore an unrelated prior image. Abort does not call R2; the source remains the object owner.

## Internal RPC surface

The protocol uses bounded internal RPCs, including:

- `prepareReshardFileSource(identity, cursor)` for placement backfill and exact validation;
- `beginReshardFileSource(identity)` and `beginReshardFileDest(identity)`;
- `readReshardFileSnapshot(...) -> { rows, cursor, done, throughLsn }`;
- `applyReshardFileSnapshot({ identity, rows, throughLsn })`;
- `readReshardFileTombstones(...) -> { rows, cursor, done, throughLsn }`;
- `applyReshardFileTombstones({ identity, rows, throughLsn })`;
- the existing shared `readTail` and `applyTail` transaction protocol;
- `fenceReshardFileSource(identity)`;
- `readReshardFileParityPage(identity, role, cursor)`;
- `prepareReshardFileDestAttachments(identity)` and `activateReshardFileDest(identity)`;
- `stopReshardFileSource(identity)`;
- `drainReshardFiles(identity, cursor)`;
- `abortReshardFiles(identity, cursor)`;
- `finishReshardFiles(identity, role)`.

Pages remain fixed at 500 rows, with the shared 1 MiB envelope and 256 KiB encoded-row limit. Callers cannot select a larger page or bypass the shared tail ordering.

These methods are private movement contracts. They do not add another public file API or tenancy model.

## Proof obligations

The native fixtures use production Catalog, Resharder, and Cdb Durable Objects under Miniflare and Workerd. They cover phase reconstruction, response-loss replay, parity rejection, abort ownership, stale-source fencing, current-owner deletion, attachment retry, exact capacity limits, and source drain without R2 cleanup. A serialized-move fixture also proves that a second topology change waits for the active global lease. Concurrent topology changes are not supported.

Local fixtures instrument R2 calls. Movement-only slices must record zero `put` and zero `delete` calls. Logical deletion must name the exact current-owner keys. A stable ETag or upload timestamp is useful corroboration, but it is not a provider call trace.

The packaged Better Auth browser proof covers sign-in, organization creation and switching, upload, transactional attach, live replacement, range movement, Wrangler restart, exact-byte download, and organization deletion with survivor isolation. It is a correctness proof, not a performance claim.

The combined deployment driver uses one versioned workload for ordinary rows, file ownership, and vector state. Its report validator requires:

1. one exact packed candidate and one workload identity across local and Cloudflare samples;
2. one committed response lost after snapshot apply, followed by retry with the same run key;
3. Catalog cutover by exactly one route epoch, destination service, stale-source rejection, and source drain;
4. unchanged R2 object count, bytes, identity digest, and exact download bytes through movement;
5. unchanged vector heads, ready heads, outbox rows, attempt rows, physical IDs, and identity digests;
6. a successful public vector search from the destination owner;
7. organization deletion and alarm cleanup from the current owner;
8. checksummed reports, secret scanning, and teardown receipts proving the disposable Worker, R2 bucket, and Vectorize index absent.

The local target must instrument and prove zero R2 and vector-provider mutations during movement. Cloudflare's native R2 and Vectorize bindings do not expose provider call counts. A deployed report must mark those counts unobservable and prove stable identity and readback instead. It must not infer zero calls.

An older deployed component run proved file-only response-loss recovery, cutover, stable R2 identity, readback, and cleanup. It does not satisfy the combined row, file, and vector release gate. The combined driver and validators now exist locally, but a deployed pass against the final candidate remains open.

`bun run release:admit` accepts this evidence only through the `cloudflare-file-reshard` slot. It requires a passing `chardb.file-vector-reshard-deployment-pair.v2` report, checksum manifests, matching tarball identity, and complete cleanup. Proof code without an admitted report makes no release claim.
