# chardb completion plan

Last reviewed: 2026-08-23

## What this project is

Chardb should do one thing well: a developer marks an organization boundary in a Drizzle schema, and chardb routes that organization's data to a SQLite Durable Object with tenant isolation, atomic mutations, idempotent retries, initial queries, and live updates.

The repository does not do that yet. It has good routing, colocation, op-log, policy, and resharding pieces around a missing domain-data execution path. The missing work is architectural. It is not a matter of connecting two existing functions.

Finish the organization-tenanted SQL path first. Stop presenting files, vectors, presence, streams, scheduling, cross-partition transactions, PITR, and automatic resharding as working product features. Keep that code as experimental work until the database path works.

## 1. Settle how mutations execute

The current design cannot work as written:

- [`Gateway.routeMut`](src/server/do/gateway.ts) calls `Cdb.mutate` over RPC with one serializable argument.
- [`Cdb.mutate`](src/server/do/cdb.ts) requires a second argument containing a local runner closure. RPC cannot transport that closure.
- [`defineMutation`](src/server/define.ts) now requires synchronous handlers, but the public RPC path does not invoke them.
- [`executeAtomicMutation`](src/server/atomic-mutation.ts) constructs the Drizzle database and commits handler SQL with the op-log, but Gateway and Cdb are not connected to it.

Do this work before touching the higher-level features:

- [x] Write a small workerd test that runs two domain SQL statements in one Durable Object mutation and throws after the second statement.
- [x] Prove that the failed mutation rolls back both statements and its op-log entry.
- [x] Decide whether the public mutation handler remains async or becomes synchronous.
- [x] Make mutation handlers and their argument validators synchronous so they can run inside `transactionSync`.
- [x] Put the application manifest and schema in the Cdb isolate through a configured subclass.
- [x] Remove the runner closure from the Cdb RPC contract.
- [x] Make `Cdb.mutate` accept one serializable request containing `ref`, validated `args`, `mutId`, auth context, and schema epoch.
- [ ] Only construct that request from verified auth and server-derived tenant membership.
- [x] Resolve the mutation reference inside the owning Cdb isolate.
- [x] Construct a real Drizzle database over a Cdb `SqlStorage` inside the atomic executor.
- [x] Construct `MutationCtx` with that Drizzle database and an auth context inside the atomic executor.
- [x] Invoke the handler inside the chosen transaction boundary.
- [x] Return the handler's exact result. Do not reconstruct it from `returning[0]`.
- [x] Validate that mutation results are JSON before committing them.
- [x] Store the exact result in the op-log replay envelope.
- [x] Return that stored result when the client repeats the same `mutId`.
- [x] Keep collision detection for a repeated `mutId` with different arguments.
- [ ] Make every error path settle the client mutation promise.

## 2. Make runtime registration and routing coherent

The package currently has three incompatible ideas about how requests reach user code. The Worker entrypoint owns the manifest, the Gateway needs a worker service binding, and the Cdb needs to execute the handler locally.

- [ ] Choose one owner for partition extraction and manifest lookup.
- [ ] Give the Gateway a typed RPC interface instead of local `as unknown as` method shapes.
- [ ] Rename the generated service binding to the name the Gateway actually reads, or change the Gateway to read the generated name.
- [ ] Point that binding at the application Worker entrypoint, not the `Cdb` class.
- [ ] Add the same binding to the chat Wrangler configuration.
- [ ] Make `chardb doctor` verify the real binding name and entrypoint.
- [ ] Remove the current `runMutation` response that only returns a vshard while dropping `mutId` and auth.
- [ ] Pass the verified tenant-derived partition key through routing.
- [ ] Read the current routing table and schema epoch from Catalog before invoking Cdb.
- [ ] Define typed request and response interfaces once and share them across Gateway, entrypoint, Catalog, and Cdb.
- [ ] Catch Worker, Catalog, and Cdb RPC failures in `Gateway.routeMut` and translate them to the existing typed error set.
- [ ] Use `isRetryable` when building wire errors instead of marking every error non-retryable.

Stable references also need repair:

- [x] Teach the Vite transform to recognize `api.mutation` and `api.query`, not only direct `defineMutation` and `defineQuery` calls.
- [x] Stamp references from module path and export name.
- [x] Fail the build on duplicate references.
- [x] Add a test with at least two config-form mutations and two config-form queries in one application.
- [ ] Prove that client references match the server manifest after a production build.

## 3. Create and migrate domain tables

Cdb currently creates internal tables and partial auth tables. It never creates the user's domain tables. The migration command only prints or loops over caller-supplied SQL.

- [ ] Pick one migration input format. The sensible choice is the Drizzle migration journal and SQL files.
- [ ] Make the Vite plugin or CLI package the migration journal with the Worker build.
- [ ] Store the active schema version and epoch in Catalog.
- [ ] Apply all required migrations when a new Cdb shard starts.
- [ ] Apply pending migrations to existing shards.
- [ ] Record migration progress per shard so retries do not repeat completed work.
- [ ] Refuse queries and mutations when a shard's schema epoch does not match the routed request.
- [ ] Preserve primary keys, unique constraints, foreign keys, indexes, defaults, and column types. The current auth DDL drops most of these.
- [ ] Replace `chardb migrate` output that says "would apply" with real execution and a nonzero exit on failure.
- [ ] Add a fresh-database test that starts with no domain tables, applies migrations, restarts the Durable Objects, and reads the migrated schema.
- [ ] Add an upgrade test that applies a second migration without losing existing rows.

Online schema changes can wait. A maintenance-mode migration is enough for the first working version, as long as it is explicit and does not pretend to be online.

## 4. Simplify and fix auth storage

The Better Auth adapter is not ready to back a session flow. Several ordinary lookups do not contain the configured partition column, and the generated table DDL loses constraints and indexes.

- [ ] Put all Better Auth tables in Catalog for the first working version.
- [ ] Remove auth sharding until normal sign-in, session lookup, organization membership, logout, and token issuance work across restarts.
- [ ] Eagerly bind the auth schema before Cdb or Catalog bootstrap marks itself complete.
- [ ] Generate complete auth DDL from the synthesized schema.
- [ ] Preserve unique constraints required for email, session token, provider account, membership, and plugin tables.
- [ ] Preserve foreign keys and indexes.
- [ ] Make date serialization agree with the adapter's `supportsDates` claim.
- [ ] Implement adapter transactions for multi-write auth operations, or state and enforce the smaller supported auth profile.
- [ ] Add integration tests for sign-up or anonymous sign-in, session lookup by token, organization creation, membership lookup, active organization selection, logout, and restart recovery.
- [ ] Add one configured Better Auth plugin only after the core flow works.

## 5. Make authentication a real trust boundary

Gateway currently parses unsigned JWT bytes and stores their tenant and role claims as auth state. `verifyJwt` exists but has no production caller.

- [ ] Verify the JWT signature before storing `principalId`, tenant, role, or custom claims.
- [ ] Pin issuer, audience, accepted algorithms, and clock tolerance.
- [ ] Resolve JWKS through Catalog and handle key rotation.
- [ ] Reject missing, malformed, tampered, expired, and not-yet-valid tokens.
- [ ] Handle the existing `updateAuth` wire message so a live socket can refresh its credentials.
- [ ] Recheck token expiry before every mutation and protected subscription.
- [ ] Stop deriving a principal from `clientId` for protected requests.
- [ ] Derive active organization membership and role from trusted server state. Do not accept a caller-supplied organization argument as authority.
- [ ] Build `ctx.auth` only after verification and membership resolution.
- [ ] Define the anonymous query behavior explicitly.
- [ ] Add tests for tampered tokens, expired tokens, wrong audience, revoked membership, changed role, and a socket that outlives its token.

## 6. Replace the policy engine before wiring it in

The current policy helpers are unused by production code. Their semantics are also wrong:

- No matching policy means no restriction, which is default allow.
- Separate role policies are combined with `AND`, so a valid member can be required to also be an admin.
- The database proxy only autofills omitted insert fields. It does not stop explicit tenant overrides or protect selects, updates, deletes, and raw SQL.

Replace that behavior with one explicit rule:

`mandatory tenant predicate AND one matching row grant AND allowed columns`

Implement it as follows:

- [ ] Compile every `cdbTable` into one operation-specific authorization plan.
- [ ] Make private tables default deny for anonymous and authenticated callers without a matching grant.
- [ ] Apply the tenant predicate to select, insert, update, and delete.
- [ ] Combine alternative roles with `OR`.
- [ ] Combine the tenant predicate with the chosen role or self grant using `AND`.
- [ ] Treat `publicRead` as a select-only grant. It must not weaken writes.
- [ ] Reject an explicit tenant or owner value that conflicts with verified auth.
- [ ] Autofill tenant and self columns only after checking the incoming payload.
- [ ] Apply writable-column checks to inserts and updates.
- [ ] Apply readable-column masks to query results.
- [ ] Block or remove raw SQL from application handlers until it has a safe policy story.
- [ ] Remove unused policy-digest and auth-epoch claims, or wire them into actual subscription identity and invalidation.
- [ ] Add hostile two-tenant tests for every CRUD operation.
- [ ] Test admin, member, self, public read, no matching role, forbidden columns, explicit tenant override, and membership revocation.

## 7. Implement queries instead of subscription registration

The subscription wire message contains an intent and hash but no query reference or arguments. The server therefore cannot invoke `defineQuery`. `Cdb.subscribe` only registers intervals and never returns rows.

- [ ] Change the wire protocol so `sub` carries the query reference and raw arguments.
- [ ] Increment the protocol version.
- [ ] Validate query arguments with the query's Standard Schema validator.
- [ ] Resolve the query reference inside the Cdb isolate.
- [ ] Recompute the query intent on the server. Do not trust the client's intent or query hash.
- [ ] Route organization queries using the verified tenant and the server-computed intent.
- [ ] Construct `QueryCtx` with a read database and verified auth.
- [ ] Apply row and column policies during query execution.
- [ ] Execute the query handler.
- [ ] Send an explicit initial snapshot, including an empty snapshot.
- [ ] Move the client subscription from `pending` to `live` when that snapshot arrives.
- [ ] Define ordering and stable row keys for collection results.
- [ ] Reject unsupported cross-partition queries instead of silently scattering them.
- [ ] Remove the requirement that users manually keep a query handler and intent extractor equivalent, or verify that equivalence during the build.

## 8. Implement live updates with simple invalidation first

Do not start with incremental row patches. Re-run the affected query after a commit and send a replacement snapshot. Optimize after this is correct.

- [ ] Give every shard subscription a composite identity containing Gateway, client, and subscription IDs. Numeric `subId` alone collides across clients.
- [ ] Persist shard subscription registrations.
- [ ] Rebuild the in-memory interval index after a Cdb restart.
- [ ] Include query reference, arguments, verified principal, tenant, auth epoch, and last delivered cookie in the persisted record.
- [ ] Record touched tables for every committed mutation.
- [ ] Notify the relevant Gateway after a commit.
- [ ] Re-run subscriptions whose table set intersects the touched tables.
- [ ] Send replacement snapshots with a new cookie.
- [ ] Coalesce repeated invalidations while a query is already running.
- [ ] Remove dead `matchSubsForRow` and patch-queue code if replacement snapshots supersede it.
- [ ] Add a two-client test in which one client posts and the other receives the updated query result.
- [ ] Restart both Gateway and Cdb during the test and prove subscriptions can recover.

## 9. Define reconnect, retry, and failure behavior

The current cookie is a generated string, not a replay coordinate. Resume does not replay missed changes. Mutation RPC exceptions can leave promises pending forever.

- [ ] Define what a cookie identifies and where its replay data lives.
- [ ] Either implement replay from a valid cookie or always issue `mustRefetch` after reconnect.
- [ ] Do not claim read-your-writes resume until missed updates can actually be recovered.
- [ ] Add mutation timeouts and retry only errors marked retryable.
- [ ] Reuse the same `mutId` when retrying the same mutation.
- [ ] Never store an empty cookie from a failed mutation.
- [ ] Return typed errors for malformed messages instead of accepting any object with a known `t` field.
- [ ] Validate every wire message field.
- [ ] Bound pending mutations, subscriptions, patch queues, and presence state.
- [ ] Apply backpressure or disconnect slow consumers.
- [ ] Make disconnect and shutdown reject or retain pending mutations according to a documented rule.
- [ ] Add failure tests for Worker RPC errors, Catalog errors, shard eviction, socket loss before acknowledgment, duplicate delivery, stale schema epoch, and protocol mismatch.

## 10. Make one real example

The current chat directory is not a runnable example. It imports unsupported package subpaths, omits dependencies, uses a partition extractor that always returns `undefined`, and documents APIs that were deleted.

- [ ] Add `example/chat` to the workspace or make it install the packed tarball.
- [ ] Declare every dependency used by the example.
- [ ] Replace `chardb/react/index.ts` with `chardb/react`.
- [ ] Replace `chardb/vite/index.ts` with `chardb/vite`.
- [ ] Fix the mutation partition key. Derive routing from verified organization tenancy rather than `() => undefined`.
- [ ] Delete stale `tenantScope`, `ownerScope`, and `requirePermission` documentation.
- [ ] Generate the example schema through real migrations.
- [ ] Make sign-in establish an active organization and membership.
- [ ] Make posting a message use the real mutation path.
- [ ] Make opening a channel return a persisted initial query result.
- [ ] Make a second browser receive the live replacement result.
- [ ] Add an organization switch and prove data isolation.
- [ ] Build and run the example against the packed package, not TypeScript path aliases or source imports.
- [ ] Add one workerd test that crosses the real WebSocket, Gateway, Worker, Catalog, Cdb, auth, policy, mutation, query, and live-update paths.
- [ ] Do not use test-only raw SQL RPCs or fabricated `poke` messages in that test.

## 11. Repair the CLI and local setup

- [ ] Rewrite `chardb init` to generate `forOrg`, `cdbTable`, current auth setup, current API helpers, and the actual Wrangler bindings.
- [ ] Make the generated project install and build without this monorepo.
- [ ] Make `doctor` report unimplemented checks as failures, not success.
- [ ] Wire the advertised `explain` command into command dispatch.
- [ ] Remove `shards`, `export`, `schedule`, `snapshot`, `restore`, and `deploy` from help until they perform their advertised work.
- [ ] Remove reserved HTTP routes that only return 501.
- [ ] Remove placeholder React hooks from public exports until implemented.
- [ ] Remove placeholder file and vector APIs from the main product description.
- [ ] Make local Miniflare tests run deterministically in the full suite without port conflicts or hanging processes.
- [ ] Add one command that starts the example locally with migrations applied.

## 12. Fix package and repository hygiene

- [ ] Add the MIT `LICENSE` file.
- [ ] Correct the repository URL to `zpg6/chardb`.
- [ ] Add `bugs` and correct homepage metadata.
- [ ] Move `hono` to runtime dependencies or an explicit required peer.
- [ ] Add direct metadata for `@standard-schema/spec` and every package referenced by emitted declarations.
- [ ] Remove unused dependencies such as `ulid` if the source does not import them.
- [ ] Declare the supported Bun and Node versions.
- [ ] Choose one lockfile policy.
- [ ] Stop tracking generated landing `.js`, `.d.ts`, and `.tsbuildinfo` files.
- [ ] Add `prepack` so a clean package build always produces `dist`.
- [ ] Fail the package build on warnings.
- [ ] Stop publishing all of `src` unless there is a concrete consumer need.
- [ ] Include the license and public documentation in the tarball.
- [ ] Create an empty consumer fixture that installs the tarball and imports every advertised subpath.
- [ ] Test runtime imports and declarations without workspace hoisting.
- [ ] Fix all Biome errors and warnings, or narrow the lint inputs deliberately and document why.
- [ ] Add CI for frozen install, typecheck, lint, unit tests, serialized workerd tests, package build, package consumer test, landing build, and example build.
- [ ] Run a full-history secret scan before changing repository visibility.

## 13. Rewrite the public story

The current landing page describes a product that does not exist. Fix the code first, but do not leave the current claims live while doing it.

- [ ] Change the README and landing page to call chardb an experimental prototype.
- [ ] Lead with schema-derived organization tenancy and per-tenant transactions.
- [ ] Remove "Unlimited SQL."
- [ ] Remove the 160 TB claim.
- [ ] Remove automatic online-resharding claims until the runtime performs and tests the whole flow.
- [ ] Remove working files, vectors, search, presence, scheduling, and migration claims.
- [ ] Remove the fake `[[chardb]]` binding and nonexistent `client(env.DB)` example.
- [ ] Remove the npm install command until the package is published.
- [ ] Replace dead Docs links with real documents.
- [ ] Replace `HANDOFF.md` with public status documentation, or keep it out of the public repository.
- [ ] Add an architecture document that explains Worker, Gateway, Catalog, Cdb, transaction ownership, schema migration, auth verification, and subscription invalidation.
- [ ] Add a status table that distinguishes implemented, tested in isolation, wired end to end, and experimental.
- [ ] Keep every feature claim tied to a test that exercises the real runtime path.

## 14. Work that stays deferred

Do not work on these until the organization-tenanted mutation, query, and live-update path is working through the packed package:

- Files and R2 upload lifecycle
- Vector search and Vectorize integration
- Presence
- Streams
- Cron and scheduling
- Global secondary indexes
- Cross-partition transactions
- Scatter-gather queries
- Automatic online resharding
- PITR, snapshot, restore, and export
- Ledger and Logpush integration
- Dashboard
- Multiple validator adapters
- User-tenanted and global-table modes
- Stable wire compatibility promises
- Storage-capacity marketing numbers

Useful pure helpers and specs can remain in the repository. Keep them out of the supported product path and stop letting them substitute for the missing database runtime.
