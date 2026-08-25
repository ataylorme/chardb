# Chardb product destination and next-scope candidates

Last reviewed: 2026-08-25

The narrow organization-tenanted runtime is the current supported path. The one-binding package below is complete for that path. The remaining packages are not implemented and may appear on the landing page only when clearly labeled as the destination or target interface. Pick one package before starting another.

## Product contract

The old landing page remains the product direction:

- one Chardb binding in a Cloudflare Worker;
- one typed query and transaction layer for SQL and live data;
- tenant placement, auth policy, files, and vectors declared in the schema;
- `forOrg()`, `forUser()`, and `globalScope()` behaving as complete public boundaries;
- physical shard splits and moves hidden from application code;
- MIT-licensed code running in the user's Cloudflare account.

Capacity numbers, automatic behavior, and production-readiness claims require measured proof before they become present-tense copy.

## Package completion rule

A package is complete only when its public API, failure contract, resource bounds, and cleanup behavior are implemented and documented. It also needs a configured Workerd end-to-end case, a clean-tarball consumer case where packaging matters, and a frozen benchmark profile when scale or latency is part of the claim. Update `STATUS.md`, the capability matrix, and the landing page in the same change.

## One-binding developer surface: completed 2026-08-25

Same-Worker apps expose one typed `env.DB` handle and resolve Chardb's internal classes through native `ctx.exports`; consumers do not declare the six internal Durable Object bindings. `wrangler.toml` is the scaffold default, and doctor also accepts `wrangler.jsonc`. The handle accepts registered query and mutation functions through `client(env.DB, { jwt, authOrigin })`, converts them to stable refs before RPC, verifies the JWT, re-derives current organization authority in Catalog, and uses the same manifest, migration epoch, policy, and Cdb execution paths as live traffic.

- `chardb init`, local Miniflare, Wrangler deployment, migration, and production share the same exported `DB` entrypoint.
- Explicit stable refs, server-owned query intent, current Catalog authority, policy checks, and migration epochs remain behind the handle.
- The clean-tarball chat proof executes both binding methods, checks idempotent mutation replay and two-client live invalidation, restarts Miniflare over persisted storage, and runs a frozen concurrent binding-query telemetry profile.

Raw Drizzle builders over RPC remain outside this package. Adding them would require a bounded serializable query representation that preserves the same server-owned intent and authorization guarantees.

## Query shapes

Full-row single-table queries are the only supported shape.

- Compile readable-column masks for projections and joins.
- Define dependency and range tracking for each new shape.
- Keep grouping, aggregates, embedded subqueries, callback predicates, and callback ordering blocked until the runtime can verify them.

## Complete tenancy axes

`forOrg()`, `forUser()`, and `globalScope()` exist as schema primitives. Only the organization path has the complete public mutation, query, auth, and live-update proof.

- Give user-scoped tables a public route, authority derivation, policy floor, mutation path, and live-query path.
- Give global tables an explicit placement and transaction contract instead of silently treating them as tenant data.
- Define and reject cross-boundary joins and transactions until a bounded, atomic contract exists.
- Run the same isolation, reconnect, revocation, migration, and reconstruction matrix for every supported axis.

## Auth profile expansion

- Add placement metadata or explicit epoch rules for plugin relationships without conventional `organizationId` or `userId` fields.
- Implement adapter transactions for Better Auth workflows that require several writes, or publish and enforce a smaller plugin and workflow list.

## Files as columns

`file()` and `fileArray()` are experimental Drizzle column types. Their current handles do not provide a supported server runtime.

- Implement upload admission, server-owned object keys, content validation, checksums, finalization, download authorization, deletion, and reference counting.
- Apply tenant, row, and column policy to every file operation.
- Bound proxied, presigned, and multipart state by bytes, rows, age, retries, and cleanup work.
- Prove failed uploads, abandoned multipart sessions, row rollback, deletion races, restart, and cross-tenant access cannot leak data or storage.
- Add a clean-tarball chat attachment flow and a frozen object-lifecycle benchmark before restoring present-tense file claims.

## Vectors in the query layer

`vector()` and `inlineVector()` are experimental column types. They do not have a supported indexing and query path.

- Define transactional semantics for inline vectors and consistency semantics for Vectorize-backed columns.
- Make index identity, dimensions, metadata filters, tenant boundaries, upserts, deletes, and reindexing derive from the schema.
- Specify how vector queries declare dependencies and interact with live-query invalidation.
- Prove restart, delayed indexing, duplicate delivery, deletion, reindexing, and cross-tenant denial end to end.
- Add accuracy, convergence, and resource-bound benchmark profiles before making latency or scale claims.

## Automatic online resharding

Virtual-shard routing and split helpers exist, but there is no automatic production coordinator.

- Add durable split admission, copy, tail, verification, cutover, rollback, retry, and operator-visible progress.
- Keep reads and writes correct through every supported phase, or publish a precise maintenance boundary for the first version.
- Prove source and destination reconstruction, duplicate events, stalled workers, partial cutover, and Catalog failure.
- Run the chat and scale suites through an actual split without changing application code.
- Publish a capacity claim only after measuring a declared storage layout and operational envelope.

## Public retry API

- Expose a public retry handle for terminal errors marked retryable.
- Define which operations retry automatically, their deadline and backoff, and how cancellation interacts with mutation id reuse.
- Prove no duplicate mutation, timer, promise, or subscription state across reconnect and explicit retry.

## Failure recovery beyond the current storage contract

Gateway already commits retirement with its cleanup alarm in one transaction and attempts a separate reconciliation alarm if that transaction fails. If both Durable Object storage transactions fail, no code can durably promise prompt cleanup without another event or an external watchdog.

- Decide whether to add a periodic external reconciliation trigger.
- Inventory remaining Worker RPC failure and shard-eviction cases by named production path.
- Add only cases that are not already covered by Gateway and Cdb reconstruction tests.

## Experimental retention

The supported snapshot path coalesces dirty work behind one immutable outbox and now has a configured slow-ack proof. Presence, scheduled events, PITR, streams, files, and other experimental queues still need their own row, byte, age, and cleanup limits before they enter scope.

## Performance targets

The benchmark runner records comparison telemetry without thresholds. Set targets only after repeated runs on a declared runner image, CPU allocation, Bun version, Miniflare version, sample count, and workload profile. Record variance and choose separate correctness and performance failure policies.

## Dependency upgrade

Upgrade Miniflare when a compatible stable release no longer pins vulnerable `undici@7.28.0`. Do not hide the advisory with a dependency override or adopt a prerelease runtime only to silence the scanner.
