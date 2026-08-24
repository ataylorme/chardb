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

Mutation results accept the exact 512 KiB serialized JSON boundary. For a newly run mutation, the executor checks the result inside `transactionSync` before the op-log finalizes its success row and before the write-set hook runs. A larger result returns `CDB_INVARIANT` with guidance to return less data and read larger results through a paginated query. That exception rolls back the handler's domain SQL and provisional op-log row, and the hook does not run. Replay checks the stored result through the same byte limit. An oversized legacy row is rejected without invoking the handler or hook and without changing that row. A result within the limit replays unchanged.

Subscription and mutation arguments share one browser-client contract. Mutation arguments use the same contract again at verified Gateway admission, trusted dispatch, and the Cdb RPC. Values must be strict JSON primitives, dense arrays, or plain or null-prototype objects with enumerable data properties. Accessors are rejected without invoking their getters, as are cycles, sparse or decorated arrays, symbols, unsupported prototypes, nonfinite numbers, negative zero, and non-JSON values. The exact serialized UTF-8 limit is 512 KiB, the aggregate array-element and object-property limit is 4,096, and argument nesting stops at 99 levels because the enclosing request consumes one level of the wire decoder's 100-level budget. Client violations return nonretryable `CDB_INVALID_ARGS`; the public wire decoder rejects a deeper envelope before Gateway mutation admission.

For both operations, the client validates the ref and then counts the JSON limits while constructing a private snapshot in the same descriptor traversal. It reads enumerable data descriptors, not property values, and does not enumerate or read a proxy a second time. This closes the gap between validation and ownership: changing the caller's object later cannot change a queued or retried request. Validation and copying finish before the relevant capacity check, id allocation, record insertion, or send, and before mutation timer creation. The immediate send path, the first welcome flush, and reconnect all reuse the stored owned arguments and original subscription or mutation id.

For mutations, Gateway validates before reserving capacity or waiting on an auth-refresh barrier. Trusted dispatch validates raw arguments before local routing or Catalog authorization, then validates the transformed arguments again before Catalog routing and Cdb selection. Cdb performs the final check before descriptor lookup, recovery-alarm scheduling, handler execution, provisional op-log insertion, or domain SQL.

For a newly executed mutation, the atomic wrapper permits 256 successful typed write statements and 4,096 affected rows. It measures the `total_changes()` delta around each statement, so direct changes, trigger fanout, and foreign-key actions share the row budget. Exceeding either cap records a terminal `CDB_INVARIANT`. Catching that error inside the handler does not recover the transaction: later writes remain blocked and the executor rethrows the stored violation before commit. Domain SQL and the provisional op-log row roll back, and the write-set hook does not run. An accepted op-log replay bypasses the handler and write-volume accounting.

The browser client bounds each mutation promise with `mutationTimeoutMs`, which defaults to 60 seconds. The deadline starts when the mutation becomes pending and does not reset during reconnect. While the mutation remains pending, each reconnect sends the original request and `mutId`, so the server op-log can deduplicate a committed first attempt. If the deadline expires, the client rejects with nonretryable `CDB_MUTATION_OUTCOME_UNKNOWN` because it cannot tell whether the server committed the request. A synchronous send failure, client close, session failure, or terminal mutation result removes the pending record and clears its timer. `ChardbProvider` forwards `mutationTimeoutMs` to the client. There is no public retry handle or automatic retry policy for terminal errors.

One pending-mutation map holds at most 32 records, whether they are queued before welcome, in flight, or waiting for reconnect. The client validates the mutation ref before checking capacity. A valid 33rd request rejects immediately with retryable `CDB_RATE_LIMITED` before UUID allocation, timer creation, map insertion, or send. Reconnect reuses each admitted record's original id and deadline. Success, typed failure, timeout, synchronous send failure, client close, and session failure remove records and release capacity.

Gateway separately reserves capacity for at most 32 unsettled mutations on one verified connection and 256 across one Gateway object. The reservation covers work queued behind auth refresh and remains held until dispatch settles. Excess mutations receive retryable `CDB_RATE_LIMITED` before dispatch. Typed failures, thrown failures, stale socket settlement, and send failure all release the reservation.

Gateway measures each inbound WebSocket text frame as UTF-8 before wire decoding. It accepts exactly 1 MiB and closes larger frames with code 1009 without dispatching or persisting their contents.

The browser client keeps at most 64 active subscription records. Ref and argument validation precede this capacity check. A valid subscription over the cap throws retryable `CDB_RATE_LIMITED` synchronously before it consumes an id, changes local state, or sends a frame. Reconnect resends the same records, ids, and owned argument snapshots without consuming more capacity. Unsubscribe removes its record before sending and releases the slot. Terminal session cleanup clears every record even if a listener throws. A synchronous subscribe-send failure removes the new record so reconnect cannot revive it. If an unsubscribe frame cannot be sent, the client closes the session rather than pretending server cleanup succeeded.

For a new snapshot cookie, the client accepts up to 4,096 rows and the exact 512 KiB serialized JSON boundary. A same-cookie snapshot takes the duplicate path first. The client re-acknowledges it and ignores its rows without sizing or applying them. Canonical server patch batches and cross-tab optimistic batches accept up to 4,096 items and 512 KiB. The client preflights the whole batch and every patch row before any subscription lookup. Cross-tab input passes the same preflight before JSON stringify and wire decoding.

Patch application builds and validates every affected subscription state before changing any record. Each resulting row cache has the same 4,096-row and 512 KiB limits. Optimistic history accepts up to 4,096 patches and 512 KiB. After all plans pass, the client commits every cache and history, then invokes listeners. Malformed or oversized snapshots, patches, caches, or histories fail the session with `CDB_INVARIANT` and no partial state application.

Across all subscriptions, serialized retained rows plus optimistic patch history accept the exact 8 MiB boundary. A new subscription preflights its empty state, and unsubscribe, refetch clearing, and terminal session cleanup release retained state. Snapshots and optimistic patches are deep-cloned before storage. Each listener invocation receives another deep clone, so caller mutation or cycles added to a delivered value cannot alter private rows or optimistic history. Cloning defines keys as own data properties, preserving an own `__proto__` key without changing the clone's prototype. Canonical and optimistic multi-subscription patch batches build every affected state and check the aggregate limit before committing any of them.

Each Gateway admits at most 256 aggregate current and pending logical registrations. The admission check counts durable current heads from SQLite, so restart does not reset capacity. A replacement with the same principal, client, and subscription key reuses its slot. A second pending request for that key on another connection receives retryable `CDB_RATE_LIMITED` instead of racing the first installation. New work over the aggregate cap is rejected before query routing, Catalog authority or placement reads, Cdb RPCs, or durable installation.

For one Gateway connection and subscription id, admission retains at most one active attempt and one queued replacement. Once that replacement slot is occupied, another duplicate receives retryable `CDB_RATE_LIMITED` before capacity SQL, query routing, Catalog or Cdb calls, or installation. Later duplicates do not overwrite the accepted replacement's payload. A route rejection or final scheduler failure reports an error only while its attempt still owns the pending slot and the exact verified socket remains current. Replacement, unsubscribe, or close therefore fences stale errors.

Gateway charges durable subscription payload from the exact UTF-8 byte lengths stored in registration-generation and snapshot-outbox columns, ignoring advisory snapshot `byte_size` values. It adds bounded headroom for mutable run and send claim tokens, retry errors, and generated cookies. Charged registration state accepts the exact 15 MiB boundary, leaving 1 MiB inside the exact 16 MiB total for staged snapshots and their metadata. Registration install, replacement, snapshot staging, and acknowledgement enforce the quota inside their storage transactions; excess work returns retryable `CDB_RATE_LIMITED` without leaving partial state.

A client resume cookie can be much larger than generated cookies. Immediately before snapshot send, Gateway binds the exact claimed outbox row to the socket's current base cookie and recomputes charged usage in one transaction. If that arbitrary cookie would exceed 16 MiB, the same transaction retires the exact claimed generation, removes its head and outbox, and the socket receives `CDB_RATE_LIMITED`. Every retirement path scrubs query arguments, intent, refs, policy and query hashes, shard routing, and cookies while retaining the exact physical cleanup identity. Bootstrap repeats that compaction for legacy retired rows, deletes their stale outbox payload, and resumes bounded cleanup. Exact cleanup deletion releases the remaining charge.

The remaining resource work includes retired Cdb subscription-tombstone total bytes and its compaction watermark, presence state, other queues, slow-consumer backpressure, and other retention watermarks.

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

Gateway rechecks expiry and not-before before protected operations. Each socket receives a server-generated connection id. That id can own only one in-flight `hello` or `updateAuth` claim. A duplicate receives retryable `CDB_RATE_LIMITED` before JWT verification, Catalog access, attachment mutation, or refresh chaining. Success, rejection, and thrown failure release only the exact owning claim. An admitted `updateAuth` installs a barrier that remains visible to mutation and subscription admission while it drains prior work, retires that connection's current durable query generations, and reports affected subscription ids through `mustRefetch`. It does not replay those subscriptions.

Socket close first stores a rejected attachment and cancels the connection's auth claim, refresh barrier, active-operation bookkeeping, and pending subscriptions. Authentication checks claim ownership after each awaited verification, drain, alarm schedule, and invalidation, and again before retirement, attachment mutation, or send. Late continuations therefore cannot replace the rejected attachment or dispatch queued work. A failed refresh also writes a terminal rejected attachment before closing the socket.

Miniflare workerd tests drive the configured Gateway Durable Object and WebSocket with ES256 tokens, a real Catalog SQLite cache, Catalog-derived organization authority, and configured Cdb mutation and query handlers. JWKS fetch and read have a 5-second deadline, a 256 KiB document limit, a 32-key limit, a 256-byte `kid` limit, and a 2,048-byte URL limit. Catalog coordinates each URL with a durable 10-second refresh lease. Success creates a 5-second negative-cache window for absent keys. Failures return a typed unavailable result and enter exponential cooldown from 1 to 60 seconds. Refresh replaces that URL's key set atomically, returns no stale key, and ignores the unscoped legacy cache. The configured workerd test routes the exact remote URL through an in-process worker and proves outbound failure modes, cooldown suppression and recovery, cache refresh, absent-key retirement, rotated-key acceptance, and Catalog-derived authority despite forged claims. Other focused tests seed JWKs and auth rows through test-only HTTP routes. The packed chat smoke instead obtains its session and Gateway JWT through actual Better Auth anonymous sign-in. An explicit organization query can use that authority only when its validated partition and developer-declared intent resolve to the same exact organization and one virtual shard. Undeclared, mismatched, scatter, cross-partition, and subjectless queries remain closed. Presence remains closed.

Better Auth anonymous accounts are authenticated principals after sign-in, JWT issuance, and organization membership. `publicRead` removes the matching table-role grant from select authorization. It does not bypass the Gateway JWT, Catalog membership, the mandatory tenant floor, write grants, or cross-organization isolation. A four-case workerd test proves an own-organization read and denial for another organization, a missing JWT, and an invalid JWT.

## Subscription design

Wire protocol v3 requires `protocolV` in `hello` and `welcome`. Its decoder rejects unknown fields, missing fields, and incorrect field types. A subscription request sends a server-stamped query ref and raw arguments. It does not send intent or a query hash. A `snapshot` carries a subscription id, cookie, and JSON row array. On a new cookie, the client replaces its rows, clears optimistic patches, records the cookie, marks the subscription `live`, and acknowledges the cookie. It acknowledges a same-cookie retry again without applying the rows twice.

Server query and subscription arguments use the same strict JSON limit as client requests: the exact 512 KiB serialized UTF-8 boundary, 4,096 aggregate array elements and object properties, and 99 nested argument levels. Gateway owns the raw WebSocket arguments before pending-capacity checks or routing. Query routing owns the raw input before the Standard Schema validator, owns the validator result before the declared intent and partition callbacks, then snapshots the callback-mutated arguments and returned intent for the routed result. Each ownership step counts and copies data descriptors in one traversal without invoking getters or enumerating and reading a proxy again. Later mutation by the caller, validator, or callback cannot change the next stage's snapshot.

Gateway also snapshots the arguments returned by `routeQuery` before Catalog authority, Cdb calls, or durable installation. This fence applies when an application overrides the route method, not only to the built-in manifest route. `Cdb.subscribe` snapshots again before interval preparation or registration storage. Direct `Cdb.query` does so before descriptor lookup, declared intent, validation, or handler execution. Registered execution applies the same check to stored arguments before its routing callbacks and handler.

Registration helpers resolve the ref in the local manifest, validate arguments, evaluate the declared intent callback, compute the current query hash, persist a registration, and choose shards:

- explicit partition values route to their owning shards;
- reference joins route to a canonical shard;
- other intents call `Catalog.listShardIds()` to enumerate each physical shard that owns a current range.

Catalog reads distinct shard ids directly from `catalog_ranges` and returns them in stable order. Focused tests cover narrow, non-aligned ranges, duplicate ownership, point routing, reference routing, and scatter without virtual-shard probes.

The public path is narrower than those routing helpers. It accepts only an explicit stable-ref query with `authority: "organization"` whose validated partition and developer-declared server-side intent resolve to the same organization and one exact virtual shard. Gateway derives current Catalog authority and the physical Cdb identity. It persists a unique generation and logical head before calling `Cdb.subscribe`, then pre-arms a durable recovery deadline 30 seconds after installation before the RPC. Cdb stores the exact Gateway, generation, connection, client, subscription, principal, organization, ref, arguments, policy digest, query hash, tables, and intervals. Its in-memory [`IntervalMap`](src/intervals.ts) rebuilds from SQLite when Cdb starts.

Each Cdb admits at most 4,096 active registrations. Bootstrap streams the active-registration storage cursor and installs table and interval mappings row by row rather than collecting all 4,096 first. An exact active replay succeeds without taking another slot, including reconstructed legacy over-cap state. Unsubscribe retires the exact identity and releases its active slot. A legacy active row with arguments that exceed the current query contract remains active and mapped so mutations can still invalidate it. Registered execution rejects that row with terminal `CDB_INVALID_ARGS` before routing callbacks or the handler, while valid sibling registrations continue to execute. Dedicated Gateway snapshot-runner integration coverage for that legacy terminal path is still missing. The subscribe response is a strict union that carries the exact requested identity: success returns its change sequence, while a matching `registrationState: "absent"` capacity failure proves that Cdb did not install it. Gateway can delete that pending generation without asking Cdb to create a retired tombstone.

The intent callback remains developer-written metadata rather than a query plan derived from the handler. For the supported full-row single-table shape, Cdb conservatively records every `cdbTable` dependency exposed through `FROM` construction and tracked predicate or ordering expressions. Both direct and registered query execution compare the recorded set with the current declared `intent.tables` before returning a result. An omitted table returns `CDB_INVARIANT`. At every terminal query execution, the wrapper records the actual typed predicate after adding the row-policy floor. Cdb projects that predicate onto each declared interval bundle's index and requires that bundle's union to contain every observed range for its table and index. It retains observations from executions whose rows the handler later discards. Direct and registered results accept up to 4,096 top-level rows and the exact 512 KiB serialized JSON boundary. Registered execution applies the result limits only after re-reading and fencing the exact active generation. Cdb returns `CDB_INVARIANT` with guidance to limit rows or columns, or paginate, when either cap is exceeded. Raw or untracked predicates, embedded subqueries, and callback predicates or ordering stay closed because the runtime cannot verify them. Projections, joins, grouping, and richer query shapes remain closed.

Gateway and Cdb derive a static digest from the declared tables' tenancy fields, `publicRead`, role-to-verb matrix, column grants, compiled policy descriptors, and auth dependencies. The digest excludes arbitrary policy function source because closure text can change across builds without changing the declared table policy. Query hashing and persisted registration identity include the digest on both objects. Gateway compares the current digest before a dirty rerun and before sending an already staged snapshot. Cdb recomputes it before registered execution. A mismatch retires the generation with `CDB_INVARIANT`. Bootstrap adds the digest column and retires legacy active registrations that lack it. A quiet registration detects later drift only when an invalidation, staged send, or another work trigger reaches it.

Gateway activates the generation only after Cdb echoes the expected identity and returns a valid change sequence. An invalidation that arrives during installation raises the stored dirty version, so activation does not lose it. Cancellation or replacement while `Cdb.subscribe` is pending keeps that generation in recoverable pending state. A later matching absence response deletes the headless generation without a tombstone. A lost response, thrown call, malformed response, or identity mismatch does not prove absence, so Gateway retires the generation and compensates with exact `Cdb.unsubscribe`. The pre-armed 30-second deadline survives restart, and bootstrap recovery performs the same compensation when it expires. Cancellation, a newer subscription with the same logical identity, unsubscribe, disconnect, auth refresh, an ambiguous subscribe result, or recovery of an abandoned installation otherwise retires the exact generation. Cdb keeps tombstones so a stale subscribe replay cannot reactivate it. Gateway commits logical-head retirement and its cleanup alarm in one storage transaction. If that close-time transaction fails, both changes roll back and Gateway makes a separate best-effort alarm transaction. Each alarm scans at most 32 active heads in rowid order from a durable cursor. Only one current verified socket with the exact connection, principal, client, and subscription identity protects a head. A missing socket, expired attachment, or mismatched identity causes retirement and cleanup through the exact Cdb subscription identity. Another fallback request preserves an in-progress cursor, and the alarm re-arms until the page scan reaches the end. If both the original transaction and the fallback alarm transaction fail, a quiet abandoned head can still persist until another event or bootstrap reaches the Gateway.

Each newly run mutation records its deterministic registered-table write set. In the same Cdb transaction as domain SQL and the op-log, a matching write advances the local change sequence and coalesces one invalidation per registered generation into a durable outbox. Each Cdb permits 4,096 outbox rows. An existing exact Gateway-registration row can still coalesce at capacity, and a successful or stale exact delivery acknowledgement deletes it and releases space. Mutation fanout selects distinct registration identities across touched tables with `LIMIT 4097`, permits exactly 4,096 targets, and rejects the next target with retryable `CDB_RATE_LIMITED` before accumulating it. Fanout or outbox overflow rolls back domain SQL, the provisional op-log, the change clock, and all outbox changes. A Cdb alarm delivers bounded batches to the exact physical Gateway. Retry and dead-letter state stay in SQLite.

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
