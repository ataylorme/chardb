# chardb completion plan

Last reviewed: 2026-08-23

## What this project is

Chardb should do one thing well: a developer marks an organization boundary in a Drizzle schema, and chardb routes that organization's data to a SQLite Durable Object with tenant isolation, atomic mutations, idempotent retries, initial queries, and live updates.

The repository does not do that yet. It can bootstrap domain tables, execute isolated shard-local writes and reads, and enforce insert, update, and delete policy rules. The public auth, routing, query-delivery, and live-update path is still disconnected.

Finish the organization-tenanted SQL path first. Stop presenting files, vectors, presence, streams, scheduling, cross-partition transactions, PITR, and automatic resharding as working product features. Keep that code as experimental work until the database path works.

## 1. Settle how mutations execute

The trusted mutation dispatcher now resolves the server manifest, routes through Catalog, and sends one serializable request to Cdb. Cdb resolves the handler and commits its SQL with the op-log inside one synchronous transaction. Gateway verifies WebSocket identity, but it cannot construct the trusted mutation request until Catalog-derived membership, role, and policy authority are connected. Client promise settlement also needs failure coverage.

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

The configured Gateway now owns partition extraction and manifest lookup. It routes through Catalog, then sends a serializable request to the configured Cdb. The remaining routing problem is trust. The partition key must come from verified tenant state rather than caller-controlled arguments.

- [x] Make the configured Gateway own partition extraction and manifest lookup.
- [x] Define typed routing, Catalog, and Cdb mutation interfaces in one shared module.
- [x] Remove the invalid Worker service self-binding from generated and example Wrangler configuration.
- [x] Make `chardb doctor` validate the Durable Object bindings without requiring a service self-binding.
- [x] Remove the Worker `runMutation` RPC that returned only a vshard while dropping `mutId` and auth.
- [ ] Pass the verified tenant-derived partition key through routing.
- [x] Read the current routing table and schema epoch from Catalog before invoking Cdb.
- [x] Catch local routing, Catalog, and Cdb failures and translate them to typed mutation responses.
- [x] Preserve each error code's retryable flag and documentation URL in mutation wire responses.

Stable references also need repair:

- [x] Teach the Vite transform to recognize `api.mutation` and `api.query`, not only direct `defineMutation` and `defineQuery` calls.
- [x] Stamp references from module path and export name.
- [x] Fail the build on duplicate references.
- [x] Add a test with at least two config-form mutations and two config-form queries in one application.
- [ ] Prove that client references match the server manifest after a production build.

## 3. Create and migrate domain tables

Cdb now renders the configured `cdbTable` schema on first startup, creates new domain tables and indexes, records signatures, and rejects unsigned or mismatched existing layouts. This is fresh-shard bootstrap, not migration. It cannot upgrade a shard that already contains an older domain schema.

- [x] Render and create configured domain tables and indexes when a fresh Cdb starts.
- [x] Preserve supported primary keys, unique constraints, local foreign keys, indexes, defaults, nullability, and SQLite column types during bootstrap.
- [x] Record domain schema signatures and reject unsigned, changed, or incomplete existing layouts.
- [x] Omit authority foreign keys to Catalog-owned auth tables, and reject other nonlocal domain foreign keys.

- [ ] Pick one migration input format. The sensible choice is the Drizzle migration journal and SQL files.
- [ ] Make the Vite plugin or CLI package the migration journal with the Worker build.
- [ ] Store the active schema version and epoch in Catalog.
- [ ] Replace bootstrap-only table creation with an explicit migration sequence when a new Cdb shard starts.
- [ ] Apply pending migrations to existing shards.
- [ ] Record migration progress per shard so retries do not repeat completed work.
- [ ] Refuse queries and mutations when a shard's schema epoch does not match the routed request.
- [ ] Preserve the bootstrap DDL guarantees through every versioned domain migration.
- [ ] Replace `chardb migrate` output that says "would apply" with real execution and a nonzero exit on failure.
- [ ] Add a fresh-database test that starts with no domain tables, applies migrations, restarts the Durable Objects, and reads the migrated schema.
- [ ] Add an upgrade test that applies a second migration without losing existing rows.

Online schema changes can wait. A maintenance-mode migration is enough for the first working version, as long as it is explicit and does not pretend to be online.

## 4. Simplify and fix auth storage

The Better Auth adapter keeps every synthesized model in Catalog, so ordinary lookups no longer depend on a shard partition column. Catalog now renders constraint-complete table and index DDL from the synthesized schema. Existing tables must carry the matching `auth_ddl_v1` signature; there is no versioned upgrade path. Each auth mutation and every directly derivable old and new global, tenant, or principal epoch bump commit in one Catalog transaction. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`, and no complete sign-in flow has run through the public application path.

- [x] Put all Better Auth tables in Catalog for the first working version.
- [x] Remove auth sharding from the adapter and Cdb storage path.
- [x] Bind the auth runtime during application-module initialization in every Worker and Durable Object isolate, and let Catalog retry auth-table bootstrap if it started before that binding.
- [x] Test create and routine lookup by email, session token, provider/account key, and membership field, plus update, delete, rollback, and same-storage Catalog reconstruction in a Bun fake-Durable-Object harness.
- [x] Generate auth table and index DDL from the synthesized Drizzle schema, preserving keys, uniqueness, foreign keys, indexes, defaults, nullability, and SQLite types.
- [x] Reject existing auth tables without matching `auth_ddl_v1` signatures instead of treating `CREATE TABLE IF NOT EXISTS` as an upgrade.
- [ ] Add a versioned upgrade path for existing auth signatures instead of requiring pre-release Catalog recreation.
- [x] Commit each auth write and every directly derivable old and new global, tenant, or principal epoch bump in one Catalog transaction.
- [ ] Add placement metadata or explicit epoch-scope rules for indirect plugin relationships that lack conventional `organizationId` or `userId` fields.
- [ ] Bound or replace the matched-row preload used to derive epoch scopes for bulk updates and deletes.
- [x] Make date and boolean serialization agree with the adapter's capability claims.
- [ ] Implement adapter transactions for multi-write auth operations, or state and enforce the smaller supported auth profile.
- [ ] Add integration tests for sign-up or anonymous sign-in, session lookup by token, organization creation, membership lookup, active organization selection, and logout.
- [ ] Add a real workerd test that restarts the configured Catalog isolate and proves auth bootstrap and stored sessions survive.
- [ ] Add one configured Better Auth plugin only after the core flow works.

## 5. Make authentication a real trust boundary

The configured Gateway verifies JWT signatures and registered claims during `hello` and `updateAuth`. Its attachment stores only verified subject and time bounds. Verified identity is not tenant authority, so mutations, subscriptions, and presence remain fail-closed until Catalog-derived membership, role, and policy state are attached.

- [x] Verify the JWT signature before storing `principalId`; do not copy tenant, role, or custom claims into the verified attachment.
- [x] Pin issuer, audience, and accepted algorithms from the configured Better Auth JWT plugin, with a bounded 30-second default clock tolerance.
- [x] Resolve JWKS through the Catalog-backed resolver contract.
- [ ] Prove outbound JWKS fetch, key rotation, and cache refresh through the configured Gateway path.
- [x] Reject missing, malformed, tampered, expired, not-yet-valid, wrong-issuer, wrong-audience, and disallowed-algorithm tokens.
- [x] Handle `updateAuth`, replace the verified subject only after successful verification, and invalidate existing subscriptions.
- [x] Recheck token time bounds before every mutation, subscription, and presence operation.
- [x] Stop deriving a principal from `clientId` for protected requests.
- [ ] Derive active organization membership and role from trusted server state. Do not accept a caller-supplied organization argument as authority.
- [ ] Build `ctx.auth` only after verification and membership resolution.
- [ ] Define the anonymous query behavior explicitly.
- [x] Test real signed tokens, tampering, expiry, not-before, issuer, audience, algorithm, subject refresh, and the Catalog resolver contract.
- [x] Test the configured Gateway WebSocket dispatch under workerd with real Catalog SQLite cache and ES256 tokens.
- [ ] Add tests for revoked membership, changed role, and a socket that outlives its membership authority.

## 6. Finish policy enforcement

The database proxy now applies one explicit rule to inserts, updates, and deletes:

`mandatory tenant predicate AND one matching row grant AND allowed columns`

- [x] Compile each `cdbTable` role matrix into operation-specific row grants and column rules.
- [x] Make inserts, updates, and deletes default deny when no matching grant applies.
- [x] Apply tenant and self predicates to inserts, updates, and deletes.
- [x] Combine alternative role grants with `OR`.
- [x] Combine the tenant or self floor with caller update and delete filters using `AND`, including operations without an explicit `where`.
- [x] Compile `publicRead` as a select-only grant. Do not apply it to writes.
- [x] Reject conflicting insert authority and make managed tenant and self columns immutable during updates.
- [x] Autofill tenant and self columns only from verified auth.
- [x] Apply writable-column checks to inserts and updates.
- [ ] Apply the same default-deny row policy to selects.
- [ ] Apply readable-column masks to query results.
- [ ] Block or remove raw SQL from application handlers until it has a safe policy story.
- [ ] Remove unused policy-digest and auth-epoch claims, or wire them into actual subscription identity and invalidation.
- [ ] Add hostile two-tenant tests for every CRUD operation.
- [ ] Test admin, member, self, public read, no matching role, forbidden columns, explicit tenant override, and membership revocation.

## 7. Implement queries instead of subscription registration

Protocol v3 subscriptions send a query reference and raw arguments. Gateway validates the arguments and derives routing intent from its local server manifest. Separately, Cdb can resolve and execute a query handler through an isolated shard-local RPC with a read-only Drizzle wrapper and JSON result validation. The public subscription path does not call that RPC or send its result.

- [x] Change the wire protocol so `sub` carries the query reference and raw arguments.
- [x] Increment the protocol version and enforce it during `hello` and `welcome`.
- [x] Validate query arguments with the query's Standard Schema validator before intent extraction.
- [x] Resolve the query reference inside the Cdb isolate.
- [x] Recompute the query intent on the server. Do not trust the client's intent or query hash.
- [ ] Canonicalize query identity and include the query ref, validated arguments, verified principal, tenant, auth epoch, and policy epoch.
- [ ] Route organization queries using the verified tenant and the server-computed intent.
- [x] Enumerate distinct current Catalog shard ids for scatter routing instead of probing virtual shards.
- [x] Construct `QueryCtx` with a read-only database and the auth carried by the internal request.
- [ ] Apply row and column policies during query execution.
- [x] Execute the query handler inside Cdb and reject non-JSON results.
- [x] Add an explicit protocol-v3 snapshot envelope, including empty row arrays, and replace client subscription state when it arrives.
- [ ] Send an explicit initial snapshot, including an empty snapshot.
- [x] Move the client subscription from `pending` to `live` when a valid snapshot arrives.
- [ ] Define ordering and stable row keys for collection results.
- [ ] Reject unsupported cross-partition queries instead of silently scattering them.
- [ ] Remove the requirement that users manually keep a query handler and intent extractor equivalent, or verify that equivalence during the build.

## 8. Implement live updates with simple invalidation first

Do not start with incremental row patches. Re-run the affected query after a commit and send a replacement snapshot. Optimize after this is correct.

- [x] Give every shard subscription a composite identity containing Gateway, client, and subscription IDs.
- [x] Persist the composite identity, principal, query ref, arguments, tables, and intervals for each shard registration.
- [x] Rebuild the in-memory interval index from SQLite when Cdb starts.
- [ ] Add verified tenant, auth epoch, policy epoch, and last delivered cookie to the persisted record.
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
- [x] Return typed errors for malformed messages instead of accepting any object with a known `t` field.
- [x] Validate every wire message field.
- [ ] Bound pending mutations, subscriptions, patch queues, and presence state.
- [ ] Apply backpressure or disconnect slow consumers.
- [ ] Make disconnect and shutdown reject or retain pending mutations according to a documented rule.
- [ ] Add failure tests for Worker RPC errors, Catalog errors, shard eviction, socket loss before acknowledgment, duplicate delivery, stale schema epoch, and protocol mismatch.

## 10. Make one real example

The chat directory now consumes the packed package and passes compile-time checks. It is not runnable end to end because domain migrations, verified auth, initial queries, and live updates remain incomplete.

- [x] Install the package through npm's packed file-dependency path with a committed consumer lockfile.
- [x] Declare every dependency used by the example.
- [x] Replace `chardb/react/index.ts` with `chardb/react`.
- [x] Replace `chardb/vite/index.ts` with `chardb/vite`.
- [x] Give `postMessage` a concrete organization partition key and reject an auth tenant mismatch.
- [x] Delete stale `tenantScope`, `ownerScope`, and `requirePermission` documentation.
- [ ] Generate the example schema through real migrations.
- [x] Add an auth hook that provisions the demo organization and membership, then sets the active organization.
- [ ] Make posting a message use the real mutation path.
- [ ] Make opening a channel return a persisted initial query result.
- [ ] Make a second browser receive the live replacement result.
- [ ] Add an organization switch and prove data isolation.
- [x] Install, typecheck, and build the example against the packed package instead of TypeScript aliases or source imports.
- [ ] Add one workerd test that crosses the real WebSocket, Gateway, Worker, Catalog, Cdb, auth, policy, mutation, query, and live-update paths.
- [ ] Do not use test-only raw SQL RPCs or fabricated `poke` messages in that test.

## 11. Repair the CLI and local setup

- [x] Rewrite `chardb init` to generate `forOrg`, `cdbTable`, current auth setup, current API helpers, and the actual Wrangler bindings.
- [x] Make the generated project install, typecheck, and pass a Wrangler dry-run build from the packed tarball without workspace aliases.
- [x] Make `doctor` report unimplemented checks as failures, not success.
- [x] Wire the advertised `explain` command into command dispatch.
- [x] Keep unfinished commands visible only when help labels them `not implemented`, and make invocation exit nonzero.
- [x] Remove reserved HTTP routes that only return 501.
- [x] Remove placeholder React hooks from public exports until implemented.
- [x] Remove placeholder file and vector APIs from the main product description.
- [x] Run each workerd harness in a separate sequential CI process to avoid shared Miniflare ports.
- [ ] Add one command that starts the example locally with migrations applied.

## 12. Fix package and repository hygiene

- [x] Add the MIT `LICENSE` file.
- [x] Correct the repository URL to `zpg6/chardb`.
- [x] Add `bugs` and correct homepage metadata.
- [x] Move `hono` to runtime dependencies.
- [x] Add direct metadata for `@standard-schema/spec` and packages referenced by emitted validator, auth, and React declarations.
- [x] Remove the unused `ulid` dependency.
- [x] Declare Bun 1.2.22 as the package-manager baseline.
- [ ] Decide whether Node is supported and declare its version if so.
- [x] Use `bun.lock` at the root and keep `package-lock.json` only for the npm consumer fixture.
- [x] Stop tracking generated landing `.js`, `.d.ts`, and `.tsbuildinfo` files.
- [x] Add `prepack` so a clean package build always produces `dist`.
- [x] Fail the package build on warnings.
- [x] Stop publishing all of `src` unless there is a concrete consumer need.
- [x] Include `LICENSE` and `README.md` in the tarball.
- [x] Include `STATUS.md`, `ARCHITECTURE.md`, `SECURITY.md`, and `CONTRIBUTING.md` in the tarball.
- [x] Create an empty consumer fixture that installs the tarball and imports every advertised subpath.
- [x] Test the chat consumer's runtime imports and declarations from the packed package without workspace hoisting.
- [x] Fix all Biome errors and warnings, or narrow the lint inputs deliberately and document why.
- [x] Add CI for frozen install, typecheck, lint, unit tests, serialized workerd tests, package build, package consumer test, landing build, and example build.
- [x] Upgrade compatible `nanoid`, PostCSS, Sharp, SVGO, and `ws` dependency paths past their published advisories.
- [ ] Upgrade Miniflare when a compatible stable release stops pinning vulnerable `undici@7.28.0`; do not hide the advisory with an override.
- [ ] Run a full-history secret scan before changing repository visibility.

## 13. Rewrite the public story

The README and landing page now describe the repository as an experiment. Keep each claim within the boundaries recorded in the public status documents.

- [x] Change the README and landing page to call chardb an experimental prototype.
- [x] Lead with schema-derived organization tenancy and per-tenant transactions.
- [x] Remove "Unlimited SQL."
- [x] Remove the 160 TB claim.
- [x] Stop presenting automatic online resharding as supported and label it unfinished.
- [x] Label files, vectors, search, presence, scheduling, and migrations as unsupported or experimental.
- [x] Remove the fake `[[chardb]]` binding and nonexistent `client(env.DB)` example.
- [x] Remove unpublished-package install commands from the README and landing page.
- [x] Replace dead Docs links with links to repository documents.
- [x] Replace internal engineering notes with public status documentation.
- [x] Add an architecture document that explains Worker, Gateway, Catalog, Cdb, transaction ownership, schema migration, auth verification, and subscription invalidation.
- [x] Add a status table that distinguishes implemented, tested in isolation, wired end to end, and experimental.
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
