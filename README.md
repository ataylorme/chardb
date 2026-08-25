# chardb

Experimental tenant-sharded SQLite for Cloudflare Durable Objects.

Chardb explores one idea: mark an organization boundary in a Drizzle schema, then derive data placement, per-tenant transactions, authorization, and live-query routing from that declaration.

This is engineering work intended for public review, not a database you should deploy yet. Focused workerd tests drive a narrow live path through WebSocket, Gateway, Catalog, and Cdb. Same-socket hibernation can redeliver an unacknowledged exact snapshot after object reconstruction. After transport loss, a replacement SDK connection instead performs explicit per-subscription refetch and receives authoritative rows under a fresh cookie. The packed smoke gives two independent same-organization browser connections the same live replacement before its restart, replay, and isolation checks. Exact resume-cookie replay remains open.

## Current state

Implemented and tested in isolation:

- Deterministic foreign-key colocation
- 16,384 virtual-shard range routing
- SQLite mutation deduplication through an operation log
- Fresh-shard domain DDL bootstrap with signature checks
- Catalog routing, snapshot barriers, and resharding state machines
- Hibernated WebSocket bookkeeping
- Strict protocol-v3 decoding and server-owned query routing metadata
- Better Auth schema synthesis with all auth rows stored in Catalog
- Constraint-complete Catalog auth DDL with exact `auth_ddl_v1` compatibility checks
- Configured Catalog reconstruction with stored auth rows and organization authority preserved
- Atomic Catalog auth mutations with directly derivable old and new epoch bumps
- Gateway JWT signature and registered-claim verification
- Public organization-authorized mutations with explicit stable refs
- Catalog-derived membership, roles, and auth epochs for each declared organization mutation
- Single-pass mutation schema transformation before partition routing, with bounded argument checks at every trust boundary
- Client mutation settlement bounded by a configurable timeout across reconnects
- Schema-first insert, update, delete, and full-row select authorization, including writable-column checks and readable-column masks
- A fail-closed database wrapper that rejects raw, session, client, plain-table, insert-select, conflict, returning, and unsupported builder paths
- Read-only shard-local query execution with JSON result validation
- Protocol-v3 snapshot decoding and client replacement handling
- Durable public registrations and live replacement snapshots for explicit, exact-single-partition organization queries
- Conservative `cdbTable` dependency checks against each live query's declared table intent
- Static `cdbTable` policy digests in Gateway and Cdb registered-query identity
- Transactional Cdb invalidation outbox delivery with durable retries
- Durable Gateway query reruns, immutable snapshot staging, and acknowledgement tracking
- Client acknowledgement and same-cookie snapshot deduplication
- Catalog-backed scatter enumeration without sampled virtual-shard probes
- Persistent composite Gateway, client, and subscription identities on Cdb shards
- TLA+ models for snapshot barriers and resharding
- Packed-package import checks and a standalone `chardb init` scaffold
- A clean-tarball packed chat smoke from anonymous sign-in through live replacement, persistent Miniflare restart, session reconstruction, exact mutation replay, one-row readback, and organization isolation

Still missing from the application path:

- Exact missed-snapshot replay from resume cookies
- Applying domain migrations across shards
- Adding versioned auth-schema upgrades
- Exposing a public mutation retry handle and defining an automatic retry policy

Files, vectors, presence, streams, scheduling, cross-partition transactions, PITR, and automatic resharding remain experiments. They are not supported product features.

The WebSocket protocol does not trust client routing or authority metadata. Gateway verifies the JWT signature and registered claims, then keeps only the verified subject and time bounds in the socket attachment. A mutation becomes public only when its server definition declares `authority: "organization"` and an explicit stable `ref`. An organization query additionally declares a partition key and a server-side intent callback written by the developer. Gateway validates arguments, requires the declared partition and intent to resolve to the same exact organization and one virtual shard, and asks Catalog to re-derive membership, role, roles, and global, tenant, and principal auth epochs. Token tenant, role, and custom claims never become authority. Undeclared, mismatched, scatter, and cross-partition queries remain closed. Presence remains closed.

Subjectless Gateway queries remain closed. Better Auth anonymous sign-in creates an authenticated account. After JWT issuance and organization membership, that account is a principal like any other. A table's `publicRead` flag removes the table-role requirement for selects only. It does not remove JWT verification, Catalog membership, the tenant predicate, write grants, or cross-organization isolation. A four-case workerd proof covers an allowed same-organization read, a denied cross-organization read, a missing JWT, and an invalid JWT.

Catalog's authority read is the authorization linearization point. A revocation blocks the next dispatch, but it does not cancel a Cdb call that Catalog already authorized. Each dirty live-query rerun reads current authority again. A workerd test keeps one socket open while its membership changes from `member` to `viewer`, back to `member`, then to deleted. The reruns return an empty snapshot after the downgrade, restore rows after the role returns, and retire the registration with `CDB_FORBIDDEN` after deletion. Cdb treats its mutation RPC as a trusted post-validation internal seam. It invokes the validated handler under the database policy wrapper and commits domain SQL with the provisional op-log row in one transaction.

The JWT tests use real signatures and the Catalog resolver contract. Miniflare workerd tests drive the configured Gateway Durable Object and WebSocket with ES256 tokens, a real Catalog SQLite cache, Catalog membership resolution, and configured Cdb mutation and query handlers. The live test gives two org-A clients initial snapshots and acknowledgements, commits a public mutation, drains the Cdb invalidation outbox, delivers replacement snapshots and acknowledgements, keeps an org-B query empty under policy, then reconnects and subscribes again. One snapshot durability case evicts Gateway and Cdb before sending a staged replacement and completes delivery after reconstruction. A second sends a replacement without receiving its acknowledgement, hibernates the same open socket, reconstructs both objects, redelivers the exact cookie and rows, accepts one acknowledgement, and delivers a later mutation normally. This second case is not a reconnect proof. Another test imports refs from a real emitted Vite browser chunk and compares them with the independently bundled workerd Worker. A configured Catalog workerd test creates a user, session, organization, and member, evicts the Catalog Durable Object, proves a new instance started, and reads identical stored auth rows and canonical organization authority after reconstruction. Catalog now owns JWKS refresh and scopes cache entries, leases, and cooldowns by URL. It enforces a 5-second fetch and read deadline, a 256 KiB document limit, at most 32 keys, a 256-byte `kid`, and a 2,048-byte URL. A durable 10-second lease coordinates refresh. A successful document caches absent keys for 5 seconds, while failures cool down exponentially from 1 to 60 seconds. Refresh never returns an expired key or falls back to the unscoped legacy cache, and it atomically removes keys absent from the new document. The configured workerd test proves fail-closed outbound errors, cooldown suppression, recovery, retired and unknown key rejection, rotated-key acceptance, and Catalog-derived authority despite forged tenant and role claims. Other focused tests seed JWK and auth rows through test-only routes. The separate packed chat smoke runs actual Better Auth anonymous sign-ins and token issue for two principals. Catalog auth DDL preserves constraints and indexes for new storage. Existing tables need exact matching `auth_ddl_v1` signatures; no versioned upgrade path exists.

A real-workerd compatibility run requires a host that permits local listeners. The current counts are `gateway-live` 7/7, `gateway-jwt` 22/22, and `gateway-snapshot` 3/3. The JWT suite proves protocol mismatch closes before JWT or JWKS verification. The snapshot recovery cases have 15-second budgets. This is test budget, not a product latency promise. Focused passes do not make Chardb production-ready.

Each server-generated connection id owns at most one in-flight `hello` or `updateAuth` operation. A duplicate receives retryable `CDB_RATE_LIMITED` before JWT verification, Catalog access, attachment mutation, or refresh chaining. Every outcome releases only the exact owning claim. An admitted `updateAuth` barrier remains visible to mutation and subscription admission while Gateway drains prior work, retires that connection's current durable registrations, and reports affected subscription ids through `mustRefetch`. It does not replay those subscriptions.

Socket close or a hibernatable socket error stores a rejected attachment, releases in-memory admission state, and drives the same exact durable retirement and fallback reconciliation path. Every post-await authentication, drain, alarm, retirement, invalidation, attachment mutation, and send step is fenced. Late continuations cannot dispatch queued work or replace the rejected state. Failed refreshes also store a terminal rejected attachment before closing the socket.

If a verified `hello` cannot send `welcome`, Gateway marks that exact connection rejected and attempts a 1011 close with reason `welcome delivery failed`. An unsupported protocol is rejected before verification; Gateway attempts the mismatch frame, then closes with 1002 and reason `unsupported chardb protocol <version>` even if that send fails.

The client option `mutationTimeoutMs` defaults to 60 seconds and covers the full pending lifetime, including reconnects. A reconnect resends a pending mutation with its original `mutId` without resetting the deadline. If that deadline expires, the promise rejects with nonretryable `CDB_MUTATION_OUTCOME_UNKNOWN` because the server may already have committed the mutation. A synchronous send failure, client close, session failure, or terminal server result clears the timer. `ChardbProvider` forwards the same option. The client does not expose a retry handle or automatically retry terminal errors.

Pre-welcome closes advance reconnect delay through 250 ms, 500 ms, 1 second, 2 seconds, 4 seconds, 8 seconds, and a repeating 10-second cap. A WebSocket opening does not reset the delay. Only an accepted `welcome` restores the initial 250 ms delay.

Pending JWT continuations and all socket callbacks check terminal state, connection-attempt number, and exact socket identity. Error and close revoke the current socket before reconnect processing. A stale JWT or callback therefore cannot send, apply rows, settle work, schedule another reconnect, or change the replacement socket. The existing backoff sequence and welcome-only reset remain unchanged.

If the initial `hello` send throws, the client revokes and closes that socket and enters the same reconnect path. Queued subscriptions and mutations remain admitted. A replacement socket sends each once after `welcome`, with the original mutation ids and deadlines.

The same pending-mutation map caps queued, in-flight, and reconnecting client work at 32 records. Mutation refs validate before admission. A valid 33rd request rejects immediately with retryable `CDB_RATE_LIMITED` before UUID allocation, timer creation, map insertion, or send. Reconnect preserves admitted ids and deadlines. Success, typed failure, timeout, synchronous send failure, client close, and session failure remove records and release capacity.

Client subscription and mutation arguments must be strict JSON primitives, dense arrays, or plain or null-prototype objects with enumerable data properties. Validation rejects accessors without invoking getters, plus cycles, sparse or decorated arrays, unsupported prototypes, symbols, nonfinite numbers, negative zero, and other non-JSON values. Arguments accept the exact 512 KiB serialized UTF-8 boundary, at most 4,096 aggregate array elements and object properties, and 99 nested argument levels because the request envelope consumes one level of the wire decoder's 100-level budget. Client violations return nonretryable `CDB_INVALID_ARGS`; the public wire decoder rejects a deeper envelope before Gateway mutation admission.

After ref validation, the client enforces the limits and constructs an owned copy in one descriptor traversal. It does not invoke getters or enumerate and read a proxy again, so later caller mutation cannot change the admitted request. Both subscribe and mutate complete this work before capacity checks, id allocation, record insertion, or send; mutate also does so before timer creation. Immediate sends, the first welcome flush, and reconnect reuse the stored owned payload and original subscription or mutation id.

Direct `createChardbClient` calls remain eager, and the package exports have not changed. `ChardbProvider` uses an internal deferred controller only for clients it creates, so connection work begins after the provider commits. Aborted renders start no WebSocket, JWT, or broadcast work. StrictMode rehearsal keeps the committed client alive, replacement closes an old owned client once, and a transfer of that same object to the `client` prop cancels its pending close. The provider never closes a borrowed client. `useQuery` validates and owns arguments before canonical identity using the exact 512 KiB UTF-8, 4,096-member, and 99-level strict JSON limits. Invalid arguments fail with `CDB_INVALID_ARGS` without a subscription. Valid queries return `pending` as soon as their client, ref, or canonical owned arguments change and ignore late listener calls from the prior subscription.

With an explicit stable `getJwt`, changing only the provider's `auth` object updates `useSession` context without replacing the owned client, socket, subscriptions, or pending mutations. If the provider derives JWTs from `auth`, an auth-object change replaces the client and closes the old one once.

For mutations, Gateway checks the same contract before admission or auth-refresh waiting. Trusted dispatch snapshots raw arguments before local routing. Built-in routing owns validator output, gives partition extraction a separate copy, and owns the forwarded arguments again. Custom route arguments are bounded and copied before Catalog or Cdb work. Gateway captures its authority, partition key, and valid vshard, then captures Catalog-derived principal, organization, role, copied roles, and epochs across later awaits. Cdb owns the request primitives, arguments, claims, roles, and epochs before awaiting its recovery alarm, and checks them before descriptor, handler, op-log, or domain work.

Keyless mutation routing uses stable canonical JSON, so nested object insertion order does not change its shard. Canonical JSON and op-log request hashing preserve an own `__proto__` data property without prototype mutation; changing that value changes replay identity and produces a mutation-id collision for the same `mutId`.

Server query and subscription arguments use the same exact 512 KiB UTF-8, 4,096-member, and 99-level strict JSON contract. Gateway owns raw subscription arguments before pending capacity or routing. Built-in routing takes separate owned snapshots around validation and declared intent and partition callbacks, including the callback-mutated arguments and returned intent. Gateway rechecks the arguments from an overridden route before Catalog, Cdb, or durable installation. Each snapshot is built from data descriptors in one traversal without invoking getters or enumerating and reading a proxy again, so later caller, validator, or callback mutation cannot alter downstream work.

`Cdb.subscribe` enforces the contract before interval or durable registration work. Direct `Cdb.query` enforces it before descriptor lookup or handler invocation, and registered execution checks persisted arguments before routing callbacks or the handler. Cdb bootstrap streams the active-registration cursor and rebuilds each table and interval mapping as its row arrives, including a full 4,096-row set. A legacy active row with over-limit arguments stays mapped and invalidatable but returns terminal `CDB_INVALID_ARGS` when executed; valid sibling registrations still run. Focused tests cover this behavior, but the reconstructed legacy case does not yet have dedicated Gateway snapshot-runner integration coverage.

Mutation results accept the exact 512 KiB serialized JSON boundary. A fresh result is copied from data descriptors inside the transaction before op-log finalization or the write-set hook, without invoking getters or rereading a proxy. The fresh response and replay therefore remain equal if the handler later mutates its retained object. A fresh oversized result returns `CDB_INVARIANT`; its domain SQL and provisional op-log row roll back. Replay applies the same limit to the stored result. An oversized legacy row is rejected without running the handler or hook and without changing the stored row. The error guidance directs larger reads to a paginated query.

A newly executed atomic mutation accepts at most 256 successful typed write statements and 4,096 affected rows. The executor uses each statement's `total_changes()` delta so direct writes, trigger fanout, and foreign-key actions share the row cap. Either overflow is terminal `CDB_INVARIANT`: even if the handler catches it, later writes stay blocked and the stored violation aborts commit. Domain SQL and the provisional op-log row roll back, and the write-set hook does not run. The mutation database remains usable only during its owning `transactionSync`; retained reads, writes, and nested transaction entry fail with `CDB_INVARIANT` before late SQL. Supported nested wrappers share the active guard. Async handlers, returned thenables, and async write-set hooks remain unsupported. An accepted replay bypasses the handler and these write counters.

Gateway admits at most 32 unsettled mutations per connection and 256 per Gateway object. Excess mutations receive retryable `CDB_RATE_LIMITED` before dispatch. Inbound WebSocket text frames are measured as UTF-8 before wire decoding. Gateway accepts the exact 1 MiB boundary and closes larger frames with code 1009.

After routed mutation work settles, Gateway requires the socket's exact verified `connectionId`, `clientId`, and `principalId` before updating `lastCookie` on success or sending either success or failure. Socket close or attachment replacement suppresses stale delivery. This does not undo a commit or change the Cdb op-log's replay and collision semantics.

The client independently accepts inbound WebSocket data only as text through the exact 1 MiB UTF-8 boundary before decoding. A non-text or larger frame terminally closes the session with `CDB_INVARIANT`, clears subscriptions and pending mutations, cancels mutation and reconnect timers, and closes the socket and broadcast channel. Frames that pass still use the existing semantic caps: 4,096 rows and 512 KiB for snapshots and caches, 4,096 items and 512 KiB for patch batches and optimistic history, and 8 MiB across retained query state.

The client keeps at most 64 active subscription records. It validates the ref and owns the arguments before checking this cap. A valid subscription over the cap throws retryable `CDB_RATE_LIMITED` synchronously before it consumes an id, changes state, or sends. Reconnect resends the same records, ids, and owned argument snapshots. Unsubscribe releases one slot, and terminal session failure clears all records. A synchronous subscribe-send failure removes the new record so reconnect cannot revive it. A failed unsubscribe send closes the client session.

Nonduplicate snapshots accept up to 4,096 rows and the exact 512 KiB serialized JSON boundary. Canonical and cross-tab optimistic patch batches accept up to 4,096 items and 512 KiB. The client preflights a whole batch and every patch row before subscription lookup, and before cross-tab stringify. Every resulting row cache uses the snapshot row and byte caps. Optimistic history accepts up to 4,096 patches and 512 KiB. The client validates every affected subscription plan, commits all planned caches and histories, then invokes listeners. Malformed or oversized input closes the session with `CDB_INVARIANT` and no partial application. A same-cookie snapshot is re-acknowledged and ignored before sizing, so it cannot replace current rows or clear optimistic state.

Terminal cleanup clears every subscription's rows and optimistic history before its final empty listener notification. A listener exception cannot stop cleanup of later listeners, pending mutations, timers, the socket, or the broadcast channel. Stale socket callbacks are fenced and cannot run terminal cleanup again.

Across all subscriptions, serialized retained rows plus optimistic history accept the exact 8 MiB boundary. Snapshots and optimistic patches are deep-cloned into private state, and each listener receives another deep clone. Listener mutation cannot change later query state. Cloning preserves an own `__proto__` data property without mutating the object's prototype. Multi-subscription patch batches validate every planned state and aggregate bytes before any commit. Unsubscribe, refetch clearing, and terminal cleanup release retained state. Inbound overflow fail-closes without partial application; a new subscription that cannot retain its empty state receives retryable `CDB_RATE_LIMITED` before id allocation or send.

For each Gateway connection and subscription id, one subscription attempt can be active and one replacement can wait behind it. Further duplicates receive retryable `CDB_RATE_LIMITED` before capacity SQL, query routing, Catalog reads, Cdb calls, or installation. Later duplicates cannot replace the accepted replacement payload. Route rejection and final scheduler errors are sent only while the attempt still owns the pending slot and its exact verified socket remains current, so replacement, unsubscribe, and close fence stale errors.

After durable unsubscribe retirement settles, Gateway rereads the socket attachment. It removes the subscription id only from the exact current verified connection, client, and principal, and spreads that current attachment so newer auth timing, cookie, presence, and other subscription fields survive. A close-rejected attachment or replacement identity remains untouched.

Each Gateway admits at most 256 aggregate current and pending logical registrations. It counts durable heads after restart, permits a same-key replacement without consuming another slot, and rejects a duplicate pending race. Excess work receives retryable `CDB_RATE_LIMITED` before query routing, Catalog reads, Cdb calls, or registration installation. A configured workerd case fills one Gateway with four real SDK clients and 256 active Gateway and Cdb registrations, rejects a raw 257th subscription without installing it in Cdb, releases one exact slot, admits one replacement, and drains both objects to zero.

Gateway also charges the exact stored UTF-8 bytes of durable registration and snapshot payload, ignoring advisory size columns, plus bounded headroom for mutable claim tokens, retry errors, and cookies. Registration charge accepts the exact 15 MiB boundary inside an exact 16 MiB total, leaving 1 MiB for staged snapshots. Registration install or replacement, snapshot staging, and acknowledgement enforce quota atomically. Before snapshot send, Gateway atomically binds the exact claimed row to the socket's arbitrary resume cookie and retires that claim with retryable `CDB_RATE_LIMITED` if it would cross 16 MiB. Retirement scrubs query and snapshot payload while retaining exact Cdb cleanup identity. Restart compacts legacy retired rows and deletes their outboxes; successful cleanup releases the remaining bytes.

Retired Cdb subscription-tombstone total bytes and its compaction watermark, presence state, other queues, slow-consumer backpressure, and other retention watermarks remain incomplete.

Better Auth counts use a Catalog scalar `COUNT(*)` RPC instead of materializing matching rows. They keep the same `eq` and `AND` where validation, model and column checks, and bound equality predicates as row lookup. `findMany` forwards offset and sort through Catalog. Model sort fields map through the synthesized schema, direction accepts validated `ASC` or `DESC`, and `id ASC` breaks ties or supplies the default paging order. Limit and offset accept only non-negative safe integers and go to SQL as bindings. Each auth mutation commits with every directly derivable old and new global, tenant, or principal epoch bump.

Single Better Auth `update` and `delete` select the lowest matching schema-mapped id and mutate only that row. An empty predicate or no match is a no-op. `updateMany` and `deleteMany` retain all-match behavior, including for an empty predicate, and keep their existing bulk bounds.

Better Auth `incrementOne` is native rather than a read-then-update fallback. Catalog maps customized model and field names in both directions, deterministically selects one row, repeats its guards in the exact update, applies increment and set values atomically, and bumps auth epochs only when the update succeeds. Invalid mappings, guards, fields, deltas, or projected write volume fail before base or epoch writes.

Bulk auth update and delete preflight accepts exactly 4,096 matched rows and 512 KiB of projected old and replacement scope values. Update also accepts exactly 512 KiB of schema-mapped replacement values after multiplying their SQL byte cost by the matched row count. Catalog loads only placement, organization, and user scope columns. Overflow returns retryable `CDB_RATE_LIMITED` before the base write or epoch bump, and `updateMany` performs no full-row preload or reread. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. These cases have Bun fake-Durable-Object coverage, not workerd coverage.

Fresh Cdb objects render domain tables and indexes from the configured Drizzle schema, record signatures, and reject drift. This does not migrate an existing shard. Inserts, updates, deletes, and full-row selects require schema-declared grants. Inserts and updates check writable columns; updates forbid authority-column changes. Updates, deletes, and selects AND tenant and self predicates with the caller's filter, including operations with no filter. Select results receive readable-column masks. Projections, joins, and other shapes that cannot yet be masked safely fail closed.

Application handlers can use only typed builders against registered `cdbTable` definitions. The wrapper rejects raw SQL, Drizzle session and client access, relational and count shortcuts, plain-table CRUD, insert-select, conflict methods, `returning`, and unsupported properties before or after policy attachment. For a supported full-row live query, Cdb conservatively records every `cdbTable` used at a `FROM` boundary and in tracked predicates or ordering. Every terminal execution records its actual typed predicate after the row-policy floor is applied. Each declared interval bundle's union must contain every observed range for its table and index, including executions whose rows the handler later discards.

Direct and registered query execution build owned results from data descriptors before returning them, without invoking property getters, and apply the 4,096 top-level row and exact 512 KiB serialized JSON limits to those values. Later handler mutation cannot change a response. Direct execution checks its observed reads and ranges after the snapshot. Registered execution snapshots first, checks reads and ranges next, then rereads and fences the durable generation. A Proxy `ownKeys` trap that performs an undeclared read or changes generation identity therefore returns `CDB_INVARIANT`. Oversized results receive the same code with guidance to limit rows or columns, or paginate. Raw or untracked predicates, embedded subqueries, and callback predicates or ordering fail closed. Projections, joins, grouping, and richer query shapes remain closed.

Gateway and Cdb derive the same static digest from the row and column policy metadata of the `cdbTable` names in the declared intent. The digest excludes arbitrary function source because closure text is not stable across builds. Both objects persist it as part of registered-query identity and mix it into the query hash. Gateway checks it before a dirty rerun and again before sending a staged snapshot. Cdb checks it before registered execution. A mismatch retires the generation instead of returning or sending rows under an old policy. Bootstrap retires legacy Gateway and Cdb registrations that have no digest. A quiet registration has no background policy scan, so it detects drift on its next invalidation, snapshot-send attempt, or other work trigger.

The clean-tarball smoke signs in two distinct principals that initially share `demo-org`. Both browser connections acknowledge empty initial snapshots, then receive and acknowledge the same live replacement after `postMessage`. After closing both sockets, the smoke restarts Miniflare, reconstructs both sessions, replays the exact mutation with one stored row, then moves the second principal and proves cross-organization denial. This does not prove exact resume replay or migrations.

Scatter routing asks Catalog for the distinct physical shards that own current ranges, but public scatter queries remain closed. The narrow organization path persists the exact Gateway generation, client and subscription identity, principal, organization, auth epochs, static table-policy digest, logical shard, physical Cdb, query identity, retry state, and delivery state. Each Cdb admits 4,096 active registrations. An exact active replay succeeds without another slot, unsubscribe releases the slot, and Cdb returns either success for the exact requested identity or a matching typed `registrationState: "absent"` capacity failure. Gateway deletes only that proven-absent pending generation without creating a Cdb tombstone. Cancellation while the call is pending preserves its recovery record; lost, malformed, or identity-mismatched outcomes trigger exact unsubscribe compensation. A pre-armed 30-second durable deadline performs the same cleanup after restart.

Each Cdb also caps its coalesced invalidation outbox at 4,096 rows. Existing exact rows can coalesce at capacity, and acknowledged delivery releases them. A mutation selects at most 4,097 distinct registration targets with `LIMIT 4097`, accepts exactly 4,096, and rejects overflow with retryable `CDB_RATE_LIMITED`. That rejection rolls back the domain write, provisional op-log, change clock, and outbox work. Cdb invalidations and Gateway cleanup and retry work survive Durable Object reconstruction.

Catalog publishes a range-cutover map to its in-memory routing cache only after the range update, schema epoch, and migration guard commit. A failed commit rolls back durable state and keeps the old cached route; retry can commit the new shard and epoch, then publish the new route once. Full Resharder orchestration and recovery remain experimental.

The dependency audit is not clean. Compatible updates removed the reported `nanoid`, PostCSS, Sharp, SVGO, and `ws` advisories. Bun still reports five advisories on `miniflare@4.20260730.0 -> undici@7.28.0`; Miniflare 4 pins that version, while the fixed `undici@7.29.0` is currently available only through Miniflare 5 alpha.

Placeholder `/q`, `/f`, `/p`, and `/s` handlers were removed, and those paths fall through to the application. Placeholder React presence, upload, stream, and vector hooks are not exported.

See [STATUS.md](./STATUS.md) for current capability boundaries, [ARCHITECTURE.md](./ARCHITECTURE.md) for the runtime design, and [PLAN.md](./PLAN.md) for the ordered implementation work.

## The schema idea

```ts
import { forOrg } from "chardb/server";
import { integer, text } from "drizzle-orm/sqlite-core";
import { auth } from "./worker";

const { cdbTable } = forOrg();

export const messages = cdbTable(
  "messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => auth.organization.id),
    authorId: text("author_id")
      .notNull()
      .references(() => auth.user.id),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  {
    selfBy: "authorId",
    roles: {
      admin: "*",
      member: { read: "*", create: ["body"] },
      self: { read: "*", update: ["body"], delete: true },
    },
  },
);
```

The organization foreign key identifies the intended transaction and placement boundary. Related rows colocate through their foreign-key chain. Declared organization mutations enforce that boundary by checking the extracted organization against Catalog membership. An explicit organization query crosses the same authority boundary only when its declared partition and developer-declared server-side intent identify that exact organization and one virtual shard. That narrow path registers the query and sends replacement snapshots after matching commits.

## Repository development

Install Bun, then run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test:correctness
bun run build
```

`test:correctness` runs ordinary tests together, then starts each workerd harness in a separate process. The workerd tests open local ports. Individual harnesses remain available for focused diagnosis:

```bash
bun test test/workerd/catalog.harness.test.ts
bun test test/workerd/reshard.harness.test.ts
bun test test/workerd/gateway-live.harness.test.ts
bun test test/workerd/gateway-jwt.harness.test.ts
bun test test/workerd/gateway-snapshot.harness.test.ts
```

The `gateway-live` harness also contains two default-small SDK scale scenarios. They assert tenant isolation, exact filtered rows, durable convergence, outbox drain, and cleanup. They emit JSON timing telemetry but impose no latency or throughput threshold. Run just the raw scenarios with:

```bash
bun run test:scale
```

For repeated, comparison-ready evidence, run one of the frozen profiles:

```bash
bun run bench:live -- --profile ci-smoke --samples 3 --output-dir .chardb/benchmarks/ci-smoke
bun run bench:live -- --profile client-max-accepted --samples 3 --output-dir .chardb/benchmarks/client-max
bun run bench:live -- --profile throughput --samples 5 --output-dir .chardb/benchmarks/throughput
```

The profiles fix the accepted workload and test budgets. `ci-smoke` uses one client per tenant, four mutations per tenant, four selective subscriptions, and two refresh rounds. `client-max-accepted` uses one client per tenant, 32 mutations per tenant in a batch of 32, 64 selective subscriptions, and two rounds. `throughput` uses eight clients per tenant, 1,024 mutations per tenant, 32 subscriptions, and eight rounds. The fanout case now commits half its writes, converges every client, closes and recreates half the clients, rematerializes their tenant rows, then finishes the workload. Every selective-refresh sample reconstructs Cdb with all subscriptions active, verifies the exact registration identities and unchanged Gateway state, closes and recreates the SDK connection, proves that every new Gateway head has the same new identity as its active Cdb registration, then performs the measured writes and materializations. Both scenarios require every successful mutation to add exactly one domain row, one op-log row, and one change-clock step. Connection churn and reconstruction must leave those counters unchanged. The CLI parses 1 to 20 samples but rejects any profile and sample combination that exceeds the conservative workflow allowance. The output directory must be absent or empty. `run.json` is written before the first sample and keeps structured running, completed, or failed state. Each sample keeps stdout and stderr and writes two `chardb.scale.sample.v1` NDJSON records. The `chardb.scale.report.v1` report records exact workload, Git revision, Bun, OS, CPU, and runner metadata, then summarizes timing and rate fields with min, p50, p95, max, and mean. The manual `Live scale benchmark` workflow accepts a profile and sample count and uploads the full result directory for 14 days.

A three-sample clean-HEAD local `throughput` run at `7071a3d` on Bun 1.2.22 and an Apple M4 Pro executed 6,144 fanout mutations and 768 selective mutations. Those 6,912 successful mutations produced exact deltas of 6,912 domain rows, 6,912 op-log rows, and 6,912 change-clock steps. The run replaced 24 live clients midway, verified 86,016 logical row deliveries, reconstructed 96 live Cdb registrations across three evictions, and replaced them with 96 exact new SDK/Gateway registrations. Per-sample fanout throughput ranged from 159.43 to 161.68 mutations/s, client churn took 191.35 to 216.17 ms for eight clients, logical delivery throughput ranged from 28,740.91 to 29,666.59 rows/s, selective recovery took 248.79 to 274.32 ms for 32 registrations, writes ranged from 286.68 to 292.64/s, and materializations from 266.01 to 277.24/s. This Miniflare run is regression telemetry, not a benchmark baseline, capacity claim, or performance target. The repository still requires repeated runs on a declared platform before setting targets.

The landing page is a separate workspace:

```bash
cd landing
bun run build
```

## Repository layout

- `src/server` contains the Worker entrypoint, Durable Objects, schema helpers, policies, and routing code.
- `src/client` and `src/react` contain the WebSocket client and React hooks.
- `src/oplog`, `src/colocation`, `src/reshard`, and `src/drizzle` contain the lower-level database experiments.
- `test/workerd` exercises selected Durable Object behavior through Miniflare.
- `spec` contains the TLA+ models.
- `example/chat` is a concept application. It does not yet prove the complete runtime path.
- `landing` contains the project site.

The npm tarball contains built `dist` files and the public documents. It does not contain `src`. CI runs `chardb init` from that tarball in a temporary project, installs its pinned dependencies without workspace aliases, typechecks it, and runs a Wrangler dry-run build. CI then runs the packed chat smoke, which installs version 0.1.0 into another clean temporary consumer and proves sign-in, mutation, live delivery, persistent Miniflare restart, session reconstruction, op-log replay, one-row readback, and organization isolation. Domain migrations, exact resume-cookie replay, and broader recovery guarantees remain unfinished.

## License

MIT
