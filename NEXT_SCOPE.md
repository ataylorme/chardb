# chardb next-scope candidates

Last reviewed: 2026-08-25

The narrow organization-tenanted runtime is the current supported path. This document lists product expansions that are not implemented and must not appear in capability claims. Pick one package before starting another. Exact replacement-socket resume replay left this list on 2026-08-25 after its bounded storage, identity, acknowledgement, fallback, and configured Workerd proofs landed.

## Query shapes

Full-row single-table queries are the only supported shape.

- Compile readable-column masks for projections and joins.
- Define dependency and range tracking for each new shape.
- Keep grouping, aggregates, embedded subqueries, callback predicates, and callback ordering blocked until the runtime can verify them.

## Auth profile expansion

- Add placement metadata or explicit epoch rules for plugin relationships without conventional `organizationId` or `userId` fields.
- Implement adapter transactions for Better Auth workflows that require several writes, or publish and enforce a smaller plugin and workflow list.

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
