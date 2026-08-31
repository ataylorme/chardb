# Operational safety and recovery

Chardb is not production-ready. This document records the controls and recovery actions that exist for the supported organization-tenanted path. It is a stop/go checklist for experiments, not a durability promise.

There is no backup, export, restore, point-in-time recovery, replica promotion, or region-failover path. Internal barrier records and Cdb bookmarks do not change that. A successful restart test proves process reconstruction against storage that still exists. It does not prove recovery after storage loss or corruption.

## Scope and assets

The supported deployment has one Worker and four SQLite Durable Object classes from the generated TOML-first `wrangler.toml` or an equivalent supported `wrangler.jsonc`:

- `Gateway` authenticates WebSockets and coordinates live-query registrations and delivery.
- `Catalog`, addressed by the fixed name `global`, stores Better Auth records, organization authority, routing, and schema epochs.
- `Cdb` stores organization rows, mutation outcomes, and live invalidation state for each physical shard.
- `Resharder` stores bounded progress for the private range-movement operator path.

The assets that need protection are the Catalog, Cdb, and Resharder SQLite stores, the packaged immutable migration journal, JWT signing material, Better Auth sessions and memberships, the `CDB_ADMIN_TOKEN` Wrangler secret, and the Durable Object class migrations and namespace bindings that connect a deployment to its existing storage. Internal calls use generated same-Worker Durable Object bindings. `ctx.exports` is a fallback only in runtimes that supply it and is not a substitute for those bindings in a generated deployment.

The threat model covers unauthenticated public callers, callers with a stolen user JWT, callers with the migration bearer token, operator mistakes, incompatible deployments, interrupted migrations, Durable Object unavailability, and storage loss. It does not claim protection from a compromised Cloudflare account, a malicious deploy operator, or an attacker who can replace both Worker code and secrets.

## Enforced boundaries

| Boundary | What the runtime enforces | What it does not solve |
| --- | --- | --- |
| Organization access | Gateway and the native DB binding verify the JWT signature and registered claims. Catalog reads current organization membership, role, and auth epochs for dispatch. Epoch changes commit with a durable invalidation job, and Cdb wakes matching idle live registrations so they rerun current authority without waiting for a domain write. Cdb reapplies the schema epoch and table policy before SQL runs. Client-supplied tenant and role claims do not grant access. | Revocation cannot cancel a Cdb call that Catalog already authorized. Principal invalidation is bounded but currently scans physical shards in pages of 32. Application routes outside Chardb still need their own authentication and input checks. |
| Query and mutation input | Public selects compile to a bounded plan rather than accepting SQL strings. Registered mutations use stable refs, bounded JSON arguments, one organization placement, policy checks, and mutation replay deduplication. | Deduplication does not reveal whether a timed-out mutation committed after the web client stops retaining its mutation ID. It does not undo a valid but unwanted write. |
| Live-query state | A client ID hashes into one of 4,096 Gateway buckets. Gateway and Cdb persist bounded registration, snapshot, acknowledgement, invalidation, and retry state. | Live state is not a second copy of domain data. Reconnecting can rebuild delivery, but it cannot recover lost Cdb rows. |
| Migration control | `/_chardb/migrations/*` returns 404 when `CDB_ADMIN_TOKEN` is absent and 403 for a wrong bearer token. The endpoint accepts bounded, exact JSON objects and can apply only steps in the packaged migration journal. | Anyone with the token can start or advance the packaged forward migration. There is no abort, reverse migration, or rollback endpoint. The route is still public unless the operator adds an external access control. |
| Range-movement control | `/_chardb/shards/start|status|drive|recover|abort` requires the same bearer token. Catalog atomically derives the current source owner, range, routing generation, and schema identity. The CLI exposes bounded `split`, `status`, `recover`, and `abort` operations; each drive advances at most one durable checkpoint. | Anyone with the token can move a supported organization range. The controller is private and experimental, destinations must be fresh, and unsupported schemas fail closed. Release evidence must include the combined row, file, and vector movement proof with verified cleanup. Repeated and regional runs, automatic balancing or resharding, backup, and recovery remain unsupported or unproven. Zero-row legacy recovery is unavailable because empty and missing provenance are indistinguishable. |
| Schema publication | The CLI records one migration owner, resumes exact completed steps, verifies journal digests and final schemas, and publishes the next epoch only after all shards finish. Each Cdb activation atomically queues every active live registration, so an idle query reruns under the new epoch without waiting for a domain write. Application traffic stays closed while Catalog reports `migrating`. | Delivery can outlive the activation call. A lost Gateway response remains in the durable outbox and retries after reconstruction; it does not roll the active schema back. An already-applied destructive statement cannot be reversed by Chardb. Changing or losing the journal during an interrupted migration can make safe completion impossible. |
| Durable Object placement | The generated config provisions `Gateway`, `Catalog`, `Cdb`, and `Resharder` and binds `CDB_GATEWAY`, `CDB_CATALOG`, `CDB_SHARD`, and `CDB_RESHARD` to those exact classes. Keeping class names, migration tags, and namespace bindings stable keeps a deployment connected to its existing stores. | A mistaken class migration or namespace change can point code at different storage. A runtime-provided loopback fallback does not repair a missing or wrong generated binding. Chardb has no discovery or reconciliation tool for that mistake. |

Cloudflare Worker deployment readiness and Durable Object code readiness are separate. A new HTTP release can be visible before Catalog or a Cdb has reconstructed under compatible code. Conversely, a warm version-two Durable Object can continue serving an internal call briefly while the HTTP Worker has been changed to obsolete version-one code. Treat the public release digest and Catalog schema version and epoch as two required readiness signals. Never infer Durable Object restart from a successful Worker deployment.

## Signals available today

Chardb does not ship an alerting system or an operator dashboard. Operators must collect these signals through their application and Cloudflare account:

- Chardb error envelopes expose a stable `code` and `retryable` flag. On the supported path, `CDB_STALE_EPOCH`, `CDB_TXN_ABORTED_EVICTION`, `CDB_RATE_LIMITED`, `CDB_SHARD_UNAVAILABLE`, and `CDB_CATALOG_UNAVAILABLE` are retryable. Do not infer retry behavior from message text.
- `CDB_MUTATION_OUTCOME_UNKNOWN` means the web client's mutation timer expired after its reconnect window. Do not submit a replacement mutation until an application read or business identifier establishes whether the first write committed.
- `CDB_FORBIDDEN` and `CDB_AUTH_NOT_BOUND` identify rejected authority or missing auth runtime. Repeated occurrences may be an attack, expired credentials, revoked membership, or a bad deployment. They are not retryable authorization overrides.
- `CDB_PARTITION_CONTRACT_CHANGED` during migration means the packaged journal or partition contract does not match recorded state. Stop. Do not replace the journal again to make the error disappear.
- `CDB_INVARIANT` indicates an internal state contradiction. It is not proof of data loss, but operators must treat it as a containment signal until the affected operation and store are understood.
- Chardb entrypoint responses include `cf-chardb-correlation-id`, `Cf-Chardb-Server-Version`, and `Server-Timing`. Record the correlation ID with the request time, release identifier, route, organization, and error code. Do not put tokens or row contents into logs.
- With the migration bearer token, `GET /_chardb/migrations/state` returns the active version, active epoch, status, migration owner, and target. `GET /_chardb/migrations/shards?migrationId=<id>` returns the recorded shard status and last error for the active migration.
- With the same token, `GET /_chardb/shards/status?migrationId=<id>` returns the exact movement identity and durable phase. Do not infer completion from an HTTP timeout; query status and resume the same migration ID.

No current signal proves that all expected Catalog or Cdb rows still exist. The application needs its own business-level counts or checksums if it wants to notice silent deletion or corruption.

## Before each experimental deployment

- [ ] Confirm that all stored data is disposable or can be rebuilt from an independent authoritative source. A copy in another Chardb table is not independent.
- [ ] Confirm that Wrangler provisions exactly `Gateway`, `Catalog`, `Cdb`, and `Resharder`, with `CDB_GATEWAY`, `CDB_CATALOG`, `CDB_SHARD`, and `CDB_RESHARD` bound to those exact classes. Confirm that the class names, migration tags, and namespace bindings still point at the intended deployment.
- [ ] Keep `CDB_ADMIN_TOKEN` in Wrangler secrets. Do not put it in TOML, JSONC, source, logs, shell history, or a client bundle.
- [ ] Leave `CDB_ADMIN_TOKEN` unset when no schema migration or range movement is planned. Both private controller families then return 404.
- [ ] Confirm that the application exposes only organization tenancy and, if intentionally enabled, the documented experimental organization-file and organization-vector lifecycles. Range movement is a private experimental operator path, not automatic resharding, a merge or rebalance service, or a public application API. Do not promote user-tenanted, global-table, PITR, presence, stream, schedule, or distributed-transaction internals into the deployment contract.
- [ ] Run typecheck, lint, unit tests, serialized Workerd suites, and the clean-tarball generated and browser proofs against the exact package to deploy.
- [ ] For disposable staging, run `preview:cloudflare` against that exact gate artifact. Require every stage to pass, verify `evidence.sha256`, and keep its private directory out of artifacts and source control.
- [ ] Record the release identifier, schema journal digest, active schema version, active epoch, Wrangler configuration, and deployment time outside Chardb.
- [ ] Configure application and Cloudflare monitoring for error codes, HTTP status, correlation IDs, and unexpected migration-route access. Chardb does not configure this monitoring.

## Before a migration

- [ ] Read every statement in the immutable journal. Mark destructive statements and decide how the application would rebuild affected data without Chardb restore.
- [ ] Test the exact package and journal against a disposable copy or fixture. A local Miniflare directory is not a backup of deployed data.
- [ ] Choose and record one unique migration ID and target version. Keep the same values for every resume attempt.
- [ ] Do not use `--baseline` as a repair shortcut. It is only for adopting version-zero storage with the complete packaged journal, and it does not create a backup or rollback point.
- [ ] Set a fresh `CDB_ADMIN_TOKEN` secret and restrict the route with Cloudflare controls when the deployment requires it.
- [ ] Close application traffic before starting. The migration machinery rejects stale-epoch work, but it does not make mixed-version application traffic safe.
- [ ] Query migration state and confirm the expected active version and epoch before running the CLI.
- [ ] Run `CHARDB_ADMIN_TOKEN=<secret> chardb migrate --url <worker-url> --id <migration-id> --target <version>`. Add `--concurrency` only after testing the chosen value.
- [ ] Keep the exact Worker bundle, journal, migration ID, target, and Wrangler configuration until the migration reports `active` at the target version.
- [ ] Remove or rotate `CDB_ADMIN_TOKEN` after completion.

## Before an experimental range movement

- [ ] Treat the destination as disposable and verify it is fresh. Do not use the command as a merge or rebalance tool.
- [ ] Keep the exact package, `wrangler.toml` or supported JSONC, schema journal, admin token, movement ID, range, and destination shard until terminal phase 6.
- [ ] Verify that the range has one current Catalog owner and that no schema migration or topology operation is active.
- [ ] Run `CHARDB_ADMIN_TOKEN=<secret> chardb experimental shards split --url <worker-url> --id <movement-id> --lo <lo> --hi <hi> --to <destination> --max-steps <cap>`. Reuse the exact command after retryable transport loss.
- [ ] Use `chardb experimental shards status` before deciding whether to drive, recover, or abort. Never create a replacement movement ID after partial progress unless the documented recovery path requires a fresh ID.
- [ ] Use `chardb experimental shards recover` only for the legacy phase-three-and-later case. It verifies the exact Catalog owner and generation. A source-owned route aborts Catalog before canceling the fence and cleaning participants; a destination-owned route activates and resumes without replaying unknown legacy tail.
- [ ] Do not force zero-row legacy recovery. The runtime rejects it because no trusted pre-upgrade manifest distinguishes an empty range from lost metadata.
- [ ] Keep the application closed if the command stops without a terminal status. Preserve the first error, phase, movement identity, Catalog owner, and routing generation.
- [ ] Run the disposable combined movement driver against the exact release tarball. Require immutable version and 100% traffic receipts, matching semantic run keys and payloads, every correctness flag, bounded cleanup on both targets, and independent Worker, bucket, and Vectorize index absence checks. Component or earlier-candidate evidence cannot satisfy this gate.
- [ ] Treat deployed native R2 operation counts as unobservable. Require stable key, byte, ETag, and inventory digests remotely; use the local Cdb proxy when exact `put` and `delete` accounting is required.

## Incident containment

Do these steps before trying to repair anything:

1. Stop new deployments and migration commands. If unauthorized access or incorrect writes may continue, withdraw public traffic using the deployment's Cloudflare controls.
2. Preserve the current Worker bundle, migration journal, Wrangler configuration, migration ID, target version, and release metadata. Do not rename Durable Object classes or bindings.
3. Record the first failure time, affected organization, operation or subscription ID, stable error code, retryable flag, correlation ID, server version, and relevant Cloudflare request logs. Redact JWTs and the admin token.
4. If the migration route or token may be compromised, remove or rotate `CDB_ADMIN_TOKEN` immediately. Removing the secret disables the route with a 404 response.
5. Query migration state only after the token is under control. Record `status`, `activeVersion`, `activeEpoch`, `migrationId`, `targetVersion`, and every shard's `status` and `lastError`.
6. Classify the incident using the playbooks below. Do not edit Durable Object SQLite tables by hand.

## Recovery playbooks

### Transient Gateway, Catalog, Cdb, or Worker failure

1. Keep the existing Durable Object bindings and deployed journal.
2. Retry only when the error envelope says `retryable: true`. Honor `retryAfterMs` when present.
3. Let the web client reconnect while its mutation promise remains pending. It resends that pending mutation with the same ID. After `CDB_MUTATION_OUTCOME_UNKNOWN`, read and reconcile application state before deciding whether to issue another write.
4. For native `env.DB` mutations, retain and reuse the original `mutId` when retrying. Creating a new ID asks for a new write.
5. Reconnect live clients and wait for a fresh snapshot. Treat a recovered subscription as delivery recovery, not data recovery.
6. Escalate to containment if errors persist, switch to `CDB_INVARIANT`, or affect only one organization or shard in a repeatable way.

There is no secondary Catalog or Cdb to promote. If Cloudflare cannot make the existing Durable Object storage available again, proceed to the hard-stop section.

### Interrupted forward migration

1. Keep application traffic closed.
2. Query `/_chardb/migrations/state`. If it reports `active` at the requested target, the migration already completed.
3. If it reports `migrating`, query the shard list with the recorded migration ID. Preserve every `lastError` before retrying.
4. Confirm that the deployed journal, its digests, migration ID, and target match the values that began the migration.
5. Run the same `chardb migrate` command with the same migration ID and target. Completed steps are checked and reused; pending shard and Catalog steps resume.
6. Reopen traffic only after state reports `active` at the target version and the application read, write, live-query, and restart checks pass on a disposable organization.

Do not start a second migration ID to take ownership. There is no supported way to abandon an active migration or roll back statements that already ran.

### Migration-token exposure

1. Remove or rotate `CDB_ADMIN_TOKEN` and withdraw traffic if an unauthorized migration may be running.
2. Inspect migration state and shard errors with the replacement token.
3. Compare the recorded owner and target with the operator's change record.
4. If an unauthorized migration only began but used the packaged journal, review every pending and applied step. Resume the same owner only if completing that exact forward migration is safe.
5. If an unauthorized destructive step ran, do not claim recovery. Chardb cannot restore the prior data or schema.

### User JWT, session, or membership incident

1. Block affected application traffic and revoke the session or organization membership through the application's Better Auth management path.
2. Catalog will reject later dispatches and durably wake matching idle live registrations after the authority epoch changes. Assume an already-authorized Cdb call may still finish.
3. If signing material may be compromised, stop issuing and accepting affected tokens, then use the application's tested Better Auth key and session rotation procedure. Chardb does not provide a bulk key-rotation or session-revocation command.
4. Review application audit data for accepted writes. Chardb mutation deduplication is not an audit log and cannot undo them.

Do not reopen traffic until the application can prove that old tokens fail and current membership produces the intended role and column policy.

### Bad Worker deployment or binding change

1. Withdraw the bad deployment and compare its Wrangler config with the last recorded good config.
2. If no schema step ran, redeploy compatible code with the original Durable Object class names, bindings, and journal.
3. If migration state is `migrating`, use the interrupted-migration playbook. Do not deploy an older or edited journal.
4. If the migration completed, do not assume the previous Worker is schema-compatible. Use a reviewed forward fix with a new journal version.
5. If code wrote to a different Durable Object namespace, isolate both deployments. Chardb has no merge or reconciliation tool.

After restoring compatible code, wait for both the expected `/health` release identity and `/_chardb/migrations/state` at the expected active version and epoch. A temporary `newer than packaged version` response after restoration means an obsolete Durable Object instance or control-plane propagation is still present. Keep traffic closed and retry only for a bounded period. If compatible state does not become readable, stop under the invariant and migration hard-stop rules.

### Known bad application write

If the affected rows are known and the active schema still accepts a compensating organization mutation, the application may write a reviewed correction. This is a new write, not a restore. If the correct prior values are unknown, stop. Chardb cannot reconstruct them.

## Hard-stop conditions

Keep traffic closed and do not describe the incident as recovered when any of these is true:

- Catalog storage is missing or corrupt. Its auth records, memberships, routing map, and schema state have no supported reconstruction path.
- A Cdb store is missing or corrupt and no independent authoritative copy contains every required organization row.
- A user or migration deleted or overwrote data and the correct prior values are unknown.
- Recovery requires a point-in-time, barrier, snapshot, export, replica, or regional copy. None exists.
- An active migration's exact journal, digest sequence, migration ID, or target is missing or no longer matches recorded state.
- A destructive migration step ran and recovery requires reverse DDL or old row contents.
- Durable Object bindings or namespaces changed and the operator cannot prove which store received writes.
- JWT signing material was compromised and the application has no tested way to rotate keys and invalidate affected sessions.
- `CDB_INVARIANT` repeats after a compatible redeploy and process restart, or there is evidence of persistent Catalog or Cdb state contradiction.

At a hard stop, preserve evidence, disclose the durability limit to affected users, and rebuild only from an independent source under a new, reviewed deployment. If no such source exists, the data is unrecoverable with Chardb today.

## Criteria for reopening traffic

- [ ] The cause and affected organizations, shards, releases, and time range are recorded.
- [ ] No hard-stop condition remains unresolved.
- [ ] Wrangler bindings and Durable Object class migrations match the intended stored deployment.
- [ ] Migration state is `active` at the expected version and epoch. No different migration owner is present.
- [ ] Compromised admin tokens, JWT signing material, sessions, and memberships have been handled through tested operator or application controls.
- [ ] A disposable organization can sign in, write, read, subscribe, restart, and read again through the deployed package.
- [ ] Known business-level row counts or checksums match an independent source where one exists.
- [ ] Monitoring shows no continuing authorization spike, retry storm, shard failure, Catalog failure, or invariant error.

Passing this checklist supports reopening an experiment. It does not prove that no rows were lost, and it does not make the deployment production-ready.
