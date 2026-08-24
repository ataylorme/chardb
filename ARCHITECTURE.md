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
| [`Gateway`](src/server/do/gateway.ts) | Owns hibernated WebSockets, verifies JWT identity, authorizes declared organization mutations and exact-partition organization queries through Catalog, persists exact query generations, reruns dirty queries, stages immutable snapshots, and tracks delivery acknowledgements. Presence and general query shapes remain closed. |
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

API helpers attach a `__chardbRef` and a kind marker to mutations, queries, crons, presence keys, and ledgers. Public organization mutations require an explicit literal `ref` alongside `authority: "organization"`. Public organization queries additionally require a partition key and a developer-declared server-side intent callback. The Vite plugin preserves explicit refs and authority metadata in browser handles, rejects invalid or duplicate declarations, and uses generated module refs for APIs that do not require an explicit one. [`manifestFromExports`](src/server/manifest.ts) walks the marked server exports and builds maps for mutations, queries, crons, and ledgers.

Mutation and query descriptors retain raw argument validation, a validated handler entry point, the partition-key extractor, and the authority declaration. Query descriptors also retain the declared intent callback. `chardb()` closes over the same lazily built manifest in configured Gateway and Cdb classes. Gateway validates each public mutation or query argument value once before evaluating routing metadata. Cdb resolves the validated entry point inside the shard isolate rather than applying the transform again. The manifest and its functions never cross RPC.

The workerd Gateway harness builds a browser module through Vite, imports its emitted refs, and compares two mutation refs and one query ref with the independently bundled Worker before opening the socket. This proves the client and server builds agree for explicit refs; it is not a general compatibility promise for generated refs.

## Mutation and transaction design

The intended single-partition write path is:

```text
Up.mut
  -> Gateway verifies the JWT subject
  -> Gateway resolves the explicit ref, validates and transforms args once,
     then extracts the organization partition from those validated args
  -> Catalog re-derives membership, role, roles, and auth epochs
  -> Catalog resolves the vshard to a Cdb shard
  -> Cdb resolves the validated handler locally under the policy wrapper
  -> one transactionSync commits user SQL and the op-log result
  -> Gateway returns the mutation result
```

The transaction core exists in [`executeAtomicMutation`](src/server/atomic-mutation.ts). It creates a Drizzle Durable Object database, wraps it with the request auth context, and runs a synchronous handler inside `DurableObjectStorage.transactionSync`. [`runWrappedMutation`](src/oplog/wrapper.ts) writes the deduplication record in that same transaction.

The op-log key is the principal and mutation id. A retry with the same canonical request returns the stored result without rerunning the handler. Reusing the id with a different request raises a collision error. An exception rolls back both application rows and the provisional op-log row.

The browser client bounds each mutation promise with `mutationTimeoutMs`, which defaults to 60 seconds. The deadline starts when the mutation becomes pending and does not reset during reconnect. While the mutation remains pending, each reconnect sends the original request and `mutId`, so the server op-log can deduplicate a committed first attempt. If the deadline expires, the client rejects with nonretryable `CDB_MUTATION_OUTCOME_UNKNOWN` because it cannot tell whether the server committed the request. A synchronous send failure, client close, session failure, or terminal mutation result removes the pending record and clears its timer. `ChardbProvider` forwards `mutationTimeoutMs` to the client. There is no public retry handle or automatic retry policy for terminal errors.

Gateway separately reserves capacity for at most 32 unsettled mutations on one verified connection and 256 across one Gateway object. The reservation covers work queued behind auth refresh and remains held until dispatch settles. Excess mutations receive retryable `CDB_RATE_LIMITED` before dispatch. Typed failures, thrown failures, stale socket settlement, and send failure all release the reservation.

Gateway measures each inbound WebSocket text frame as UTF-8 before wire decoding. It accepts exactly 1 MiB and closes larger frames with code 1009 without dispatching or persisting their contents. These limits do not complete the bounds for subscriptions, staged snapshots, presence state, other queues, or slow-consumer buffering.

Durable Object SQLite transactions cannot span `await`. The atomic executor rejects native async handlers and thenables. Input validation and any external I/O must finish before entering the transaction.

The typed Gateway dispatcher opens only mutations that declare `authority: "organization"` and an explicit ref. It passes the verified subject and the organization extracted from validated arguments to Catalog. Catalog re-derives current membership, role, roles, and global, tenant, and principal auth epochs. Gateway rejects missing, revoked, mismatched, or malformed authority before selecting Cdb, then reads the shard and schema epoch and sends one serializable request.

The Catalog membership read is the authorization linearization point. Revocation prevents the next dispatch, but it does not cancel a Cdb call authorized by an earlier read. Cdb does not revalidate membership epochs. Its mutation RPC is therefore a trusted post-validation internal seam, not a public raw-input boundary. Cdb resolves the validated handler entry point and runs it with Catalog-derived auth under the policy wrapper and atomic op-log executor. Mutations without an authority declaration return `CDB_AUTH_NOT_BOUND`. See [STATUS.md](STATUS.md).

## Auth and policy design

[`defineAuth`](src/auth/synthesize.ts) synthesizes Drizzle tables for better-auth core models and configured plugins. `chardb()` mounts better-auth with [`chardbAuthAdapter`](src/auth/chardb_adapter.ts):

- every synthesized auth model lives in the singleton Catalog;
- routine email, token, provider/account, and membership lookups query Catalog directly;
- each auth mutation and every directly derivable old and new global, tenant, or principal auth epoch bump commit in one Catalog transaction;
- Cdb and GsiShard do not store or index auth rows.

Catalog renders deterministic SQLite DDL from the synthesized Drizzle schema. It preserves primary and composite keys, uniqueness, foreign keys, indexes, supported defaults, nullability, and SQLite types. Newly created tables record an `auth_ddl_v1` signature. An existing table must have the exact matching signature and every declared index or Catalog rejects it as incompatible. There is no versioned upgrade path for older layouts.

Catalog derives epoch scopes from each model's placement and from conventional `organizationId` and `userId` fields. Updates derive scopes from both the stored row and the replacement row. Bulk updates and deletes preload all matched rows inside the transaction before they mutate data and bump epochs.

Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary epoch scope. The adapter reports `transaction: false`, so Better Auth workflows that make several adapter calls remain sequential. Bun fake-Durable-Object tests cover the broader adapter operations. A configured Catalog workerd test creates a user, session, organization, and member, evicts the Catalog Durable Object, proves a new instance started, and reads identical stored auth rows and canonical organization authority after reconstruction. Separately, focused bootstrap tests prove that the demo organization hook reuses one organization and membership across repeated sessions. The packed chat smoke proves Better Auth anonymous sign-in, session lookup, hook execution, JWT issue, domain write, mutation replay, and organization isolation under workerd. General versioned auth migrations remain unimplemented.

Table role and column rules compile through [`compileCdbPolicies`](src/server/cdb-policy.ts). [`wrapDb`](src/server/cdb-db-proxy.ts) fills tenant and owner columns from `ctx.auth` on inserts, then requires a create grant and checks caller-supplied columns. Updates require an update grant, check writable columns, and forbid changes to managed tenant and self columns. Updates, deletes, and full-row selects AND the server tenant and self predicates with the caller's filter, including operations with no caller `where`. Select execution masks unreadable columns before rows reach the handler.

The wrapper exposes typed select, insert, update, delete, and transaction entry points for registered `cdbTable` definitions. It blocks raw execution, Drizzle session and client objects, relational-query and count shortcuts, plain-table CRUD, insert-select, conflict methods, `returning`, and unsupported builder properties before policy attachment. Full-row single-table selects can use tracked filters, column ordering including typed ascending or descending order, limits, and offsets. For live queries, the wrapper conservatively records each `cdbTable` at `FROM` construction and in tracked predicate or ordering expressions. Raw or untracked predicates, embedded subqueries, and `orderBy` callbacks fail closed. Projections, joins, grouping, set operations, prepared queries, and other result shapes that cannot yet be masked fail closed with `CDB_UNSUPPORTED_FEATURE`. Transactions receive the same wrapper recursively.

The configured Gateway derives issuer, audience, allowed algorithms, and JWKS location from the Better Auth JWT plugin. During `hello` and `updateAuth`, it verifies the signature and registered claims through the Catalog-owned JWK resolver. Catalog scopes keys and refresh coordination by the normalized JWKS URL. The verified attachment contains the subject and token time bounds. It does not copy tenant, role, or custom claims into authority. Catalog supplies those fields for each declared organization mutation and exact-partition organization query.

Gateway rechecks expiry and not-before before protected operations. Each socket receives a server-generated connection id. Auth refresh barriers use that id, serialize multiple refreshes, drain admitted work, retire that connection's current durable query generations, report affected subscription ids through `mustRefetch`, and gate later work. They do not replay those subscriptions. A failed refresh writes a terminal rejected attachment before closing the socket, so queued work cannot reuse stale verified state.

Miniflare workerd tests drive the configured Gateway Durable Object and WebSocket with ES256 tokens, a real Catalog SQLite cache, Catalog-derived organization authority, and configured Cdb mutation and query handlers. JWKS fetch and read have a 5-second deadline, a 256 KiB document limit, a 32-key limit, a 256-byte `kid` limit, and a 2,048-byte URL limit. Catalog coordinates each URL with a durable 10-second refresh lease. Success creates a 5-second negative-cache window for absent keys. Failures return a typed unavailable result and enter exponential cooldown from 1 to 60 seconds. Refresh replaces that URL's key set atomically, returns no stale key, and ignores the unscoped legacy cache. The configured workerd test routes the exact remote URL through an in-process worker and proves outbound failure modes, cooldown suppression and recovery, cache refresh, absent-key retirement, rotated-key acceptance, and Catalog-derived authority despite forged claims. Other focused tests seed JWKs and auth rows through test-only HTTP routes. The packed chat smoke instead obtains its session and Gateway JWT through actual Better Auth anonymous sign-in. An explicit organization query can use that authority only when its validated partition and developer-declared intent resolve to the same exact organization and one virtual shard. Undeclared, mismatched, scatter, cross-partition, and subjectless queries remain closed. Presence remains closed.

Better Auth anonymous accounts are authenticated principals after sign-in, JWT issuance, and organization membership. `publicRead` removes the matching table-role grant from select authorization. It does not bypass the Gateway JWT, Catalog membership, the mandatory tenant floor, write grants, or cross-organization isolation. A four-case workerd test proves an own-organization read and denial for another organization, a missing JWT, and an invalid JWT.

## Subscription design

Wire protocol v3 requires `protocolV` in `hello` and `welcome`. Its decoder rejects unknown fields, missing fields, and incorrect field types. A subscription request sends a server-stamped query ref and raw arguments. It does not send intent or a query hash. A `snapshot` carries a subscription id, cookie, and JSON row array. On a new cookie, the client replaces its rows, clears optimistic patches, records the cookie, marks the subscription `live`, and acknowledges the cookie. It acknowledges a same-cookie retry again without applying the rows twice.

Registration helpers resolve the ref in the local manifest, validate arguments, evaluate the declared intent callback, compute the current query hash, persist a registration, and choose shards:

- explicit partition values route to their owning shards;
- reference joins route to a canonical shard;
- other intents call `Catalog.listShardIds()` to enumerate each physical shard that owns a current range.

Catalog reads distinct shard ids directly from `catalog_ranges` and returns them in stable order. Focused tests cover narrow, non-aligned ranges, duplicate ownership, point routing, reference routing, and scatter without virtual-shard probes.

The public path is narrower than those routing helpers. It accepts only an explicit stable-ref query with `authority: "organization"` whose validated partition and developer-declared server-side intent resolve to the same organization and one exact virtual shard. Gateway derives current Catalog authority and the physical Cdb identity. It persists a unique generation and logical head before calling `Cdb.subscribe`, then pre-arms durable recovery before the RPC. Cdb stores the exact Gateway, generation, connection, client, subscription, principal, organization, ref, arguments, policy digest, query hash, tables, and intervals. Its in-memory [`IntervalMap`](src/intervals.ts) rebuilds from SQLite when Cdb starts.

The intent callback remains developer-written metadata rather than a query plan derived from the handler. For the supported full-row single-table shape, Cdb conservatively records every `cdbTable` dependency exposed through `FROM` construction and tracked predicate or ordering expressions. Both direct and registered query execution compare the recorded set with the current declared `intent.tables` before returning a result. An omitted table returns `CDB_INVARIANT`. At every terminal query execution, the wrapper records the actual typed predicate after adding the row-policy floor. Cdb projects that predicate onto each declared interval bundle's index and requires that bundle's union to contain every observed range for its table and index. It retains observations from executions whose rows the handler later discards. Raw or untracked predicates, embedded subqueries, and callback predicates or ordering stay closed because the runtime cannot verify them. Projections, joins, grouping, and richer query shapes remain closed.

Gateway and Cdb derive a static digest from the declared tables' tenancy fields, `publicRead`, role-to-verb matrix, column grants, compiled policy descriptors, and auth dependencies. The digest excludes arbitrary policy function source because closure text can change across builds without changing the declared table policy. Query hashing and persisted registration identity include the digest on both objects. Gateway compares the current digest before a dirty rerun and before sending an already staged snapshot. Cdb recomputes it before registered execution. A mismatch retires the generation with `CDB_INVARIANT`. Bootstrap adds the digest column and retires legacy active registrations that lack it. A quiet registration detects later drift only when an invalidation, staged send, or another work trigger reaches it.

Gateway activates the generation only after Cdb echoes the expected identity and returns a valid change sequence. An invalidation that arrives during installation raises the stored dirty version, so activation does not lose it. Cancellation, a newer subscription with the same logical identity, unsubscribe, disconnect, auth refresh, an ambiguous subscribe result, or recovery of an abandoned installation retires the exact generation. Cdb keeps tombstones so a stale subscribe replay cannot reactivate it. Gateway commits logical-head retirement and its cleanup alarm in one storage transaction. If that close-time transaction fails, both changes roll back and Gateway makes a separate best-effort alarm transaction. Each alarm scans at most 32 active heads in rowid order from a durable cursor. Only one current verified socket with the exact connection, principal, client, and subscription identity protects a head. A missing socket, expired attachment, or mismatched identity causes retirement and cleanup through the exact Cdb subscription identity. Another fallback request preserves an in-progress cursor, and the alarm re-arms until the page scan reaches the end. If both the original transaction and the fallback alarm transaction fail, a quiet abandoned head can still persist until another event or bootstrap reaches the Gateway.

Each newly run mutation records its deterministic registered-table write set. In the same Cdb transaction as domain SQL and the op-log, a matching write advances the local change sequence and coalesces one invalidation per registered generation into a durable outbox. A Cdb alarm delivers bounded batches to the exact physical Gateway and deletes an item only after a conditional acknowledgement. Retry and dead-letter state stay in SQLite.

Gateway accepts an invalidation only for the exact current generation, connection, client, subscription, organization, and physical Cdb source. It raises the generation's dirty version monotonically. Its alarm runner claims dirty work with a token, rechecks current Catalog authority and routing, and calls `Cdb.queryRegistered` for the exact active generation. Cdb constructs a read-only policy-wrapped Drizzle database, invokes the validated handler with fresh Catalog-derived auth, and requires a JSON array result. A real workerd test keeps a socket open while its membership role changes from `member` to `viewer`, returns to `member`, then disappears. Dirty reruns reflect each authority change without replacing the socket credential.

Gateway stages the result as an immutable snapshot with a generated cookie and target version before delivery. It retries the stored snapshot until the verified socket acknowledges that exact cookie. The acknowledgement advances delivered state without erasing newer dirtiness. A real workerd test evicts Gateway and Cdb while a hibernated socket has a staged replacement. Both objects reconstruct their SQLite state, Gateway delivers the stored snapshot with the same cookie, and the client acknowledges it. The test also covers two org-A clients, initial snapshots and acknowledgements, a public mutation, Cdb invalidation delivery, replacement snapshots and acknowledgements, an org-B rerun that stays empty under policy, outbox drain, and reconnect with a fresh subscription.

This path sends full replacement snapshots. It does not send incremental row patches. Resume cookies do not replay missed changes, and reconnect creates a new subscription. General query shapes, scatter and cross-partition queries, projections, joins, presence, uploads, streams, and vectors remain outside the working public path.

The chat example's auth hook uses a find-or-create sequence for the shared demo organization and each user's membership. It accepts a concurrent create only after a confirming lookup, then updates the new session's active organization. Its `postMessage` definition opts into the public mutation path with an explicit ref and organization authority. [`scripts/smoke-packed-chat.mjs`](scripts/smoke-packed-chat.mjs) installs version 0.1.0 from a clean tarball and builds the client refs. Its first Better Auth principal acknowledges an empty initial snapshot, executes `postMessage`, acknowledges the replacement, replays the same `mutId`, and reads exactly one row through a second subscription. A second principal moves to another organization. Gateway denies its query against `demo-org` and returns an empty snapshot for its own organization.

## Package and generated project

The npm tarball contains built `dist` files and public documentation. It does not contain `src`. CI installs the tarball in an empty consumer and checks each advertised export. After the package and generated-project smokes, CI installs the same tarball in a clean packed chat consumer and exercises the narrow application path under workerd.

`chardb init` generates a separate Bun project with pinned dependencies, strict TypeScript settings, six Durable Object bindings, static assets, and a Wrangler dry-run build. The generated README says that domain migrations and the complete authenticated mutation, registered-query, and live-update application path are incomplete. CI installs the generated project from the packed tarball without workspace aliases, typechecks it, and asks Wrangler to bundle it without deploying.

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
