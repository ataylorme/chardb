# Next scope

This is the decision queue after the preview candidate, not a promise that every internal capability will ship. The current release work stays in [PLAN.md](PLAN.md).

## First after preview

### Recovery before more scale claims

Backup and restore are absent. The first useful recovery slice is an operator-authenticated export with bounded progress, checksums, immutable object identity, restore into a separate deployment, and a full readback comparison. Do not call lower-level bookmarks or barrier rows PITR.

Regional failover, replicas, and point-in-time restore remain later work. They need a real recovery-time and data-loss contract, not a collection of internal tables.

### Repeated deployed measurements

One successful deployed run proves a protocol instance. It does not describe variance. Repeat the exact packed candidate and immutable workload on named runners and regions. Retain raw samples, failures, cleanup receipts, and environment identity. Set a regression budget only after the distribution is visible.

The next cost step is an isolated deployed workload followed by Cloudflare analytics for Worker requests and CPU, Durable Object requests, duration and SQLite storage, R2 operations and storage, and Vectorize dimensions. Include alarms and asynchronous settlement. [COST.md](COST.md) defines the current boundary. Do not build a calculator or infer billable compute from latency before those counters exist.

## Product extensions

### Files

Keep the current public file contract small: one organization-owned opaque file value, immutable R2 object keys, transactional row attachment, policy-aware download, replacement, deletion, quota, and bounded cleanup.

Possible additions need separate contracts:

- multipart upload with resumable ownership and quota accounting;
- direct upload without exposing reusable object authority;
- explicit retention or legal-hold policy;
- supported file-column migration and bucket movement;
- public delivery URLs with revocation semantics.

Do not add these by widening the existing locator or returning R2 keys.

### Vectors

Keep the current public vector contract small: one organization-owned descriptor, transaction-bound set and delete, search through the registered query path, current-head and row-policy filtering, and eventual external delivery.

After the deployed gate passes, useful work is:

- repeat real-Vectorize availability and latency measurements;
- improve scheduler and snapshot queries only when profiles identify the cost;
- add continuation only if Vectorize exposes a cursor that preserves the authority and isolation contract;
- define manual recovery for `failed_unproven` without treating absence as deletion proof;
- test resource rotation and dimension or metric migration through a new descriptor version.

Raw index access, public physical IDs, scatter search, and a second vector client remain out.

### Range movement

The implementation can move rows, file metadata, vector state, and organization tombstones through one bounded topology protocol. Productizing it requires a clear answer about who operates it.

Choose one:

- keep it an explicitly experimental operator command with no compatibility promise; or
- make it public, version the controller contract, add progress and failure UX, prove repeated and larger deployed moves, and document capacity planning.

Automatic balancing comes later. It needs admission policy, load signals, oscillation control, maintenance windows, and recovery that an operator can understand.

### User-only tenancy

`forOrgUser()` supports user-owned rows inside an organization. A separate user-only tenancy mode still needs a real application case, Better Auth subject lifecycle, deletion semantics, migration rules, placement, direct-select behavior, generated code, and a browser proof. Organization tenancy remains the default.

### Global data

A global table needs a concrete consistency and authorization contract. Colocated partition experiments are not enough. Replication, database-wide transactions, and scatter queries remain out of scope.

## Still closed

Do not expose these from the package without a separate design and proof track:

- presence and streams;
- schedules and cron APIs;
- cross-partition transactions;
- plugin-defined placement;
- raw Durable Object or RPC types;
- runtime policy configuration;
- backup, restore, PITR, replicas, or failover before their recovery contracts exist.

## Admission rule

A proposed public feature needs:

1. one application problem stated without reference to internal code;
2. a small API and explicit failure contract;
3. placement, authorization, transaction, resource, migration, and cleanup rules;
4. one clean-tarball generated or browser proof;
5. Workerd failure and reconstruction tests;
6. a deployed proof when Cloudflare service behavior matters;
7. a maintenance owner and documentation budget.

If it cannot meet that bar, keep it in research code or remove it.
