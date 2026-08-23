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
    |                                  | all auth data, JWKS cache
    v                                  |
Cdb shard DO <-------------------------+
    |
    | SQLite domain data, op-log, subscription intervals,
    | reshard copy and tail state
    v
deferred BlobMeta, GsiShard, Resharder, R2, Vectorize, and queue experiments
```

The application Worker is assembled by [`chardb()`](src/server/chardb.ts). It combines a Hono application, the synthesized auth schema, a manifest, the reserved Chardb routes, and the Durable Object class exports required by Wrangler.

[`mountChardb`](src/server/entrypoint.ts) sends `/ws` and `/_chardb/*` to the Chardb entrypoint. It sends `/api/auth/*` to better-auth when auth is configured. Other requests fall through to the application. In particular, `/q`, `/f`, `/p`, and `/s` are not runtime feature endpoints and remain available to application routes.

The Durable Objects have separate responsibilities:

| Component | Responsibility |
| --- | --- |
| [`Gateway`](src/server/do/gateway.ts) | Owns hibernated WebSockets, resolves refs in the server manifest, derives query routing intent, persists subscription registrations, handles presence messages, and batches outgoing patches. |
| [`Catalog`](src/server/do/catalog.ts) | Owns the global virtual-shard range map, schema and auth epochs, snapshot barriers, cached JWKs, and all synthesized auth models. |
| [`Cdb`](src/server/do/cdb.ts) | Owns SQLite domain data for one physical shard, the mutation op-log, interval registrations, and source or destination state for range movement. |
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

Mutation descriptors retain the local handler and an optional partition-key extractor. Query descriptors retain argument validation, intent extraction, and the local handler. `chardb()` closes over the same lazily built manifest in configured Gateway and Cdb classes. The Gateway resolves refs, validates query arguments, and derives routing metadata locally. Cdb resolves mutation refs to handlers inside the shard isolate. The manifest and its functions never cross RPC. Cdb does not yet resolve or execute query handlers.

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

The typed Gateway dispatcher performs local routing, reads the shard and schema epoch from Catalog, and calls the configured Cdb with one serializable request. Cdb runs the atomic executor. Gateway now verifies WebSocket identity, but the public mutation path stops before dispatch because verified subject is not tenant authority. It returns `CDB_AUTH_NOT_BOUND` until Catalog-derived membership, role, and policy state can construct `ctx.auth`. See [STATUS.md](STATUS.md).

## Auth and policy design

[`defineAuth`](src/auth/synthesize.ts) synthesizes Drizzle tables for better-auth core models and configured plugins. `chardb()` mounts better-auth with [`chardbAuthAdapter`](src/auth/chardb_adapter.ts):

- every synthesized auth model lives in the singleton Catalog;
- routine email, token, provider/account, and membership lookups query Catalog directly;
- each auth mutation and every directly derivable old and new global, tenant, or principal auth epoch bump commit in one Catalog transaction;
- Cdb and GsiShard do not store or index auth rows.

Catalog renders deterministic SQLite DDL from the synthesized Drizzle schema. It preserves primary and composite keys, uniqueness, foreign keys, indexes, supported defaults, nullability, and SQLite types. Newly created tables record an `auth_ddl_v1` signature. An existing table must have the exact matching signature and every declared index or Catalog rejects it as incompatible. There is no versioned upgrade path for older layouts.

Catalog derives epoch scopes from each model's placement and from conventional `organizationId` and `userId` fields. Updates derive scopes from both the stored row and the replacement row. Bulk updates and deletes preload all matched rows inside the transaction before they mutate data and bump epochs.

Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary epoch scope. The adapter reports `transaction: false`, so Better Auth workflows that make several adapter calls remain sequential. The current coverage uses a Bun fake-Durable-Object harness. No full sign-in flow or real workerd restart has been verified.

Table role and column rules compile through [`compileCdbPolicies`](src/server/cdb-policy.ts). [`wrapDb`](src/server/cdb-db-proxy.ts) can fill tenant and owner columns from `ctx.auth` on inserts. Column-mask and writable-column checks also exist as standalone helpers.

The configured Gateway derives issuer, audience, allowed algorithms, and JWKS location from the Better Auth JWT plugin. During `hello` and `updateAuth`, it verifies the signature and registered claims through a Catalog-backed JWK resolver. The verified attachment contains the subject and token time bounds. It does not copy tenant, role, or custom claims into authority.

Gateway rechecks expiry and not-before before protected operations. A verified refresh replaces the subject only after successful verification and invalidates existing subscriptions. A Miniflare workerd test drives the configured Gateway Durable Object and WebSocket with ES256 tokens and a real Catalog SQLite cache. The test seeds `Catalog.putJwk` through a test-only HTTP route. Outbound JWKS fetch, cache refresh, and key rotation remain untested.

Tenant membership, role, auth epoch, and policy authority are still absent. Mutation, subscription, and presence handlers therefore return `CDB_AUTH_NOT_BOUND` after identity verification. Anonymous query behavior is also undefined.

## Subscription design

Wire protocol v2 requires `protocolV` in `hello` and `welcome`. Its decoder rejects unknown fields, missing fields, and incorrect field types. A subscription sends a server-stamped query ref and raw arguments. It does not send intent or a query hash.

After the remaining membership boundary, the isolated routing path can resolve the ref in its local manifest, validate the arguments, derive the intent, compute the current query hash, persist the registration, and choose shards:

- explicit partition values route to their owning shards;
- reference joins route to a canonical shard;
- other intents currently probe the virtual-shard space every 256 slots.

The 256-step probe is not a correct Catalog enumeration algorithm. It can miss a shard that owns a narrow, non-aligned range. Gateway needs an RPC that lists current Catalog ranges or unique shard ids.

Each selected Cdb registers the subscription's table, index, and intervals in an in-memory [`IntervalMap`](src/intervals.ts). The interval map is keyed only by numeric `subId`, even though different Gateway objects and clients can reuse that number. The shard registration must use a composite Gateway, client, and subscription identity before multi-client behavior is safe. `matchSubsForRow` can map a committed row's indexed keys back to registrations. Gateway code exists to coalesce patches before sending a `poke`.

The current query hash serializes the ref, validated arguments, and derived intent. It still needs canonical JSON and verified principal, tenant, auth epoch, and policy epoch inputs. Public subscription registration currently fails closed before this routing path. Cdb does not invoke query descriptors, and committed mutations do not generate live replacement results. React presence, upload, stream, and vector hooks are not exported until their client paths exist.

## Package and generated project

The npm tarball contains built `dist` files and public documentation. It does not contain `src`. CI installs the tarball in an empty consumer and checks each advertised export.

`chardb init` generates a separate Bun project with pinned dependencies, strict TypeScript settings, six Durable Object bindings, static assets, and a Wrangler dry-run build. The generated README says that domain migrations and the authenticated mutation, initial-query, and live-update path are incomplete. CI installs the generated project from the packed tarball without workspace aliases, typechecks it, and asks Wrangler to bundle it without deploying.

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
