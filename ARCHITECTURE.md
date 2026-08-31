# Architecture

Chardb's supported runtime is one Worker and four SQLite Durable Object classes.

```text
browser or server code
          |
          v
    application Worker
      |           |
      | /ws       | env.DB through ctx.exports
      v           v
    Gateway ---- Catalog ---- Resharder
      |             |             |
      +-----------> Cdb <---------+
```

The generated `wrangler.toml` provisions `Gateway`, `Catalog`, `Cdb`, and `Resharder` and binds their same-Worker namespaces as `CDB_GATEWAY`, `CDB_CATALOG`, `CDB_SHARD`, and `CDB_RESHARD`. Chardb owns those internal bindings; application routes use the exported `DB` binding. Explicit bindings are the primary Durable Object path. `ctx.exports` remains a fallback only where the runtime supplies it. Doctor accepts and validates the exact mapping in TOML or JSONC.

## Public code boundary

The npm package has five import paths:

- `@chardb/core` for clients, the native binding builder, and shared errors;
- `@chardb/core/server` for organization tables, server handles, auth, migrations, and `chardb()`;
- `@chardb/react` for the provider and hooks;
- `@chardb/core/files` for organization file columns and the same-origin file client;
- `@chardb/core/vite` for stable refs and ref-only query and mutation handles in browser builds.

The CLI is published as the `chardb` binary. Its primary commands are `init`, `doctor`, `migrations generate`, `vectorize prepare`, and `migrate`. Range movement is available under `experimental shards` and is absent from primary help. Durable Object classes and internal routing, RPC, policy, migration, and experimental modules do not have package import paths.

`chardb()` returns the Worker fetch handler, the native `DB` entrypoint, and the four configured Durable Object classes. The application exports those fields for Wrangler.

## Organization placement

`forOrg()` marks a table with its organization partition column and policy metadata. The placement compiler follows declared colocation and hashes one exact organization key to a virtual shard. Catalog maps that virtual shard to one physical Cdb id.

Public mutations accept only `authority: "organization"`. Planned queries derive the same boundary from their organization table and exact predicate. Gateway verifies the JWT subject, then Catalog reads current organization membership, role, and auth epochs. Client tenant and role claims never grant access. Cdb reapplies the schema epoch and table policy before SQL runs.

User-tenanted and global-table metadata still exists for internal conformance tests. It is not a public data model.

## Mutation path

```text
stable mutation handle and bounded JSON args
  -> Gateway verifies identity
  -> Catalog derives current organization authority and route
  -> Cdb resolves the local handle
  -> policy wrapper adds the organization floor
  -> one SQLite transaction commits domain SQL and operation-log result
```

The operation log gives one mutation id one stored result. A reconnect can resend the same id. A collision or changed payload fails closed. Schema epochs fence stale Workers before new work commits.

## One select plan

Chardb exposes two select front ends:

1. a registered planned query used by live subscriptions;
2. a direct full-row builder used through `client(env.DB, ...)`.

Both compile to `ChardbSelectPlanV1`. The plan contains the table, full-row selection, typed predicate tree, ordering, limit, and result mode. The compiler rejects unknown keys, foreign columns, raw SQL, joins, projections, callbacks, placeholders, scatter, and values outside strict JSON limits.

The Worker resolves a plan against its packaged schema. Cdb resolves it again, checks route and policy metadata, then calls the same `executeResolvedSelectPlan` runner for direct and registered work. Registered queries add generation, intent, and live-read checks around that runner. They do not have a second SQL compiler or executor.

## Live-query ownership

Gateway owns authenticated WebSockets, subscription admission, rerun scheduling, snapshot delivery, acknowledgement, and recovery orchestration. The full client id hashes into one of 4,096 Gateway buckets.

`gateway-registration-store.ts` owns the durable registration schema, stored row types, payload accounting, and synchronous state transitions. Keeping SQL transitions out of `gateway.ts` gives registration lifecycle rules one owner. Gateway still needs further splitting, but socket orchestration no longer edits those rows through scattered SQL.

`gateway-auth-dispatch.ts` owns JWT verification, verified attachment checks, organization authorization, mutation dispatch, and the projection of Cdb mutation responses. `gateway-alarm-store.ts` owns serialized alarm writes and the SQL that selects the next durable work deadline. `gateway-snapshot-materializer.ts` owns due-run selection, fresh route and authority checks, query leases, Cdb reruns, and retirement. `gateway-snapshot-delivery.ts` owns durable staging, send leases, retries, exact delivery, and acknowledgement settlement. `gateway.ts` retains socket identity, task tracking, and coordination.

`cdb-live-store.ts` owns durable live-subscription rows, tombstones, capacity checks, invalidation outbox transitions, retries, acknowledgements, and the next alarm lookup. `cdb-query-execution.ts` owns resolution and execution of direct and registered select plans. `cdb-mutation-execution.ts` owns mutation admission, atomic domain writes, op-log replay, schema fencing, and transactional invalidation enqueue. `cdb-schema-migration-store.ts` owns schema-state transactions, journal checks, baselines, step application, activation, and migration epoch fences. The file store, runtime, and download helper own metadata transitions, organization fences, bounded R2 cleanup, and policy-aware resolution. `cdb.ts` retains RPC coordination, post-commit invalidation delivery, and the private range-movement RPC boundary. That movement boundary is still a large extraction target, not a finished ownership split.

Cdb stores active registrations and table intervals. A successful mutation advances its change clock and writes matching invalidations in the same transaction as domain data. Schema activation similarly publishes the new Cdb epoch and queues every active registration in one transaction, even when no domain row changed. Gateway claims dirty registrations, asks Cdb to rerun the canonical plan, stages an immutable replacement snapshot, and retries delivery until the exact cookie is acknowledged or bounded recovery retires it. A lost first Gateway response remains in the Cdb outbox, and cold reconstruction retries the same change sequence.

## Catalog ownership

`catalog-schema-store.ts` owns schema bootstrap and synchronous migration-state transitions. `catalog-barrier-store.ts` owns barrier row initialization, reads, and writes. `catalog-authority-store.ts` owns auth persistence, authority projections, canonical roles, auth-epoch SQL, and exact organization-delete effects. `catalog-routing-store.ts` owns range loading, shard inventory, guarded split cutover, routing epoch changes, and post-commit cache publication. `catalog-organization-deletion-store.ts` owns permanent organization identity fences and the bounded per-organization/per-shard Cdb handoff outbox. `catalog.ts` retains RPC plus cross-owner migration, deletion, and private movement coordination.

Catalog owns:

- virtual-shard range routing;
- Better Auth records and schema signatures;
- organization membership and auth epochs;
- migration state and domain schema epochs;
- JWK cache and refresh coordination.

Catalog is the authorization decision point for each new dispatch and dirty live rerun. Revocation blocks later work. It cannot cancel a Cdb call that Catalog already authorized.

Catalog still has internal barrier tables and methods. Cdb still has a bookmark method. The supported Worker does not schedule PITR barriers. Retention, export, restore, and verification do not exist, so these pieces are research code rather than a backup system.

## Measurement artifacts

The scale runner writes raw `chardb.scale.sample.v1` records, a `chardb.scale.run.v1` state file, and a `chardb.scale.report.v1` summary. Each run records its named workload profile, Git state, Bun version, operating system, architecture, CPU model, logical CPU count, and CI runner name. The report keeps every sample in NDJSON and summarizes minimum, p50, p95, maximum, and mean values.

The scale comparator accepts two reports only when suite, named profile, scenarios, and metric sets match. It compares latency p50 and p95 as lower-is-better, and throughput p50 and minimum as higher-is-better. The caller must provide the allowed regression percentage. The comparator emits `chardb.scale.comparison.v1` and exits nonzero when a comparison exceeds that supplied limit. Chardb does not ship a universal scale threshold.

The packed browser runner writes `chardb.packed-browser.report.v1`. The report names the platform and records operating system, architecture, runtime and browser versions, exact tarball SHA-256 digest and byte count, every raw timing sample, percentile summaries, and restart timings. The smoke profile collects three samples with no warmup. The benchmark profile collects one warmup followed by 25 measured samples. Browser regression thresholds remain unset until repeated named-platform runs establish variance.

## Migration

The packaged migration journal is immutable and contiguous. `chardb migrate` enters maintenance mode, applies bounded Cdb and Catalog steps, verifies the rendered final schemas, and publishes the new domain epoch only after every shard completes. Each Cdb activation atomically wakes its active live registrations so they rerun under the new epoch without waiting for another write. Exact completed steps and pending invalidations survive restart. Application traffic during migration is rejected with a stale-epoch error.

## Build split

Server and SSR builds keep query callbacks and mutation handlers so the manifest and Cdb can compile or execute them locally. Browser builds replace supported explicit-ref `api.query` and `api.mutation` exports with lightweight typed handles. Server schema, auth, migration, Cloudflare, and Drizzle compiler code must not appear in the browser output.

The packed-browser proof checks planned-query erasure from the published tarball, uses dispatch-only stable mutation handles, then runs the React and file hooks in headless Chrome against Wrangler, Miniflare, and native local R2. It covers two-organization isolation, attachment replacement, restart persistence, Better Auth deletion, and the surviving organization's exact bytes. The generated-project proof uses the same tarball to test the native binding, planned live query, migration, auth, persistence, and restart path.

`build.config.ts` defines eight production roots. Five match the package export map. The other three are the CLI binary, its schema-inspector preload, and the private Vectorize proof bundle. Application Workers reach the Worker entrypoint and Durable Object classes through the `chardb()` factory in the server bundle. They do not load separate source roots.

`test/source_reachability.test.ts` traces relative static and dynamic imports from those roots, the test tree, scripts, and examples. It keeps test-only research code separate from shipped code. That group currently contains the auth-profile and colocation experiments, the ESLint and observability prototypes, distributed-transaction, ledger, logpush, and merge helpers, plus the old deploy command test fixture and CLI barrel. Workerd `*.entry.ts` files are test runtime entrypoints loaded by their harnesses. `src/eslint-plugin/peer-deps.d.ts` is compiler input through `tsconfig.json`, not a JavaScript entrypoint.

## Unsupported systems

The range-movement operator remains private and experimental even though Wrangler provisions `Resharder` and `chardb()` exports the class. Distributed transactions, presence, streams, schedules, PITR, export, and restore are outside the public architecture. Organization files and vectors are public experiments only for the organization-owned descriptors documented in the README. Other implementation and conformance code carries no compatibility promise and cannot be reached through the five public package entries.
