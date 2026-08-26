# chardb completion plan

Last reviewed: 2026-08-25

## What this project is

Chardb should do one thing well: a developer marks an organization boundary in a Drizzle schema, and chardb routes that organization's data to a SQLite Durable Object with tenant isolation, atomic mutations, idempotent retries, initial queries, and live updates.

The repository now proves that narrow path under workerd. A declared organization mutation crosses Gateway, Catalog, and Cdb. An explicit stable-ref query with `authority: "organization"` can register against one exact partition, receive an initial snapshot, rerun after a matching commit, and receive a replacement snapshot. The clients acknowledge delivery, and the Cdb invalidation outbox drains. One reconstruction test stages a snapshot before send, evicts Gateway and Cdb, then completes delivery after both objects restart. A second test reconstructs both objects around the same hibernated socket and redelivers an unacknowledged snapshot with the exact cookie and rows. A third loses the socket after delivery but before acknowledgement, holds the replacement before `hello`, reconstructs Gateway, replays that exact cookie and rows on the released connection, then delivers a distinct current snapshot and a later mutation without entering `refetching`. An unknown-cookie case proves the explicit fallback. The clean-tarball smoke also proves live replacement reaches two independent same-organization browser connections before its persistent restart and isolation checks.

Finish the organization-tenanted SQL path first. Stop presenting files, vectors, presence, streams, scheduling, cross-partition transactions, PITR, and automatic resharding as working product features. Keep that code as experimental work until the database path works.

This plan now ends at that narrow supported path. Product expansions that require new protocols or compatibility policy live in [`NEXT_SCOPE.md`](NEXT_SCOPE.md). Moving them there does not claim they exist.

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
- [x] Return an owned snapshot of the handler's exact JSON result. Do not reconstruct it from `returning[0]`.
- [x] Validate that mutation results are JSON before committing them.
- [x] Accept mutation results through the exact 512 KiB serialized JSON boundary and reject larger results with `CDB_INVARIANT` inside the atomic transaction before op-log finalization or the write-set hook.
- [x] Prove a fresh oversized result rolls back domain SQL and its provisional op-log row. Reject an oversized legacy replay without running the handler or hook or changing the stored row, while accepted replays remain unchanged.
- [x] Enforce the mutation argument contract in the client, Gateway, trusted dispatcher, and Cdb: strict JSON data properties without invoking getters, exactly 512 KiB of serialized UTF-8, 4,096 aggregate members, and 99 argument levels because the wire envelope consumes one level. Return `CDB_INVALID_ARGS` from mutation-specific validation before UUID, timer, admission, auth-refresh waiting, Catalog authorization, routing, alarm, handler, op-log, or domain work as applicable.
- [x] Own server mutation arguments at raw dispatch, validator output, partition extraction, custom route output, and Cdb entry. Copy custom-route arguments and capture route authority, partition key, vshard, projected auth primitives, role arrays, and epochs across Catalog awaits, then snapshot Cdb args and auth before the recovery-alarm await.
- [x] Keep keyless mutation routing stable across object key order. Preserve an own `__proto__` data property in canonical JSON and op-log request hashing so routing and replay collision identity include it without prototype mutation.
- [x] Cap each newly executed atomic mutation at 256 successful typed write statements and 4,096 total direct, trigger, and foreign-key affected rows measured through `total_changes()` deltas. Treat a caught violation as a terminal poisoned `CDB_INVARIANT`, roll back domain SQL and the provisional op-log row, suppress the write-set hook, and let replay bypass the handler and write accounting.
- [x] Snapshot a fresh mutation result inside the transaction before op-log finalization. Return and store that owned value so fresh execution and replay remain identical even if the handler retains and later mutates its object.
- [x] Guard the mutation database for the lifetime of its owning `transactionSync`. Allow supported nested wrappers while active, but reject retained-context reads, writes, and nested transaction entry after exit with `CDB_INVARIANT`.
- [x] Store the owned result in the op-log replay envelope.
- [x] Return that stored result when the client repeats the same `mutId`.
- [x] Keep collision detection for a repeated `mutId` with different arguments.
- [x] Settle admitted public mutations once across local routing, Catalog authority and routing, Cdb RPC, malformed response, and policy failures.
- [x] After routed mutation work settles, require the exact current verified `connectionId`, `clientId`, and `principalId` before updating its cookie or sending its result. Suppress stale close or attachment-replacement delivery without changing commit or op-log replay semantics.

## 2. Make runtime registration and routing coherent

The configured Gateway owns partition extraction and manifest lookup. For a declared organization mutation, it validates and transforms raw arguments once before extracting the partition key. Catalog must confirm that the verified JWT subject currently belongs to that exact organization before routing continues.

- [x] Make the configured Gateway own partition extraction and manifest lookup.
- [x] Define typed routing, Catalog, and Cdb mutation interfaces in one shared module.
- [x] Remove the invalid Worker service self-binding from generated and example Wrangler configuration.
- [x] Make `chardb doctor` validate the Durable Object bindings without requiring a service self-binding.
- [x] Remove the Worker `runMutation` RPC that returned only a vshard while dropping `mutId` and auth.
- [x] Route with the organization extracted from validated arguments only after Catalog confirms the verified subject's membership in it.
- [x] Read the current routing table and schema epoch from Catalog before invoking Cdb.
- [x] Publish a successful Catalog cutover to the in-memory range cache only after the range, schema epoch, and migration guard commit durably. Leave the cache and durable state unchanged after a failed commit so retry can apply the cutover once.
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

Versioned domain migration, authoritative schema epochs, real migration execution, and upgrade proofs are one next-scope package. [`NEXT_SCOPE.md`](NEXT_SCOPE.md) keeps its required protocol and tests together. Until that package lands, existing databases cannot upgrade in place and routed schema epochs are not enforced by Cdb.

Online schema changes can wait. A maintenance-mode migration is enough for the first working version, as long as it is explicit and does not pretend to be online.

## 4. Simplify and fix auth storage

The Better Auth adapter keeps every synthesized model in Catalog, so ordinary lookups no longer depend on a shard partition column. Catalog renders constraint-complete table and index DDL from the synthesized schema. Existing tables must carry the matching `auth_ddl_v1` signature, and versioned Catalog migration statements can upgrade older layouts before the final signatures are verified. Each auth mutation and every directly derivable old and new global, tenant, or principal epoch bump commit in one Catalog transaction. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. The packed chat smoke proves anonymous sign-in, session lookup, organization creation and selection, bounded membership lookup, JWT issue, domain access, and logout through the configured organization plugin. A configured Catalog workerd test proves stored auth rows and organization authority survive reconstruction.

- [x] Put all Better Auth tables in Catalog for the first working version.
- [x] Remove auth sharding from the adapter and Cdb storage path.
- [x] Bind the auth runtime during application-module initialization in every Worker and Durable Object isolate, and let Catalog retry auth-table bootstrap if it started before that binding.
- [x] Test create and routine lookup by email, session token, provider/account key, and membership field, plus update, delete, rollback, and same-storage Catalog reconstruction in a Bun fake-Durable-Object harness.
- [x] Route Better Auth counts through a Catalog `COUNT(*)` RPC instead of materializing matching rows. Reuse the adapter's `eq` and `AND` validation, model and column checks, and bound equality predicates.
- [x] Support the organization plugin's bounded `in` user lookup through parameterized Catalog SQL. Accept at most 256 values, return no rows for an empty list, and keep auth writes equality-only.
- [x] Forward Better Auth `findMany` offset and sort through Catalog. Map model fields to schema column names, support validated ascending and descending order, add `id ASC` as the tie-breaker and paging default, and bind validated non-negative safe-integer limits and offsets.
- [x] Make Better Auth single `update` and `delete` select the lowest matching schema-mapped id and mutate only that row. Treat an empty predicate or no match as a no-op, while leaving `updateMany` and `deleteMany` as all-match operations, including for an empty predicate.
- [x] Implement Better Auth `incrementOne` as one atomic Catalog transaction. Resolve customized model and field names without collision, select the deterministic lowest matching id, repeat the guard on update, enforce mutation budgets, and bump epochs only after a successful write.
- [x] Generate auth table and index DDL from the synthesized Drizzle schema, preserving keys, uniqueness, foreign keys, indexes, defaults, nullability, and SQLite types.
- [x] Reject existing auth tables without matching `auth_ddl_v1` signatures instead of treating `CREATE TABLE IF NOT EXISTS` as an upgrade.
- Existing auth signatures still require pre-release Catalog recreation. Versioned auth upgrades belong to the migration package in [`NEXT_SCOPE.md`](NEXT_SCOPE.md).
- [x] Commit each auth write and every directly derivable old and new global, tenant, or principal epoch bump in one Catalog transaction.
- Indirect plugin relationships without conventional `organizationId` or `userId` fields remain outside the supported auth profile. Their placement and epoch rules are listed in [`NEXT_SCOPE.md`](NEXT_SCOPE.md).
- [x] Preflight auth bulk updates and deletes at 4,096 matched rows, 512 KiB of projected old and replacement scope values, and 512 KiB of mapped replacement values expanded across matched rows. Select only epoch-scope columns, fail with retryable `CDB_RATE_LIMITED` before base or epoch writes, and let `updateMany` skip full-row rereads.
- [x] Make date and boolean serialization agree with the adapter's capability claims.
- The adapter reports `transaction: false`. The supported evidence covers the named anonymous, session, organization, membership, selection, JWT, domain-access, and logout workflow. General multi-write adapter transactions remain a next-scope expansion.
- [x] Add integration tests for anonymous sign-in, session lookup by token, organization creation, membership lookup, active organization selection, and logout.
- [x] Prove one Better Auth anonymous sign-in, session lookup, demo organization hook execution, JWT issue, and domain mutation in the clean packed chat consumer. Prove repeated-session idempotency in focused bootstrap tests.
- [x] Add a configured workerd test that creates a user, session, organization, and member, evicts the Catalog Durable Object, proves a new instance started, and reads identical stored auth rows plus canonical organization authority after reconstruction.
- [x] Exercise the configured Better Auth organization plugin through the clean packed consumer.

## 5. Make authentication a real trust boundary

The configured Gateway verifies JWT signatures and registered claims during `hello` and `updateAuth`. Its attachment stores only the verified subject and time bounds. For each declared organization mutation or exact-partition organization query, Gateway asks Catalog to derive current membership, role, roles, and auth epochs. Undeclared operations, mismatched, scatter, and cross-partition queries, and presence remain fail-closed.

- [x] Verify the JWT signature before storing `principalId`; do not copy tenant, role, or custom claims into the verified attachment.
- [x] Pin issuer, audience, and accepted algorithms from the configured Better Auth JWT plugin, with a bounded 30-second default clock tolerance.
- [x] Resolve JWKS through the Catalog-backed resolver contract.
- [x] Prove the configured Gateway fetches the exact remote JWKS URL on a cold key lookup, reuses the Catalog cache, refreshes after cache expiry, rejects retired and unknown keys, accepts a rotated key, and derives authority from Catalog instead of forged token claims.
- [x] Move URL-scoped JWKS refresh ownership into Catalog. Enforce a 5-second deadline, 256 KiB document limit, 32-key limit, 256-byte `kid` limit, and 2,048-byte URL limit. Coordinate refresh with a durable 10-second lease, cache missing keys for 5 seconds after success, and persist exponential failure cooldown from 1 to 60 seconds.
- [x] Fail closed without stale keys or the unscoped legacy cache, replace each URL's key set atomically so absent keys retire, and prove failure cooldown plus rotation through the configured workerd Gateway.
- [x] Reject missing, malformed, tampered, expired, not-yet-valid, wrong-issuer, wrong-audience, and disallowed-algorithm tokens.
- [x] Admit only one `hello` or `updateAuth` operation per server connection id. Reject duplicates with retryable `CDB_RATE_LIMITED` before verification, Catalog access, attachment mutation, or refresh chaining. Release only the exact owning claim on every outcome. Keep an admitted `updateAuth` barrier visible to mutations and subscriptions while it drains admitted work, retires current durable registrations, and reports affected subscription ids through `mustRefetch`.
- [x] On socket close, store a rejected attachment and fence authentication after every awaited verification, drain, alarm schedule, and invalidation, and before retirement or send, so queued work cannot dispatch after close.
- [x] Serialize an authentication rejection before sending its error and closing the socket. Attempt close even if error send throws, preserve the send exception when both operations fail, propagate a lone close exception, and make repeated rejection an exactly-once no-op.
- [x] If a verified `hello` cannot deliver `welcome`, mark that exact connection rejected and attempt a 1011 close with reason `welcome delivery failed`, preserving the send exception if close also fails. For an unsupported protocol, reject before verification, attempt the mismatch frame, and close with 1002 and reason `unsupported chardb protocol <version>` even if that send fails.
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
- [x] Keep projections and joins blocked until a future package compiles safe readable-column masks and dependency tracking for them.
- [x] Block raw SQL, session and client access, relational shortcuts, plain-table CRUD, insert-select, conflict methods, `returning`, and unsupported pre-policy builder paths from application handlers.
- [x] Prove in workerd that a raw escape after typed SQL rolls back both that SQL and the provisional op-log row.
- [x] Replace the unused generic policy-digest claim with a static digest of declared `cdbTable` row and column policy metadata and bind it to registered-query identity.
- [x] Prove on real Durable Object SQL that no-filter create, read, update, and delete operations stay within one tenant while another tenant's row remains unchanged.
- [x] Test admin, member, self, public read, no matching role, forbidden columns, explicit tenant override, and membership revocation across focused policy tests and configured workerd paths.

## 7. Implement narrow organization queries

Protocol v3 subscription requests send a query reference and raw arguments. Query arguments use strict owned snapshots through raw Gateway admission, validator output, routed output, `Cdb.subscribe`, and direct or registered Cdb execution. For an explicit organization query with a stable ref, partition key, developer-declared server-side intent, and `authority: "organization"`, Gateway requires the partition and intent to resolve to the same exact organization and one virtual shard. It derives current authority from Catalog, installs a durable generation before `Cdb.subscribe`, reruns the exact registered query, and sends snapshots. For supported full-row queries, Cdb conservatively records `cdbTable` dependencies and compares them with declared `intent.tables` before returning rows. Each terminal query execution also records its typed predicate after the row-policy floor is applied. Each declared interval bundle's union must contain every observed range for its table and index. Raw or untracked predicates, embedded subqueries, and callback predicates or ordering remain blocked. General query shapes remain closed. Resume cookies trigger fresh rematerialization after transport loss; they do not replay an exact missed snapshot.

- [x] Change the wire protocol so `sub` carries the query reference and raw arguments.
- [x] Increment the protocol version and enforce it during `hello` and `welcome`.
- [x] Validate query arguments with the query's Standard Schema validator before intent extraction.
- [x] Enforce the exact 512 KiB UTF-8, 4,096-member, and 99-level strict JSON query-argument contract at raw Gateway admission, after validation, after declared routing callbacks, on an overridden route result, at `Cdb.subscribe`, and before direct or registered Cdb execution.
- [x] Build each server query-argument snapshot in one descriptor traversal without invoking getters or rereading a proxy. Snapshot validator results, callback-mutated arguments, returned intent, and routed arguments at their ownership seams so later mutation cannot change downstream work.
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
- [x] Define collection ordering and row identity for the full-snapshot path. Cdb preserves the handler's array order, so a handler must use a deterministic `orderBy` when order matters. Replacement snapshots replace the whole collection and require no protocol row key; incremental patches remain unsupported.
- [x] Reject undeclared, mismatched, scatter, and cross-partition queries instead of silently routing them.
- [x] Conservatively record every `cdbTable` dependency exposed by supported full-row queries and reject results when a recorded table is absent from developer-declared `intent.tables`.
- [x] At each supported full-row query execution, record the actual typed predicate with the row-policy floor and require each declared interval bundle's union to contain every observed range for its table and index.
- [x] Connect public authorized registration to `onSub`, installing the exact Gateway generation before `Cdb.subscribe` and pre-arming durable recovery before the RPC.
- [x] Rebuild 4,096 active Cdb registrations incrementally from the storage cursor. Keep a legacy active row with over-limit arguments in its table and interval maps so invalidation still reaches it, but reject its registered execution with terminal `CDB_INVALID_ARGS` before the handler.
- [x] Add dedicated configured Gateway snapshot-runner coverage for a reconstructed legacy registration with over-limit arguments. Keep the Cdb row active and table-mapped through reconstruction, invalidate it with a real mutation, return terminal `CDB_INVALID_ARGS`, retire the Gateway head, and complete exact Cdb cleanup.
- [x] Add the single-source `api.query({ query: (db, args) => ... })` form. Compile its sessionless Drizzle builder before Catalog, derive authority, one exact partition, tables, recognized intervals, full-row projection, deterministic primary-key-suffixed ordering, and a bounded limit, then include the plan hash in query identity.
- [x] Compile the same planned query again inside Cdb before direct or registered execution. Reject Gateway-to-Cdb plan drift, and execute the callback only through the policy-wrapped read database.
- [x] Keep legacy `handler`, `authority`, `partitionKey`, and `intent` queries compatible while rejecting mixed legacy and planned metadata. Require a literal stable ref for planned queries in both runtime definitions and Vite discovery.
- [x] Fail closed on async callbacks, raw or unrecognized predicates, placeholders, projections, joins, CTEs, distinct, grouping, aggregates, set operations, offset pagination, multiple partitions, missing limits, limits over 100, and ordering without the primary-key suffix.
- [x] Convert the chat application's organization, user, and global reads to the planned form and pass its packed-package typecheck and Vite build.
- [x] Prove the planned organization query through real Miniflare workerd, configured Gateway, Catalog, and Cdb. Assert exact channel rows and order, cross-organization denial, and same-ref plan-drift rejection. Keep an environment-scalable profile whose default seeds 8 channels and 800 rows, installs 32 registrations, and verifies 25 exact ordered rows per snapshot while recording timing as telemetry, not a service target.

## 8. Implement live updates with simple invalidation first

Do not start with incremental row patches. Re-run the affected query after a commit and send a replacement snapshot. Optimize after this is correct.

- [x] Give every shard subscription a generation identity containing Gateway, registration, connection, client, and subscription IDs.
- [x] Persist exact Cdb generation identity, principal, organization, query ref, arguments, query hash, tables, and intervals; retain retired tombstones so stale subscribe replays cannot reactivate a generation.
- [x] Cap each Cdb at 4,096 active registrations. Let an exact active replay succeed without another slot, release a slot on unsubscribe, and return exact typed success or a matching `registrationState: "absent"` capacity failure.
- [x] Rebuild active Cdb generation identity and the in-memory interval index from SQLite when Cdb starts.
- [x] Persist durable Gateway logical heads and generation rows with organization, logical shard, physical Cdb ID, schema epoch, three auth epochs, lifecycle, cookie, retry, and delivery fields.
- [x] Persist the static `cdbTable` policy digest on Gateway registrations and retire a generation when current metadata no longer matches it.
- [x] Collect deterministic registered-table write sets inside successful newly-run atomic mutations without exposing them on the public mutation wire result.
- [x] Advance the Cdb change clock and coalesce table-matched registrations into the invalidation outbox inside the same transaction as the domain write and op-log.
- [x] Cap each Cdb invalidation outbox at 4,096 rows while allowing existing exact rows to coalesce at capacity and acknowledgement deletes to release space. Cap one mutation at 4,096 distinct registration targets with a `LIMIT 4097` guard; overflow rolls back the domain write, provisional op-log, change clock, and outbox work.
- [x] Deliver bounded invalidation batches from Cdb to the physical Gateway ID with durable alarms, retries, conditional acknowledgement deletes, and dead-letter state.
- [x] Validate production Gateway invalidation requests against the routed Gateway and exact current generation, connection, client, subscription, and physical Cdb source before accepting them.
- [x] Durably coalesce accepted invalidations by raising `dirty_version` monotonically, including safe retries of the same change sequence.
- [x] Persist a token-owned `run_target_version` separately from `delivered_version`; beginning a query does not claim delivery, and guarded settlement advances only the stored target while preserving newer dirtiness.
- [x] Wire public `onSub`, `onUnsub`, auth replacement, cancellation, and disconnect paths to install, retire, unsubscribe, and clean up exact durable generations.
- [x] After unsubscribe retirement settles, reread the socket attachment and remove the subscription id only for the exact current verified connection, client, and principal. Preserve every newer attachment field and leave a close-rejected or replacement identity untouched.
- [x] Treat only a matching typed Cdb absence response as proof that a pending install can be deleted without an unsubscribe tombstone. Preserve cancelled pending state until that response or its durable 30-second recovery deadline; compensate ambiguous, lost, malformed, or identity-mismatched outcomes with exact Cdb unsubscribe, including after restart.
- [x] Commit logical-head retirement and its cleanup alarm in one storage transaction so an alarm failure rolls both changes back.
- [x] After a close-time retirement failure, best-effort schedule a separate reconciliation alarm. Scan active heads in durable rowid pages of 32, preserve only exact current verified socket identities, retire missing, stale, or mismatched attachments, and run exact Cdb cleanup without resetting an in-progress cursor.
- [x] State the storage failure limit precisely. If both the atomic retirement transaction and the separate fallback-alarm transaction fail, Gateway cannot durably guarantee prompt cleanup without another event or an external watchdog. Keep that watchdog decision in [`NEXT_SCOPE.md`](NEXT_SCOPE.md).
- [x] Re-run subscriptions whose table set intersects the touched tables.
- [x] Send replacement snapshots with a new cookie.
- [x] Add the replacement-query runner that owns run tokens, consumes coalesced dirtiness, and stages an immutable snapshot before delivery settlement.
- [x] Remove the dead Gateway patch queue after replacement snapshots superseded it.
- [x] Remove the dead production `matchSubsForRow` method and replace its test-only callers with durable-state and interval-reconstruction assertions.
- [x] Add a workerd test in which two org-A clients receive and acknowledge a replacement snapshot after a public mutation while an org-B rerun stays empty under policy.
- [x] Prove focused Gateway and Cdb reconstruction preserves normalized subscription and table state, rebuilt intervals, outbox state, retries, acknowledgements, and cleanup state.
- [x] Evict and reconstruct both Gateway and Cdb with a hibernated socket and a staged replacement, then deliver and acknowledge the same snapshot cookie.

## 9. Define reconnect, retry, and failure behavior

The current cookie identifies one immutable snapshot. A bounded replay row now carries that coordinate across exact connection retirement. Admitted mutation dispatch failures settle as typed results, while broader shutdown behavior remains open.

- [x] Define the current cookie. It identifies one immutable staged snapshot for one exact Gateway registration generation and target version. A sent but unacknowledged snapshot can move from `_gw_snapshot_outbox` into bounded replacement replay before retirement.
- [x] On a replacement SDK connection that carries a resume cookie, route and authorize each subscription once, require the exact principal, client, subscription, ref, canonical arguments, query, policy, route, schema, domain epoch, auth epochs, and cookie, then send the retained rows before current rematerialization. Fall back through one `mustRefetch{lagged}` round trip when history is missing, expired, corrupt, over quota, or mismatched.
- [x] Start one independent 30-second expiry for retained pre-disconnect query state. Do not reset it across a held JWT or repeated pre-welcome failures. Expire only subscriptions that have not recovered, preserve cookie progress from recovered siblings, and notify each expired record once before its later resend.
- [x] Retain at most one replay row per logical subscription for 30 seconds, 256 rows per Gateway, and the existing exact 16 MiB Gateway payload charge. Consume it on exact acknowledgement and evict expired or oldest rows without extending the original send deadline.
- [x] Bound pending mutation settlement with `mutationTimeoutMs`, defaulting to 60 seconds and returning nonretryable `CDB_MUTATION_OUTCOME_UNKNOWN` when the server may already have committed.
- [x] Reuse the original `mutId` when reconnect resends a mutation that remains pending, without resetting its deadline.
- [x] Advance reconnect delay across every pre-welcome close from 250 ms through a 10-second cap. Reset to 250 ms only after an accepted `welcome`, not when the transport merely opens.
- [x] Fence every client WebSocket callback and pending JWT continuation by terminal state, connection attempt, and exact socket identity. Revoke the current socket before processing error or close, ignore stale continuations and callbacks, and preserve the existing reconnect progression and welcome-only reset.
- [x] Treat a thrown client `hello` send as a reconnectable socket failure. Revoke and close that attempt, retain queued subscriptions and mutations, then resend them once after a replacement socket receives `welcome`.
- [x] On terminal client cleanup, clear each subscription's authoritative rows and optimistic history before its final empty listener notification. Continue clearing mutations, timers, socket, and broadcast state if one listener throws.
- [x] Propagate subscription lifecycle state to listeners and React without breaking one-argument listeners. Only an authoritative snapshot promotes a query to `live`; patches preserve `pending`, `refetching`, or `error`. Clear per-subscription snapshot deduplication on `mustRefetch` so a same-cookie rematerialization can restore `live` state.
- [x] Route hibernatable WebSocket errors through the same exact attachment rejection, admission cleanup, registration retirement, and fallback reconciliation path as socket close.
- [x] Cap client pending mutation records at 32 across queued, in-flight, and reconnecting work. Validate refs first, then reject a valid 33rd immediately with retryable `CDB_RATE_LIMITED` before UUID allocation, timer creation, map insertion, or send. Preserve admitted ids and deadlines across reconnect and release capacity on every settlement and close path.
- [x] Apply the strict 512 KiB, 4,096-member, 99-level JSON argument contract to client subscriptions as well as mutations. After ref validation, inspect descriptors and construct an owned snapshot in one traversal without invoking getters or rereading proxies. Finish this work before capacity checks, id allocation, mutation timers, record insertion, or send as applicable, then reuse the same owned payload and ids for immediate send, welcome flush, and reconnect.
- [x] Keep direct clients eager while deferring provider-created client startup until the React effect commits. Close only clients the provider created, preserve a same-object transfer to borrowed ownership, and avoid WebSocket, JWT, or broadcast work for aborted renders and StrictMode rehearsals. Reset `useQuery` to pending when client, ref, or argument identity changes, and ignore late listeners from the previous identity. Keep public exports unchanged.
- [x] Have React `useQuery` validate and own arguments before computing canonical identity. Enforce the exact 512 KiB UTF-8, 4,096-member, and 99-level strict JSON limits, and create no subscription when argument validation fails.
- [x] When `ChardbProvider` receives an explicit stable `getJwt`, let an auth-prop-only update change session context without replacing its owned client, socket, subscriptions, or pending mutations. Keep auth-derived JWT clients dependent on the auth object and replace them when it changes.
The public retry handle and automatic retry policy remain a separate API package in [`NEXT_SCOPE.md`](NEXT_SCOPE.md). Current typed retryability metadata is descriptive.
- [x] Preserve the last delivered nonempty cookie on mutation failures and across auth refresh.
- [x] Return typed errors for malformed messages instead of accepting any object with a known `t` field.
- [x] Validate every wire message field.
- [x] Cap unsettled Gateway mutations at 32 per connection and 256 per Gateway object. Reject excess work before dispatch with retryable `CDB_RATE_LIMITED` and release capacity on every settlement path.
- [x] Accept Gateway inbound WebSocket text frames only through the exact 1 MiB UTF-8 boundary. Measure before wire decoding and close oversized frames with code 1009.
- [x] Accept client inbound WebSocket data only as text through the exact 1 MiB UTF-8 boundary before wire decoding. Treat non-text or larger frames as terminal `CDB_INVARIANT`, clear subscriptions and pending mutations, cancel mutation and reconnect timers, close transport resources, and do not reconnect. Keep the existing snapshot, patch, cache, history, and aggregate retained-state caps after decode.
- [x] Cap active client subscription records at 64. Validate the ref and owned arguments first, then reject excess work synchronously with retryable `CDB_RATE_LIMITED` before allocating an id, changing state, or sending. Preserve the same records across reconnect, release capacity on unsubscribe, clear all records on terminal session failure, roll back a failed subscribe send, and close the session when unsubscribe send fails.
- [x] Cap each Gateway at 256 aggregate current and pending logical registrations. Count durable heads after restart, allow same-key replacement without extra capacity, deny duplicate pending races, and return retryable `CDB_RATE_LIMITED` before routing, Catalog, Cdb, or installation work.
- [x] Permit at most one active subscription attempt and one queued replacement per Gateway connection and subscription id. Preserve the accepted replacement payload. Reject further duplicates with retryable `CDB_RATE_LIMITED` before capacity SQL, routing, Catalog, Cdb, or installation work, and fence stale route and final-scheduler errors after replacement or close.
- [x] Snapshot direct and registered Cdb query results from data descriptors before returning them, then enforce 4,096 top-level rows and exactly 512 KiB of serialized JSON on the owned value. For registered execution, snapshot first, check observed reads and ranges next, then apply the final durable generation fence. Catch reads from hostile Proxy `ownKeys` traps and generation drift, and return `CDB_INVARIANT` with limit or pagination guidance.
- [x] Cap each nonduplicate client snapshot at 4,096 rows and the exact 512 KiB serialized JSON boundary. Re-acknowledge and ignore a same-cookie duplicate before sizing it.
- [x] Preflight canonical and cross-tab optimistic patch batches at 4,096 items and exactly 512 KiB before subscription lookup or cross-tab stringify. Enforce the same row and byte caps on every planned cache, plus 4,096 items and 512 KiB on optimistic history. Commit every valid planned state before listeners run, and fail the session without partial application on malformed or oversized input.
- [x] Cap aggregate retained client query rows and optimistic history at the exact 8 MiB serialized boundary. Deep-clone inbound state and every listener delivery, preserve own `__proto__` data properties without prototype mutation, validate multi-subscription plans before any commit, and release retained state on unsubscribe or terminal cleanup.
- [x] Cap charged Gateway durable subscription payload at 16 MiB, with registrations limited to 15 MiB so 1 MiB remains for staged snapshots. Charge exact stored UTF-8 plus bounded mutable metadata headroom, check arbitrary resume-cookie growth atomically, scrub retired payload while preserving cleanup identity, and repair legacy retired rows on restart.
- [x] Bound Cdb subscription identity fields at 256 UTF-8 bytes, all retained live-subscription rows at 8,192, and retired tombstone identities at 16 MiB. Keep an exact tombstone until Gateway completes its durable generation cleanup, then call exact idempotent finalization. Retry Gateway cleanup if unsubscribe or finalization fails.
- Presence and other experimental queues remain outside the supported path. Their retention limits are grouped in [`NEXT_SCOPE.md`](NEXT_SCOPE.md).
- [x] Define and test snapshot acknowledgement, durable retry until exact acknowledgement, and client same-cookie deduplication with re-acknowledgement.
- [x] Coalesce slow-consumer snapshot work behind one immutable staged outbox row. A configured workerd test withholds its acknowledgement, commits a bounded mutation burst, proves no second materialization occurs, then acknowledges once and receives one latest replacement snapshot.
- [x] Define and test pending mutation behavior across disconnect and shutdown. A transient disconnect retains the original request, `mutId`, and deadline for reconnect. Explicit `client.close()` or terminal session failure rejects each pending promise once with `CDB_STREAM_ABORTED`, while deadline expiry returns `CDB_MUTATION_OUTCOME_UNKNOWN` because commit status may be unknown.
- [x] Cover malformed and throwing Catalog authority responses in the configured Gateway workerd harness.
- [x] Add default-small, environment-scalable SDK workerd scenarios for two-tenant mutation fanout and selective subscription refresh. Assert exact rows, durable convergence, drained outboxes, and cleanup; emit timing telemetry without performance thresholds.
- [x] Split scaled two-tenant fanout into two write phases, replace half the clients after the first convergence point, rematerialize exact tenant rows, then complete the workload without duplicates or cross-tenant rows.
- [x] Assert exact per-sample Cdb accounting across both scale scenarios: one domain row, one op-log row, and one change-clock advance per successful mutation, with no counter movement during client churn or reconstruction.
- [x] During every scaled fanout sample, drop a bounded set of committed SDK mutation responses, hold each replacement connection before `hello`, and prove the first attempt advances the domain row, op-log, and change clock once. Release the replacement, require the same `mutId` and stored result to settle the original promise, and prove replay advances none of those counters or rows.
- [x] Reconstruct Cdb during every selective-refresh scale sample with all registrations active, prove exact registration identity and unchanged Gateway state, then recreate the SDK connection, prove exact new Gateway-to-Cdb registration matching, and complete the measured writes and materializations through the recovered topology.
- [x] Drive one configured Gateway to 256 active registrations with four real SDK clients, reject the 257th with retryable `CDB_RATE_LIMITED` before Cdb installation, release one exact slot, readmit one replacement, and drain Gateway and Cdb back to zero.
- [x] Use one correctness command that runs ordinary tests together and every workerd harness serially, with process-tree cleanup on timeout or cancellation.
- [x] Add a manual scale workflow with frozen `ci-smoke`, `client-max-accepted`, and `throughput` profiles and 1 to 20 sequential samples. Preserve per-sample output, write `chardb.scale.sample.v1` NDJSON records and a `chardb.scale.report.v1` aggregate with min, p50, p95, max, and mean, and record exact workload, Git, Bun, OS, and CPU metadata. Keep timing out of correctness decisions.
- [x] Prove through configured workerd that an already delivered but unacknowledged snapshot redelivers with the exact cookie and rows after Gateway and Cdb reconstruct around the same hibernated socket, then accepts one acknowledgement and delivers a later mutation.
- [x] Prove through configured workerd that socket loss after delivery but before acknowledgement replays the exact old cookie first, delivers a distinct current snapshot second, never enters `refetching`, and continues later delivery. Separately prove an unknown cookie receives one bounded lagged fallback before authoritative installation.
- [x] Prove through the configured workerd Gateway that an unsupported protocol returns `mustRefetch{protocolMismatch}` and closes with 1002 before JWT or JWKS verification.
The remaining named RPC and shard-eviction inventory and declared-platform performance targets remain in [`NEXT_SCOPE.md`](NEXT_SCOPE.md). The current benchmark output is telemetry and never decides correctness.

## 10. Make one real example

The chat directory consumes the packed package and passes compile-time checks. Its mutation and query declare the public organization authority contract. The clean-tarball smoke applies the packaged journal through the packed CLI, then runs Better Auth anonymous sign-in, the demo organization hook, an empty initial query, `postMessage`, and live replacement under workerd. It restarts Miniflare over the same Durable Object storage, reconstructs the original session before any new sign-in, issues a fresh JWT, replays the exact mutation with an identical result and one stored row, and continues the second-principal isolation proof. Online migration traffic and broader failure coverage remain incomplete.

- [x] Install the package through npm's packed file-dependency path with a committed consumer lockfile.
- [x] Declare every dependency used by the example.
- [x] Replace `chardb/react/index.ts` with `chardb/react`.
- [x] Replace `chardb/vite/index.ts` with `chardb/vite`.
- [x] Give `postMessage` a concrete organization partition key and reject an auth tenant mismatch.
- [x] Delete stale `tenantScope`, `ownerScope`, and `requirePermission` documentation.
- [x] Package the example's immutable schema journal through the Vite plugin and apply it before runtime traffic.
- [x] Add an idempotent auth hook that reuses the demo organization and user membership, tolerates confirmed concurrent creation, then sets the active organization.
- [x] Give `postMessage` an explicit stable ref and organization authority, and call it through the public mutation hook.
- [x] Make opening a channel in the clean packed chat consumer return and acknowledge an empty initial query result under workerd.
- [x] Make a second same-organization browser receive and acknowledge the packed live replacement before the later restart and isolation checks.
- [x] Add a second packed principal, move its session from `demo-org` to another organization, deny its `demo-org` query, and prove its own organization starts empty.
- [x] Install, typecheck, and build the example against the packed package instead of TypeScript aliases or source imports.
- [x] Add a clean-tarball workerd smoke that crosses the real WebSocket, Gateway, Worker, Catalog, Cdb, Better Auth, policy, mutation, query, and live-update paths.
- [x] Keep test-only raw SQL RPCs out of the packed smoke.
- [x] Add packed denial between principals in different organizations.
- [x] Replay the same packed mutation id and prove the stored result and row count do not change.
- [x] Restart Miniflare over the packed Worker's persistent Durable Object directory, reconstruct the original Better Auth session before any new sign-in, issue a fresh JWT for the restarted origin, replay the exact prior mutation and result, and prove the domain row still exists exactly once.

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
- [x] Confirm the current Gateway suites on a host that permits local workerd listeners: `gateway-live` 7/7 including the aggregate registration boundary and two default-small scale scenarios, `gateway-jwt` 22/22, and `gateway-snapshot` 6/6. Give the snapshot recovery cases 15-second test budgets. Treat sandbox failures to bind ephemeral port 0 as environmental, not as product evidence.
- [x] Add `bun run dev:worker`, which starts the exact local Wrangler worker, waits for health, applies the packaged journal through `chardb migrate`, prints the ready origin, forwards termination signals, and cleans up its full process group.
- [x] Define immutable contiguous migrations with ordered Cdb and Catalog SQL, bounded statement counts and bytes, stable digests, and rendered final-schema baselines.
- [x] Persist Catalog and Cdb active version, domain epoch, digest, migration id, phase, and completed steps. Keep the routing topology epoch separate from the domain schema epoch.
- [x] Make nonempty journals start at version zero and fail closed until the exact packaged target is active. Fence mutation, direct query, subscription, and registered-query work against the active domain epoch, including post-handler query checks.
- [x] Implement maintenance-mode `chardb migrate` over a token-protected internal HTTP API. Resume exact shard and Catalog steps with bounded concurrency, verify final rendered DDL, and publish the new epoch only after every step succeeds.
- [x] Implement explicit version-zero baseline adoption. Verify every existing Cdb and Catalog against the final rendered schema, execute no packaged SQL, preserve rows and op-log entries, and record the packaged version and digest.
- [x] Prove through configured workerd: persisted version-zero upgrade with data, fresh full-journal install, Catalog and Cdb reconstruction, stale and future epoch rejection, exact old mutation replay without handler rerun, final-schema baseline adoption without SQL replay, and baseline reconstruction.
- [x] Keep migrations forward-only and maintenance-mode. Do not claim down migrations or concurrent application reads and writes during an upgrade.

## 12. Fix package and repository hygiene

- [x] Add the MIT `LICENSE` file.
- [x] Correct the repository URL to `zpg6/chardb`.
- [x] Add `bugs` and correct homepage metadata.
- [x] Move `hono` to runtime dependencies.
- [x] Add direct metadata for `@standard-schema/spec` and packages referenced by emitted validator, auth, and React declarations.
- [x] Remove the unused `ulid` dependency.
- [x] Declare Bun 1.2.22 as the package-manager baseline.
- [x] Declare Bun 1.2.22 as the only supported package tooling and CLI runtime. Do not claim Node runtime support or publish a Node engine range until the package has a Node test matrix.
- [x] Use `bun.lock` at the root and keep `package-lock.json` only for the npm consumer fixture.
- [x] Stop tracking generated landing `.js`, `.d.ts`, and `.tsbuildinfo` files.
- [x] Add `prepack` so a clean package build always produces `dist`.
- [x] Fail the package build on warnings.
- [x] Stop publishing all of `src` unless there is a concrete consumer need.
- [x] Include `LICENSE` and `README.md` in the tarball.
- [x] Include `STATUS.md`, `ARCHITECTURE.md`, `SECURITY.md`, and `CONTRIBUTING.md` in the tarball.
- [x] Create an empty consumer fixture that installs the tarball and imports every advertised subpath.
- [x] Test the chat consumer's runtime imports and declarations from the packed package without workspace hoisting.
- [x] Install version 0.1.0 from a clean tarball and run `scripts/smoke-packed-chat.mjs` through sign-in, mutation, live replacement, persistent Miniflare restart, session reconstruction, exact mutation replay, one-row readback, and cross-organization denial.
- [x] Fix all Biome errors and warnings, or narrow the lint inputs deliberately and document why.
- [x] Add CI for frozen install, typecheck, lint, unit tests, serialized workerd tests, package build, package consumer tests, generated-project smoke, packed chat smoke, landing build, and example build.
- [x] Upgrade compatible `nanoid`, PostCSS, Sharp, SVGO, and `ws` dependency paths past their published advisories.
- The stable Miniflare dependency upgrade remains tracked in [`NEXT_SCOPE.md`](NEXT_SCOPE.md). The repository does not hide the advisory with an override.
- [x] Add and run a repeatable full-history scan for high-confidence private keys and provider credentials. CI checks out full history and runs `bun run security:history`; the local full-history run completed with no findings.

## 13. Rewrite the public story

The README and landing page now describe the repository as an experiment. Keep each claim within the boundaries recorded in the public status documents.

- [x] Change the README and landing page to call chardb an experimental prototype.
- [x] Lead with schema-derived organization tenancy and per-tenant transactions.
- [x] Remove "Unlimited SQL."
- [x] Remove the 160 TB claim.
- [x] Stop presenting automatic online resharding as supported and label it unfinished.
- [x] Label files, vectors, search, presence, scheduling, and automatic online migration as unsupported or experimental.
- [x] Remove the fake `[[chardb]]` binding and nonexistent `client(env.DB)` example.
- [x] Remove unpublished-package install commands from the README and landing page.
- [x] Replace dead Docs links with links to repository documents.
- [x] Replace internal engineering notes with public status documentation.
- [x] Add an architecture document that explains Worker, Gateway, Catalog, Cdb, transaction ownership, schema migration, auth verification, and subscription invalidation.
- [x] Add a status table that distinguishes implemented, tested in isolation, wired end to end, and experimental.
- [x] Keep every supported-path feature claim tied to a focused, configured workerd, packed-consumer, or generated-project test, and label the exact runtime each claim covers.

## 14. Work that stays deferred

Keep these out of the supported path while the remaining replay, isolation, online-migration, and recovery work is unfinished:

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
