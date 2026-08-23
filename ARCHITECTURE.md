# Chardb architecture

Chardb is an experimental multi-tenant database design for Cloudflare Workers and Durable Objects. This document describes the code that exists in this repository. [STATUS.md](STATUS.md) identifies which paths work in isolation and which still lack end-to-end wiring.

## Runtime topology

```text
browser client
    |
    | WebSocket protocol
    v
application Worker ---- /api/auth/* ----> better-auth
    |
    | reserved routes
    v
Gateway DO ---- routing lookup ----> Catalog DO
    |                                  |
    |                                  | range map, epochs, barriers,
    |                                  | replicated auth data, JWKS cache
    v                                  |
Cdb shard DO <-------------------------+
    |
    | SQLite data, op-log, subscription intervals,
    | shard-local auth data, reshard copy and tail state
    v
optional R2, Vectorize, queue, BlobMeta, GsiShard, and Resharder bindings
```

The application Worker is assembled by [`chardb()`](src/server/chardb.ts). It combines a Hono application, the synthesized auth schema, a manifest, the reserved Chardb routes, and the Durable Object class exports required by Wrangler.

[`mountChardb`](src/server/entrypoint.ts) sends `/ws`, `/q`, `/f`, `/p`, `/s`, and `/_chardb/*` to the Chardb entrypoint. It sends `/api/auth/*` to better-auth when auth is configured. Other requests fall through to the application.

The Durable Objects have separate responsibilities:

| Component | Responsibility |
| --- | --- |
| [`Gateway`](src/server/do/gateway.ts) | Owns hibernated WebSockets, persists subscription registrations, routes intents, handles presence messages, and batches outgoing patches. |
| [`Catalog`](src/server/do/catalog.ts) | Owns the global virtual-shard range map, schema and auth epochs, snapshot barriers, cached JWKs, and replicated auth models. |
| [`Cdb`](src/server/do/cdb.ts) | Owns SQLite data for one physical shard, the mutation op-log, interval registrations, shard-local auth models, and source or destination state for range movement. |
| [`Resharder`](src/server/do/resharder.ts) | Persists and drives the multi-phase range-movement protocol by calling Catalog and Cdb RPCs. |
| [`BlobMeta`](src/server/do/blobmeta.ts) | Stores blob lifecycle and reference-count metadata. |
| [`GsiShard`](src/server/do/gsishard.ts) | Stores eventually consistent secondary-index entries. |

## Schema and placement

`forOrg()`, `forUser()`, and `globalScope()` return tenancy-bound `cdbTable` builders. A table carries Chardb metadata alongside its normal Drizzle SQLite definition. The metadata includes its tenant kind, partition column, role rules, column rules, and optional owner column.

The colocation walker in [`src/colocation`](src/colocation) follows foreign keys toward configured distribution roots. Its output classifies tables as rooted, colocated, or replicated. A partition key is encoded deterministically, hashed into one of 16,384 virtual shards, and resolved through the Catalog range map to a physical Cdb shard.

Virtual shards separate stable application placement from physical shard allocation:

```text
tenant key -> canonical encoding -> xxHash64 -> vshard 0..16383
           -> Catalog range lookup -> physical Cdb shard id
```

## Refs and the manifest

API helpers attach a stable `__chardbRef` and a kind marker to mutations, queries, crons, presence keys, and ledgers. The Vite plugin can stamp refs during a build. [`manifestFromExports`](src/server/manifest.ts) walks the marked exports and builds maps for mutations, queries, crons, and ledgers.

Mutation descriptors retain the local handler and an optional partition-key extractor. `chardb()` closes over the same lazily built manifest in configured Gateway and Cdb classes. The Gateway resolves the ref and partition key locally. Cdb resolves the same ref to the handler inside the shard isolate. The manifest and its functions never cross RPC. Query descriptors are collected but the Gateway does not dispatch them yet.

## Mutation and transaction design

The intended single-partition write path is:

```text
Up.mut
  -> Gateway verifies auth, then resolves the ref and partition key locally
  -> Catalog resolves vshard to Cdb shard
  -> Cdb resolves the handler locally
  -> one transactionSync commits user SQL and the op-log result
  -> Gateway returns the mutation result and subscription changes
```

The transaction core exists in [`executeAtomicMutation`](src/server/atomic-mutation.ts). It creates a Drizzle Durable Object database, wraps it with the request auth context, and runs a synchronous handler inside `DurableObjectStorage.transactionSync`. [`runWrappedMutation`](src/oplog/wrapper.ts) writes the deduplication record in that same transaction.

The op-log key is the principal and mutation id. A retry with the same canonical request returns the stored result without rerunning the handler. Reusing the id with a different request raises a collision error. An exception rolls back both application rows and the provisional op-log row.

Durable Object SQLite transactions cannot span `await`. The atomic executor rejects native async handlers and thenables. Input validation and any external I/O must finish before entering the transaction.

The typed Gateway dispatcher now performs local routing, reads the shard and schema epoch from Catalog, and calls the configured Cdb with one serializable request. Cdb runs the atomic executor. The public WebSocket path still stops before dispatch because Gateway has no production JWT verifier bound to it. Decode-only claims never become mutation authority. See [STATUS.md](STATUS.md).

## Auth and policy design

[`defineAuth`](src/auth/synthesize.ts) synthesizes Drizzle tables for better-auth core models and configured plugins. `chardb()` mounts better-auth with [`chardbAuthAdapter`](src/auth/chardb_adapter.ts):

- tenant and principal models route through Catalog to a Cdb shard;
- replicated models such as JWKs live in Catalog;
- successful auth writes bump global, tenant, or principal auth epochs;
- lookups without the model's partition column fail unless a secondary-index path exists.

The adapter currently reports `transaction: false`, so better-auth multi-write operations are sequential.

Table role and column rules compile through [`compileCdbPolicies`](src/server/cdb-policy.ts). [`wrapDb`](src/server/cdb-db-proxy.ts) can fill tenant and owner columns from `ctx.auth` on inserts. Column-mask and writable-column checks also exist as standalone helpers.

[`verifyJwt`](src/auth/jwt.ts) verifies signatures and optional issuer and audience constraints through a JWK resolver. The Gateway currently calls the decode-only helpers during WebSocket hello and stores unverified claims in the socket attachment. Verified claims and compiled policies are not yet connected to the domain query and mutation path.

## Subscription design

The client opens one WebSocket, sends an intent plus its hash, and tracks the last cookie for reconnects. The Gateway persists the subscription and chooses shards from the intent:

- explicit partition values route to their owning shards;
- reference joins route to a canonical shard;
- other intents sample the virtual-shard space to discover physical shards.

Each selected Cdb registers the subscription's table, index, and intervals in an in-memory [`IntervalMap`](src/intervals.ts). `matchSubsForRow` can map a committed row's indexed keys back to affected subscription ids. Gateway code exists to coalesce patches before sending a `poke`.

The missing steps are material: subscription registration does not execute the initial query, query descriptors are not invoked, and committed mutations do not generate row patches through this path. The React presence, upload, stream, and vector hooks are placeholders.

## Schema migration, snapshots, and range movement

Schema migration and range movement are different protocols.

Schema migration is not implemented as a distributed apply path. The CLI can read Drizzle migration files and print a plan, but it does not coordinate a barrier or apply DDL to every shard.

The snapshot barrier pieces do exist. A scheduled Worker call asks Catalog to open a barrier, reads each current shard's maximum op-log row id, and records those bookmarks. Catalog marks the barrier complete after all expected shards acknowledge it. The barrier state machine also has a bounded TLA+ model in [`spec/Barrier.tla`](spec/Barrier.tla). Export and restore are not implemented.

Range movement uses the persisted phase machine in [`Resharder`](src/server/do/resharder.ts):

1. enable source tail triggers and initialize the destination;
2. copy matching rows in batches;
3. replay the source tail;
4. atomically update the Catalog range map and schema epoch;
5. replay the remaining tail, delete moved source rows, and remove triggers.

Cdb contains the source and destination RPCs, including range filtering and idempotent row application. Catalog cutover is guarded by migration id and runs inside one local transaction. The phase protocol has a bounded TLA+ model in [`spec/Resharder.tla`](spec/Resharder.tla).

The Cdb copy and tail operations have workerd tests. The complete Resharder orchestration, automatic triggering, concurrent production traffic, and failure recovery have not been proven end to end.

## Consistency boundary

The proposed strong consistency boundary is one partition on one Cdb Durable Object. Catalog operations are individually serializable within the Catalog object. Operations spanning several Cdb objects need an explicit protocol. A two-phase coordinator and recovery model exist in [`src/server/dt_protocol.ts`](src/server/dt_protocol.ts), but the default runtime does not bind participants, so cross-partition transactions are not a working product path.
