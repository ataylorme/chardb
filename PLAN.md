# chardb completion plan

Last reviewed: 2026-08-23

## What this project is

Chardb should do one thing well: a developer marks an organization boundary in a Drizzle schema, and chardb routes that organization's data to a SQLite Durable Object with tenant isolation, atomic mutations, idempotent retries, initial queries, and live updates.

The repository now proves that narrow path under workerd. A declared organization mutation crosses Gateway, Catalog, and Cdb. An explicit stable-ref query with `authority: "organization"` can register against one exact partition, receive an initial snapshot, rerun after a matching commit, and receive a replacement snapshot. The clients acknowledge delivery, and the Cdb invalidation outbox drains. A reconstruction test evicts Gateway and Cdb with a hibernated socket and a staged snapshot, then completes delivery after both objects restart. A clean-tarball smoke proves same-`mutId` replay and denial between two principals in different organizations. Resume cookies still do not replay missed changes.

Finish the organization-tenanted SQL path first. Stop presenting files, vectors, presence, streams, scheduling, cross-partition transactions, PITR, and automatic resharding as working product features. Keep that code as experimental work until the database path works.

## 1. Settle how mutations execute

The public mutation path is open only for definitions with an explicit stable ref and `authority: "organization"`. Gateway verifies the JWT subject, validates and transforms raw arguments once, extracts the organization partition, and asks Catalog to re-derive membership, role, roles, and auth epochs. Cdb treats the resulting RPC as trusted post-validation input, resolves the validated handler, and commits its policy-wrapped SQL with the op-log inside one synchronous transaction.

- [x] Write a small workerd test that runs two domain SQL statements in one Durable Object mutation and throws after the second statement.
- [x] Prove that the failed mutation rolls back both statements and its op-log entry.
- [x] Decide whether the public mutation handler remains async or becomes synchronous.
- [x] Make mutation handlers and their argument validators synchronous so they can run inside `transactionSync`.
- [x] Put the application manifest and schema in the Cdb isolate through a configured subclass.
- [x] Remove the runner closure from the Cdb RPC contract.
- [x] Make `Cdb.mutate` accept one serializable request containing `ref`, validated `args`, `mutId`, auth context, and schema epoch.
- [x] Construct public organization mutation requests only from a verified JWT subject and current Catalog-derived membership, roles, and auth epochs.
- [x] Resolve the mutation reference inside the owning Cdb isolate.
- [x] Construct a real Drizzle database over a Cdb `SqlStorage` inside the atomic executor.
- [x] Construct `MutationCtx` with that Drizzle database and an auth context inside the atomic executor.
- [x] Invoke the handler inside the chosen transaction boundary.
- [x] Return the handler's exact result. Do not reconstruct it from `returning[0]`.
- [x] Validate that mutation results are JSON before committing them.
- [x] Store the exact result in the op-log replay envelope.
- [x] Return that stored result when the client repeats the same `mutId`.
- [x] Keep collision detection for a repeated `mutId` with different arguments.
- [x] Settle admitted public mutations once across local routing, Catalog authority and routing, Cdb RPC, malformed response, and policy failures.

## 2. Make runtime registration and routing coherent

The configured Gateway owns partition extraction and manifest lookup. For a declared organization mutation, it validates and transforms raw arguments once before extracting the partition key. Catalog must confirm that the verified JWT subject currently belongs to that exact organization before routing continues.

- [x] Make the configured Gateway own partition extraction and manifest lookup.
- [x] Define typed routing, Catalog, and Cdb mutation interfaces in one shared module.
- [x] Remove the invalid Worker service self-binding from generated and example Wrangler configuration.
- [x] Make `chardb doctor` validate the Durable Object bindings without requiring a service self-binding.
- [x] Remove the Worker `runMutation` RPC that returned only a vshard while dropping `mutId` and auth.
- [x] Route with the organization extracted from validated arguments only after Catalog confirms the verified subject's membership in it.
- [x] Read the current routing table and schema epoch from Catalog before invoking Cdb.
- [x] Catch local routing, Catalog, and Cdb failures and translate them to typed mutation responses.
- [x] Preserve each error code's retryable flag and documentation URL in mutation wire responses.

Stable references also need repair:

- [x] Teach the Vite transform to recognize `api.mutation` and `api.query`, not only direct `defineMutation` and `defineQuery` calls.
- [x] Stamp references from module path and export name.
- [x] Fail the build on duplicate references.
- [x] Add a test with at least two config-form mutations and two config-form queries in one application.
- [x] Prove two explicit mutation refs match between a real emitted Vite browser chunk and an independently bundled workerd Worker.

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

The Better Auth adapter keeps every synthesized model in Catalog, so ordinary lookups no longer depend on a shard partition column. Catalog now renders constraint-complete table and index DDL from the synthesized schema. Existing tables must carry the matching `auth_ddl_v1` signature; there is no versioned upgrade path. Each auth mutation and every directly derivable old and new global, tenant, or principal epoch bump commit in one Catalog transaction. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. The packed chat smoke separately proves the Better Auth HTTP anonymous sign-in, session, demo organization hook, token, and domain path. A configured Catalog workerd test proves stored auth rows and organization authority survive reconstruction. Broader auth workflows and versioned auth migrations remain open.

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
- [x] Prove one Better Auth anonymous sign-in, session lookup, demo organization hook execution, JWT issue, and domain mutation in the clean packed chat consumer. Prove repeated-session idempotency in focused bootstrap tests.
- [x] Add a configured workerd test that creates a user, session, organization, and member, evicts the Catalog Durable Object, proves a new instance started, and reads identical stored auth rows plus canonical organization authority after reconstruction.
- [ ] Add one configured Better Auth plugin only after the core flow works.

## 5. Make authentication a real trust boundary

The configured Gateway verifies JWT signatures and registered claims during `hello` and `updateAuth`. Its attachment stores only the verified subject and time bounds. For each declared organization mutation or exact-partition organization query, Gateway asks Catalog to derive current membership, role, roles, and auth epochs. Undeclared operations, mismatched, scatter, and cross-partition queries, and presence remain fail-closed.

- [x] Verify the JWT signature before storing `principalId`; do not copy tenant, role, or custom claims into the verified attachment.
- [x] Pin issuer, audience, and accepted algorithms from the configured Better Auth JWT plugin, with a bounded 30-second default clock tolerance.
- [x] Resolve JWKS through the Catalog-backed resolver contract.
- [x] Prove the configured Gateway fetches the exact remote JWKS URL on a cold key lookup, reuses the Catalog cache, refreshes after cache expiry, rejects retired and unknown keys, accepts a rotated key, and derives authority from Catalog instead of forged token claims.
- [ ] Define and test outbound JWKS failure handling and bounded retry or backoff before production use.
- [x] Reject missing, malformed, tampered, expired, not-yet-valid, wrong-issuer, wrong-audience, and disallowed-algorithm tokens.
- [x] Serialize `updateAuth` per server connection id, drain admitted work, retire current durable registrations before replacing the subject, report affected subscription ids through `mustRefetch`, and store a terminal rejected attachment on failure.
- [x] Recheck token time bounds before every mutation, subscription, and presence operation.
- [x] Stop deriving a principal from `clientId` for protected requests.
- [x] Derive organization membership, role, roles, and auth epochs from Catalog for each declared organization mutation and exact-partition organization query. Treat the caller's validated organization only as the requested partition.
- [x] Build mutation and initial-query `ctx.auth` only after JWT verification and Catalog membership resolution.
- [x] Define and prove the anonymous query contract. Subjectless Gateway queries stay closed. Better Auth anonymous accounts become authenticated principals after JWT issuance and organization membership. `publicRead` removes only the table-role requirement for selects, not JWT, membership, tenant isolation, writes, or cross-organization isolation. The 4/4 workerd proof covers an own-organization read, cross-organization denial, denial for a missing JWT, and denial for an invalid JWT.
- [x] Test real signed tokens, tampering, expiry, not-before, issuer, audience, algorithm, subject refresh, and the Catalog resolver contract.
- [x] Test the configured Gateway WebSocket dispatch under workerd with real Catalog SQLite cache and ES256 tokens.
- [x] Prove a later revocation blocks the next mutation, while documenting that the Catalog authority read does not cancel an already-authorized in-flight Cdb call.
- [x] Prove in workerd that a socket can outlive a membership role downgrade, restoration, and deletion while dirty reruns re-read current Catalog authority.

## 6. Finish policy enforcement

The database proxy now applies one explicit rule to registered-table inserts, updates, deletes, and full-row selects:

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
- [x] Apply the same default-deny row policy to full-row single-`cdbTable` selects.
- [x] Apply readable-column masks to full-row select results.
- [ ] Compile safe readable-column masks for projections and joins. Keep those shapes blocked until then.
- [x] Block raw SQL, session and client access, relational shortcuts, plain-table CRUD, insert-select, conflict methods, `returning`, and unsupported pre-policy builder paths from application handlers.
- [x] Prove in workerd that a raw escape after typed SQL rolls back both that SQL and the provisional op-log row.
- [x] Replace the unused generic policy-digest claim with a static digest of declared `cdbTable` row and column policy metadata and bind it to registered-query identity.
- [ ] Add hostile two-tenant tests for every CRUD operation.
- [ ] Test admin, member, self, public read, no matching role, forbidden columns, explicit tenant override, and membership revocation.

## 7. Implement narrow organization queries

Protocol v3 subscription requests send a query reference and raw arguments. For an explicit organization query with a stable ref, partition key, developer-declared server-side intent, and `authority: "organization"`, Gateway validates the arguments and requires the partition and intent to resolve to the same exact organization and one virtual shard. It derives current authority from Catalog, installs a durable generation before `Cdb.subscribe`, reruns the exact registered query, and sends snapshots. For supported full-row queries, Cdb conservatively records `cdbTable` dependencies and compares them with declared `intent.tables` before returning rows. Raw or untracked predicates, embedded subqueries, and `orderBy` callbacks remain blocked. General query shapes remain closed. Resume cookies do not replay missed changes.

- [x] Change the wire protocol so `sub` carries the query reference and raw arguments.
- [x] Increment the protocol version and enforce it during `hello` and `welcome`.
- [x] Validate query arguments with the query's Standard Schema validator before intent extraction.
- [x] Resolve the query reference inside the Cdb isolate.
- [x] Evaluate the developer-declared intent callback on the server. Do not trust client-supplied intent or a client query hash.
- [x] Canonicalize the query ref, validated arguments, and server-evaluated declared intent into a query hash used by persisted Cdb registrations and deploy-drift checks.
- [x] Persist principal and organization identity on Cdb registrations and require freshly derived tenant authority when executing the registered-query RPC.
- [x] Derive and enforce the static `cdbTable` policy digest in Gateway and Cdb registered-query identity, including legacy-registration retirement and staged-snapshot send fencing.
- [x] Route explicit organization queries only when the validated partition metadata and server-evaluated declared intent resolve to the same exact organization and one virtual shard.
- [x] Enumerate distinct current Catalog shard ids for scatter routing instead of probing virtual shards.
- [x] Construct `QueryCtx` with a read-only database and the auth carried by the internal request.
- [x] Apply row predicates and readable-column masks during full-row single-`cdbTable` query execution. Keep projections and joins blocked.
- [x] Execute the query handler inside Cdb and reject non-JSON results.
- [x] Add an internal registered-query RPC that requires an exact active generation, fresh principal and organization authority, and an unchanged ref, partition, and query hash before execution.
- [x] Add an explicit protocol-v3 snapshot envelope, including empty row arrays, and replace client subscription state when it arrives.
- [x] Send an explicit initial snapshot, including an empty snapshot, for the exact-partition organization query path.
- [x] Move the client subscription from `pending` to `live` when a valid snapshot arrives.
- [ ] Define ordering and stable row keys for collection results.
- [x] Reject undeclared, mismatched, scatter, and cross-partition queries instead of silently routing them.
- [x] Conservatively record every `cdbTable` dependency exposed by supported full-row queries and reject results when a recorded table is absent from developer-declared `intent.tables`.
- [ ] Derive or verify that declared intent intervals cover every range the handler can read.
- [x] Connect public authorized registration to `onSub`, installing the exact Gateway generation before `Cdb.subscribe` and pre-arming durable recovery before the RPC.

## 8. Implement live updates with simple invalidation first

Do not start with incremental row patches. Re-run the affected query after a commit and send a replacement snapshot. Optimize after this is correct.

- [x] Give every shard subscription a generation identity containing Gateway, registration, connection, client, and subscription IDs.
- [x] Persist exact Cdb generation identity, principal, organization, query ref, arguments, query hash, tables, and intervals; retain retired tombstones so stale subscribe replays cannot reactivate a generation.
- [x] Rebuild active Cdb generation identity and the in-memory interval index from SQLite when Cdb starts.
- [x] Persist durable Gateway logical heads and generation rows with organization, logical shard, physical Cdb ID, schema epoch, three auth epochs, lifecycle, cookie, retry, and delivery fields.
- [x] Persist the static `cdbTable` policy digest on Gateway registrations and retire a generation when current metadata no longer matches it.
- [x] Collect deterministic registered-table write sets inside successful newly-run atomic mutations without exposing them on the public mutation wire result.
- [x] Advance the Cdb change clock and coalesce table-matched registrations into the invalidation outbox inside the same transaction as the domain write and op-log.
- [x] Deliver bounded invalidation batches from Cdb to the physical Gateway ID with durable alarms, retries, conditional acknowledgement deletes, and dead-letter state.
- [x] Validate production Gateway invalidation requests against the routed Gateway and exact current generation, connection, client, subscription, and physical Cdb source before accepting them.
- [x] Durably coalesce accepted invalidations by raising `dirty_version` monotonically, including safe retries of the same change sequence.
- [x] Persist a token-owned `run_target_version` separately from `delivered_version`; beginning a query does not claim delivery, and guarded settlement advances only the stored target while preserving newer dirtiness.
- [x] Wire public `onSub`, `onUnsub`, auth replacement, cancellation, and disconnect paths to install, retire, unsubscribe, and clean up exact durable generations.
- [x] Commit logical-head retirement and its cleanup alarm in one storage transaction so an alarm failure rolls both changes back.
- [x] After a close-time retirement failure, best-effort schedule a separate reconciliation alarm. Scan active heads in durable rowid pages of 32, preserve only exact current verified socket identities, retire missing, stale, or mismatched attachments, and run exact Cdb cleanup without resetting an in-progress cursor.
- [ ] Guarantee prompt cleanup when both the original atomic retirement and the fallback alarm transaction fail. A quiet abandoned head can otherwise persist until another event or bootstrap reaches the Gateway.
- [x] Re-run subscriptions whose table set intersects the touched tables.
- [x] Send replacement snapshots with a new cookie.
- [x] Add the replacement-query runner that owns run tokens, consumes coalesced dirtiness, and stages an immutable snapshot before delivery settlement.
- [x] Remove the dead Gateway patch queue after replacement snapshots superseded it.
- [x] Remove the dead production `matchSubsForRow` method and replace its test-only callers with durable-state and interval-reconstruction assertions.
- [x] Add a workerd test in which two org-A clients receive and acknowledge a replacement snapshot after a public mutation while an org-B rerun stays empty under policy.
- [x] Prove focused Gateway and Cdb reconstruction preserves normalized subscription and table state, rebuilt intervals, outbox state, retries, acknowledgements, and cleanup state.
- [x] Evict and reconstruct both Gateway and Cdb with a hibernated socket and a staged replacement, then deliver and acknowledge the same snapshot cookie.

## 9. Define reconnect, retry, and failure behavior

The current cookie is a generated string, not a replay coordinate. Resume does not replay missed changes. Admitted mutation dispatch failures settle as typed results, but socket loss and shutdown behavior still need an explicit rule.

- [ ] Define what a cookie identifies and where its replay data lives.
- [ ] Either implement replay from a valid cookie or always issue `mustRefetch` after reconnect.
- [ ] Do not claim read-your-writes resume until missed updates can actually be recovered.
- [ ] Connect replacement snapshots to a durable cookie coordinate and prove cookie replay after missed invalidations.
- [x] Bound pending mutation settlement with `mutationTimeoutMs`, defaulting to 60 seconds and returning nonretryable `CDB_MUTATION_OUTCOME_UNKNOWN` when the server may already have committed.
- [x] Reuse the original `mutId` when reconnect resends a mutation that remains pending, without resetting its deadline.
- [ ] Expose a public retry handle and define an automatic retry policy for terminal errors marked retryable.
- [x] Preserve the last delivered nonempty cookie on mutation failures and across auth refresh.
- [x] Return typed errors for malformed messages instead of accepting any object with a known `t` field.
- [x] Validate every wire message field.
- [ ] Bound pending mutations, subscriptions, staged snapshots, and presence state.
- [x] Define and test snapshot acknowledgement, durable retry until exact acknowledgement, and client same-cookie deduplication with re-acknowledgement.
- [ ] Apply backpressure or disconnect slow consumers.
- [ ] Make disconnect and shutdown reject or retain pending mutations according to a documented rule.
- [ ] Add failure tests for Worker RPC errors, Catalog errors, shard eviction, socket loss before acknowledgment, duplicate delivery, stale schema epoch, and protocol mismatch.

## 10. Make one real example

The chat directory consumes the packed package and passes compile-time checks. Its mutation and query declare the public organization authority contract. The clean-tarball smoke now runs Better Auth anonymous sign-in, the demo organization hook, an empty initial query, `postMessage`, live replacement, and independent readback under workerd. Domain migrations and broader failure coverage remain incomplete.

- [x] Install the package through npm's packed file-dependency path with a committed consumer lockfile.
- [x] Declare every dependency used by the example.
- [x] Replace `chardb/react/index.ts` with `chardb/react`.
- [x] Replace `chardb/vite/index.ts` with `chardb/vite`.
- [x] Give `postMessage` a concrete organization partition key and reject an auth tenant mismatch.
- [x] Delete stale `tenantScope`, `ownerScope`, and `requirePermission` documentation.
- [ ] Generate the example schema through real migrations.
- [x] Add an idempotent auth hook that reuses the demo organization and user membership, tolerates confirmed concurrent creation, then sets the active organization.
- [x] Give `postMessage` an explicit stable ref and organization authority, and call it through the public mutation hook.
- [x] Make opening a channel in the clean packed chat consumer return and acknowledge an empty initial query result under workerd.
- [ ] Make a second browser receive the live replacement result.
- [x] Add a second packed principal, move its session from `demo-org` to another organization, deny its `demo-org` query, and prove its own organization starts empty.
- [x] Install, typecheck, and build the example against the packed package instead of TypeScript aliases or source imports.
- [x] Add a clean-tarball workerd smoke that crosses the real WebSocket, Gateway, Worker, Catalog, Cdb, Better Auth, policy, mutation, query, and live-update paths.
- [x] Keep test-only raw SQL RPCs out of the packed smoke.
- [x] Add packed denial between principals in different organizations.
- [x] Replay the same packed mutation id and prove the stored result and row count do not change.
- [ ] Restart the packed Worker and Durable Objects during the application smoke.

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
- [x] Install version 0.1.0 from a clean tarball and run `scripts/smoke-packed-chat.mjs` through sign-in, mutation, live replacement, and readback.
- [x] Fix all Biome errors and warnings, or narrow the lint inputs deliberately and document why.
- [x] Add CI for frozen install, typecheck, lint, unit tests, serialized workerd tests, package build, package consumer tests, generated-project smoke, packed chat smoke, landing build, and example build.
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

Keep these out of the supported path while the remaining migration, replay, isolation, and recovery work is unfinished:

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
