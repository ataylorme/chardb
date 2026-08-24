# chardb

Experimental tenant-sharded SQLite for Cloudflare Durable Objects.

Chardb explores one idea: mark an organization boundary in a Drizzle schema, then derive data placement, per-tenant transactions, authorization, and live-query routing from that declaration.

This is engineering work intended for public review, not a database you should deploy yet. Focused workerd tests drive a narrow live path through WebSocket, Gateway, Catalog, and Cdb. Two clients receive and acknowledge initial snapshots, then receive replacement snapshots after a committed mutation. A reconstruction test evicts Gateway and Cdb while a hibernated socket has a staged replacement, then delivers and acknowledges the same stored snapshot after both objects restart. [`scripts/smoke-packed-chat.mjs`](scripts/smoke-packed-chat.mjs) also installs version 0.1.0 from a clean tarball. It signs in through Better Auth, replays the same mutation id without inserting another row, and proves that a second principal in another organization cannot query the demo organization. Resume cookies still do not replay missed changes.

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
- A clean-tarball packed chat smoke proof from anonymous sign-in through live replacement and independent readback

Still missing from the application path:

- Missed-change replay from resume cookies
- Applying domain migrations across shards
- Adding versioned auth-schema upgrades
- Exposing a public mutation retry handle and defining an automatic retry policy

Files, vectors, presence, streams, scheduling, cross-partition transactions, PITR, and automatic resharding remain experiments. They are not supported product features.

The WebSocket protocol does not trust client routing or authority metadata. Gateway verifies the JWT signature and registered claims, then keeps only the verified subject and time bounds in the socket attachment. A mutation becomes public only when its server definition declares `authority: "organization"` and an explicit stable `ref`. An organization query additionally declares a partition key and a server-side intent callback written by the developer. Gateway validates and transforms raw arguments once, requires the declared partition and intent to resolve to the same exact organization and one virtual shard, and asks Catalog to re-derive membership, role, roles, and global, tenant, and principal auth epochs. Token tenant, role, and custom claims never become authority. Undeclared, mismatched, scatter, and cross-partition queries remain closed. Presence remains closed.

Subjectless Gateway queries remain closed. Better Auth anonymous sign-in creates an authenticated account. After JWT issuance and organization membership, that account is a principal like any other. A table's `publicRead` flag removes the table-role requirement for selects only. It does not remove JWT verification, Catalog membership, the tenant predicate, write grants, or cross-organization isolation. A four-case workerd proof covers an allowed same-organization read, a denied cross-organization read, a missing JWT, and an invalid JWT.

Catalog's authority read is the authorization linearization point. A revocation blocks the next dispatch, but it does not cancel a Cdb call that Catalog already authorized. Each dirty live-query rerun reads current authority again. A workerd test keeps one socket open while its membership changes from `member` to `viewer`, back to `member`, then to deleted. The reruns return an empty snapshot after the downgrade, restore rows after the role returns, and retire the registration with `CDB_FORBIDDEN` after deletion. Cdb treats its mutation RPC as a trusted post-validation internal seam. It invokes the validated handler under the database policy wrapper and commits domain SQL with the provisional op-log row in one transaction.

The JWT tests use real signatures and the Catalog resolver contract. Miniflare workerd tests drive the configured Gateway Durable Object and WebSocket with ES256 tokens, a real Catalog SQLite cache, Catalog membership resolution, and configured Cdb mutation and query handlers. The live test gives two org-A clients initial snapshots and acknowledgements, commits a public mutation, drains the Cdb invalidation outbox, delivers replacement snapshots and acknowledgements, keeps an org-B query empty under policy, then reconnects and subscribes again. It also evicts Gateway and Cdb with a hibernated socket and a staged replacement, reconstructs both objects, and delivers the same snapshot cookie. Another test imports refs from a real emitted Vite browser chunk and compares them with the independently bundled workerd Worker. A configured Catalog workerd test creates a user, session, organization, and member, evicts the Catalog Durable Object, proves a new instance started, and reads identical stored auth rows and canonical organization authority after reconstruction. Catalog now owns JWKS refresh and scopes cache entries, leases, and cooldowns by URL. It enforces a 5-second fetch and read deadline, a 256 KiB document limit, at most 32 keys, a 256-byte `kid`, and a 2,048-byte URL. A durable 10-second lease coordinates refresh. A successful document caches absent keys for 5 seconds, while failures cool down exponentially from 1 to 60 seconds. Refresh never returns an expired key or falls back to the unscoped legacy cache, and it atomically removes keys absent from the new document. The configured workerd test proves fail-closed outbound errors, cooldown suppression, recovery, retired and unknown key rejection, rotated-key acceptance, and Catalog-derived authority despite forged tenant and role claims. Other focused tests seed JWK and auth rows through test-only routes. The separate packed chat smoke runs actual Better Auth anonymous sign-ins and token issue for two principals. Catalog auth DDL preserves constraints and indexes for new storage. Existing tables need exact matching `auth_ddl_v1` signatures; no versioned upgrade path exists.

Each server-generated connection id owns at most one in-flight `hello` or `updateAuth` operation. A duplicate receives retryable `CDB_RATE_LIMITED` before JWT verification, Catalog access, attachment mutation, or refresh chaining. Every outcome releases only the exact owning claim. An admitted `updateAuth` barrier remains visible to mutation and subscription admission while Gateway drains prior work, retires that connection's current durable registrations, and reports affected subscription ids through `mustRefetch`. It does not replay those subscriptions.

Socket close stores a rejected attachment and fences every post-await authentication step through verification, drain, alarm scheduling, retirement, invalidation, attachment mutation, and send. Late continuations cannot dispatch queued work or replace the rejected state. Failed refreshes also store a terminal rejected attachment before closing the socket.

The client option `mutationTimeoutMs` defaults to 60 seconds and covers the full pending lifetime, including reconnects. A reconnect resends a pending mutation with its original `mutId` without resetting the deadline. If that deadline expires, the promise rejects with nonretryable `CDB_MUTATION_OUTCOME_UNKNOWN` because the server may already have committed the mutation. A synchronous send failure, client close, session failure, or terminal server result clears the timer. `ChardbProvider` forwards the same option. The client does not expose a retry handle or automatically retry terminal errors.

The same pending-mutation map caps queued, in-flight, and reconnecting client work at 32 records. Mutation refs validate before admission. A valid 33rd request rejects immediately with retryable `CDB_RATE_LIMITED` before UUID allocation, timer creation, map insertion, or send. Reconnect preserves admitted ids and deadlines. Success, typed failure, timeout, synchronous send failure, client close, and session failure remove records and release capacity.

Mutation arguments must be strict JSON primitives, dense arrays, or plain or null-prototype objects with enumerable data properties. Validation rejects accessors without invoking getters, plus cycles, sparse or decorated arrays, unsupported prototypes, symbols, nonfinite numbers, negative zero, and other non-JSON values. Arguments accept the exact 512 KiB serialized UTF-8 boundary, at most 4,096 aggregate array elements and object properties, and 99 nested argument levels because the mutation envelope consumes one level of the wire decoder's 100-level budget. Mutation-specific violations return nonretryable `CDB_INVALID_ARGS`; the public wire decoder rejects a deeper envelope before Gateway mutation admission.

The client checks this contract before UUID allocation, timers, pending admission, or send. Gateway checks it before mutation admission or auth-refresh waiting. Trusted dispatch checks raw arguments before local routing or Catalog authorization and checks transformed arguments again before Catalog routing or Cdb selection. Cdb checks once more before descriptor lookup, recovery-alarm scheduling, handler execution, provisional op-log insertion, or domain SQL.

Mutation results accept the exact 512 KiB serialized JSON boundary. A fresh oversized result returns `CDB_INVARIANT` inside the atomic transaction before op-log finalization or the write-set hook. Its domain SQL and provisional op-log row roll back. Replay applies the same limit to the stored result. An oversized legacy row is rejected without running the handler or hook and without changing the stored row. Accepted results replay unchanged. The error guidance directs larger reads to a paginated query.

A newly executed atomic mutation accepts at most 256 successful typed write statements and 4,096 affected rows. The executor uses each statement's `total_changes()` delta so direct writes, trigger fanout, and foreign-key actions share the row cap. Either overflow is terminal `CDB_INVARIANT`: even if the handler catches it, later writes stay blocked and the stored violation aborts commit. Domain SQL and the provisional op-log row roll back, and the write-set hook does not run. An accepted replay bypasses the handler and these write counters.

Gateway admits at most 32 unsettled mutations per connection and 256 per Gateway object. Excess mutations receive retryable `CDB_RATE_LIMITED` before dispatch. Inbound WebSocket text frames are measured as UTF-8 before wire decoding. Gateway accepts the exact 1 MiB boundary and closes larger frames with code 1009.

The client keeps at most 64 active subscription records. A valid subscription over the cap throws retryable `CDB_RATE_LIMITED` synchronously before it consumes an id, changes state, or sends. Reconnect resends the same records. Unsubscribe releases one slot, and terminal session failure clears all records. A synchronous subscribe-send failure removes the new record so reconnect cannot revive it. A failed unsubscribe send closes the client session.

Nonduplicate snapshots accept up to 4,096 rows and the exact 512 KiB serialized JSON boundary. Canonical and cross-tab optimistic patch batches accept up to 4,096 items and 512 KiB. The client preflights a whole batch and every patch row before subscription lookup, and before cross-tab stringify. Every resulting row cache uses the snapshot row and byte caps. Optimistic history accepts up to 4,096 patches and 512 KiB. The client validates every affected subscription plan, commits all planned caches and histories, then invokes listeners. Malformed or oversized input closes the session with `CDB_INVARIANT` and no partial application. A same-cookie snapshot is re-acknowledged and ignored before sizing, so it cannot replace current rows or clear optimistic state.

For each Gateway connection and subscription id, one subscription attempt can be active and one replacement can wait behind it. Further duplicates receive retryable `CDB_RATE_LIMITED` before capacity SQL, query routing, Catalog reads, Cdb calls, or installation. Later duplicates cannot replace the accepted replacement payload. Route rejection and final scheduler errors are sent only while the attempt still owns the pending slot and its exact verified socket remains current, so replacement, unsubscribe, and close fence stale errors.

Each Gateway admits at most 256 aggregate current and pending logical registrations. It counts durable heads after restart, permits a same-key replacement without consuming another slot, and rejects a duplicate pending race. Excess work receives retryable `CDB_RATE_LIMITED` before query routing, Catalog reads, Cdb calls, or registration installation. Durable total bytes, presence state, other queues, slow-consumer backpressure, and retention watermarks remain incomplete.

Each auth mutation commits with every directly derivable old and new global, tenant, or principal epoch bump. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. Bulk updates and deletes preload matched rows to derive epoch scopes. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. These cases have Bun fake-Durable-Object coverage, not workerd coverage.

Fresh Cdb objects render domain tables and indexes from the configured Drizzle schema, record signatures, and reject drift. This does not migrate an existing shard. Inserts, updates, deletes, and full-row selects require schema-declared grants. Inserts and updates check writable columns; updates forbid authority-column changes. Updates, deletes, and selects AND tenant and self predicates with the caller's filter, including operations with no filter. Select results receive readable-column masks. Projections, joins, and other shapes that cannot yet be masked safely fail closed.

Application handlers can use only typed builders against registered `cdbTable` definitions. The wrapper rejects raw SQL, Drizzle session and client access, relational and count shortcuts, plain-table CRUD, insert-select, conflict methods, `returning`, and unsupported properties before or after policy attachment. For a supported full-row live query, Cdb conservatively records every `cdbTable` used at a `FROM` boundary and in tracked predicates or ordering. It compares those names with `intent.tables` before returning rows. Every terminal query execution records its actual typed predicate after the row-policy floor is applied. Each declared interval bundle's union must contain every observed range for its table and index, including executions whose rows the handler later discards. Direct and registered query results accept up to 4,096 top-level rows and the exact 512 KiB serialized JSON boundary. Registered execution enforces both limits only after its final active-generation fence. An excess result returns `CDB_INVARIANT` with guidance to limit rows or columns, or paginate. Raw or untracked predicates, embedded subqueries, and callback predicates or ordering fail closed. Projections, joins, grouping, and richer query shapes remain closed.

Gateway and Cdb derive the same static digest from the row and column policy metadata of the `cdbTable` names in the declared intent. The digest excludes arbitrary function source because closure text is not stable across builds. Both objects persist it as part of registered-query identity and mix it into the query hash. Gateway checks it before a dirty rerun and again before sending a staged snapshot. Cdb checks it before registered execution. A mismatch retires the generation instead of returning or sending rows under an old policy. Bootstrap retires legacy Gateway and Cdb registrations that have no digest. A quiet registration has no background policy scan, so it detects drift on its next invalidation, snapshot-send attempt, or other work trigger.

The chat example's sign-in hook reuses the shared demo organization and an existing membership for the user, then updates the session's active organization. Its `postMessage` mutation opts into the public path with an explicit ref and organization authority. The clean-tarball smoke proves the actual anonymous sign-in, hook, empty initial snapshot, mutation, live replacement, same-`mutId` replay, and independent readback. It signs in a second principal, moves that session to another organization, rejects its query against `demo-org`, and returns an empty snapshot for its own organization. Repeated sessions and concurrent bootstrap attempts do not blindly insert the same rows. The packed proof does not restart the Worker or Durable Objects.

Scatter routing asks Catalog for the distinct physical shards that own current ranges, but public scatter queries remain closed. The narrow organization path persists the exact Gateway generation, client and subscription identity, principal, organization, auth epochs, static table-policy digest, logical shard, physical Cdb, query identity, retry state, and delivery state. Cdb invalidations and Gateway cleanup and retry work survive Durable Object reconstruction.

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
bun test
bun run build
```

The workerd tests open local ports. Run them separately if the full test runner contends over Miniflare startup:

```bash
bun test test/workerd/catalog.harness.test.ts
bun test test/workerd/reshard.harness.test.ts
bun test test/workerd/gateway-live.harness.test.ts
```

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

The npm tarball contains built `dist` files and the public documents. It does not contain `src`. CI runs `chardb init` from that tarball in a temporary project, installs its pinned dependencies without workspace aliases, typechecks it, and runs a Wrangler dry-run build. CI then runs the packed chat smoke, which installs version 0.1.0 into another clean temporary consumer and proves the narrow sign-in-to-live slice. Domain migrations and broader recovery guarantees remain unfinished.

## License

MIT
