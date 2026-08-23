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

Mutation descriptors retain the local handler and an optional partition-key extractor. Query descriptors retain argument validation, intent extraction, and the local handler. `chardb()` closes over the same lazily built manifest in configured Gateway and Cdb classes. The Gateway resolves refs, validates query arguments, and derives routing metadata locally. Cdb resolves both mutation and query refs inside the shard isolate. The manifest and its functions never cross RPC.

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

Table role and column rules compile through [`compileCdbPolicies`](src/server/cdb-policy.ts). [`wrapDb`](src/server/cdb-db-proxy.ts) fills tenant and owner columns from `ctx.auth` on inserts, then requires a create grant and checks caller-supplied columns. Updates require an update grant, check writable columns, and forbid changes to managed tenant and self columns. Updates and deletes AND the server tenant and self predicates with the caller's filter, including operations with no caller `where`, and deletes require a matching grant. Select and raw SQL do not yet pass through equivalent enforcement, and query results do not yet receive readable-column masks.

The configured Gateway derives issuer, audience, allowed algorithms, and JWKS location from the Better Auth JWT plugin. During `hello` and `updateAuth`, it verifies the signature and registered claims through a Catalog-backed JWK resolver. The verified attachment contains the subject and token time bounds. It does not copy tenant, role, or custom claims into authority.

Gateway rechecks expiry and not-before before protected operations. A verified refresh replaces the subject only after successful verification and invalidates existing subscriptions. A Miniflare workerd test drives the configured Gateway Durable Object and WebSocket with ES256 tokens and a real Catalog SQLite cache. The test seeds `Catalog.putJwk` through a test-only HTTP route. Outbound JWKS fetch, cache refresh, and key rotation remain untested.

Tenant membership, role, auth epoch, and policy authority are still absent. Mutation, subscription, and presence handlers therefore return `CDB_AUTH_NOT_BOUND` after identity verification. Anonymous query behavior is also undefined.

## Subscription design

Wire protocol v3 requires `protocolV` in `hello` and `welcome`. Its decoder rejects unknown fields, missing fields, and incorrect field types. A subscription sends a server-stamped query ref and raw arguments. It does not send intent or a query hash. The protocol also defines a `snapshot` with a subscription id, cookie, and JSON row array. The client replaces its rows, clears optimistic patches, records the cookie, and marks the subscription `live` when that message arrives.

After the remaining membership boundary, the isolated routing path can resolve the ref in its local manifest, validate the arguments, derive the intent, compute the current query hash, persist the registration, and choose shards:

- explicit partition values route to their owning shards;
- reference joins route to a canonical shard;
- other intents call `Catalog.listShardIds()` to enumerate each physical shard that owns a current range.

Catalog reads distinct shard ids directly from `catalog_ranges` and returns them in stable order. Focused tests cover narrow, non-aligned ranges, duplicate ownership, point routing, reference routing, and scatter without virtual-shard probes.

Each selected Cdb persists the subscription's composite Gateway, client, and subscription id along with its principal, ref, arguments, tables, and intervals. The in-memory [`IntervalMap`](src/intervals.ts) uses that composite identity and rebuilds from SQLite when Cdb starts. Focused reconstruction tests cover colliding numeric subscription ids and targeted unsubscribe. `matchSubsForRow` maps a committed row's indexed keys back to composite registrations. Gateway code exists to coalesce patches before sending a `poke`.

The current query hash serializes the ref, validated arguments, and derived intent. It still needs canonical JSON and verified principal, tenant, auth epoch, and policy epoch inputs. Public subscription registration currently fails closed before this routing path.

An isolated `Cdb.query` RPC resolves a query descriptor, constructs a read-only Drizzle wrapper, invokes the handler with the request auth context, and validates that its result is JSON. Its tests cover persisted rows, empty arrays, handler failures, and rejected insert, update, delete, raw SQL, and transaction entry points. Gateway does not call this RPC for a public subscription or establish its auth authority, and no server component produces the protocol-v3 snapshot. Committed mutations also do not generate live replacement results. React presence, upload, stream, and vector hooks are not exported until their client paths exist.

## Package and generated project

The npm tarball contains built `dist` files and public documentation. It does not contain `src`. CI installs the tarball in an empty consumer and checks each advertised export.

`chardb init` generates a separate Bun project with pinned dependencies, strict TypeScript settings, six Durable Object bindings, static assets, and a Wrangler dry-run build. The generated README says that domain migrations and the authenticated mutation, initial-query, and live-update path are incomplete. CI installs the generated project from the packed tarball without workspace aliases, typechecks it, and asks Wrangler to bundle it without deploying.

Compatible dependency updates remove the reported `nanoid`, PostCSS, Sharp, SVGO, and `ws` advisories. Bun still reports five advisories through `miniflare@4.20260730.0 -> undici@7.28.0`. Miniflare 4 pins that dependency exactly. The fixed `undici@7.29.0` currently arrives only through Miniflare 5 alpha, so the lockfile does not force an override or major upgrade.

## Schema migration, snapshots, and range movement

Schema migration and range movement are different protocols.

On first startup, Cdb renders the configured domain `cdbTable` definitions, creates missing tables and indexes in one local transaction, and stores a signature per table. It preserves supported keys, constraints, local foreign keys, defaults, nullability, indexes, and SQLite types. Authority foreign keys to Catalog-owned auth tables are omitted because those tables are not local. Other nonlocal domain foreign keys fail bootstrap. Existing unsigned or mismatched tables and missing indexes fail closed with `CDB_PARTITION_CONTRACT_CHANGED`.

That bootstrap is not schema migration. The CLI can read Drizzle migration files and print a plan, but it does not coordinate a barrier, apply versioned DDL to existing shards, or upgrade stored signatures.

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
