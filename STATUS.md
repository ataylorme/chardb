# Chardb status

Chardb is an experimental architecture prototype. It is not ready for production data or an npm release. The repository contains substantial routing, transaction, policy, auth, and resharding work, but the main application flow is not connected end to end.

This status reflects the code in the repository, not the broader product described by older comments or generated examples.

## Status definitions

| Label | Meaning |
| --- | --- |
| Implemented | Code exists and its normal local path is exercised by tests. |
| Isolated | The component is exercised with pure helpers, a fake client, or a focused workerd worker, but not through a deployed Chardb application. |
| Partial | Some runtime pieces exist, but a required step or safety check is absent. |
| Missing | The advertised behavior has no working runtime path. |

## Capability matrix

| Capability | Status | Evidence and limit |
| --- | --- | --- |
| Virtual-shard hashing and range routing | Implemented | Deterministic key encoding, 16,384 virtual shards, range splits, and routing tests live in [`src/vshard.ts`](src/vshard.ts) and [`test/vshard.test.ts`](test/vshard.test.ts). |
| Foreign-key colocation derivation | Implemented | The graph derivation and determinism properties are tested in [`test/colocation/derive.test.ts`](test/colocation/derive.test.ts). |
| Schema-bound tenancy metadata | Implemented | `forOrg`, `forUser`, `globalScope`, role matrices, and column rules have construction and compiler tests. Runtime enforcement is separate and remains partial. |
| Manifest construction and mutation routing decision | Implemented | Ref discovery, stable refs, configured Gateway lookup, virtual-shard selection, Catalog routing, and typed Cdb dispatch have focused tests. |
| Op-log idempotency | Implemented | Replay, request collision, error envelopes, and rollback behavior are tested against the synchronous SQL abstraction. |
| Atomic domain transaction core | Isolated | A focused workerd test runs two Drizzle writes and the op-log in one Durable Object SQLite transaction and tests rollback and replay. The trusted Gateway dispatcher calls this path, but the public WebSocket path has no verified auth source yet. |
| Catalog routing and snapshot barrier storage | Isolated | Focused workerd tests use real Durable Object SQL storage. Full scheduled backup and restore do not exist. |
| Cdb reshard copy and tail RPCs | Isolated | Focused workerd tests cover bulk copy, trigger capture, tail replay, and range filtering. They do not drive the complete Resharder object through a deployed application. |
| End-to-end domain mutation | Missing | Gateway, Catalog, and Cdb now share a serializable request and response contract, and Cdb resolves the handler locally. Public WebSocket mutations fail closed with `CDB_AUTH_NOT_BOUND` until Gateway verifies JWTs and membership. |
| Initial query | Missing | A subscription registers intervals but never invokes its query descriptor or returns the initial row set. |
| Live query update | Missing | Interval matching and patch batching exist, but committed writes do not produce row patches through the public runtime. |
| WebSocket reconnect and cookies | Isolated | The client state machine is tested with a fake WebSocket. The full Worker, Gateway, and Cdb resume path is not tested together. |
| Presence | Partial | Gateway publish and fan-out code exists. No React presence hook is exported because the client path is incomplete. |
| Auth schema synthesis and SQL operations | Implemented | Core and plugin tables, epoch-scope rules, and SQL helpers have focused tests. |
| Better-auth adapter | Partial | All synthesized auth models use singleton Catalog storage. A focused Bun SQLite/Durable Object harness covers create and lookup by email, session token, provider/account key, and membership fields, plus update, delete, and same-storage Catalog reconstruction. Complete unique, foreign-key, and index DDL, adapter transactions, a real workerd restart test, and a full sign-in-to-domain-write test are still missing. |
| JWT authentication | Partial | Signature, issuer, audience, expiry, and JWK resolution code exists and has unit tests. Gateway hello uses decode-only claims and does not call the verifier. |
| Row and column authorization | Partial | Policy compilation, row predicates, column masks, writable-column checks, and insert auto-fill have focused tests. They are not applied by a complete query and mutation executor. |
| Schema migration | Missing | The CLI prints migration SQL. It does not apply DDL across shards, coordinate a barrier, resume after failure, or roll back. |
| Snapshot export and restore | Missing | Barrier bookmarks exist. Durable export, restore, and verification do not. |
| Complete online resharding | Partial | The phase machine and shard RPCs exist, with focused tests and a TLA+ model. Automatic triggers, the entire Resharder RPC sequence, concurrent application writes, and recovery are not validated end to end. |
| Cross-partition transaction | Isolated | A two-phase protocol and recovery tests exist. The default runtime has no bound participant implementation and raises `CDB_DT_NOT_IMPLEMENTED`. |
| Files and uploads | Missing | Drizzle column types and validators exist. Runtime handles throw for upload and delete. No React upload hook or runtime HTTP endpoint is exported. |
| Vector search and streams | Missing | Types and helper code exist. No React stream or vector-search hooks and no runtime HTTP endpoints are exported. |
| Operational CLI | Partial | Config rendering, Wrangler checks, explain logic, and deploy-plan helpers exist. Migration apply, shard operations, export, restore, and schedule operations are incomplete or placeholders. |

Only `/ws` and `/_chardb/*` are reserved Chardb routes. `/q`, `/f`, `/p`, and `/s` are not feature endpoints; requests to those paths fall through to the application.

## The missing application flow

The runtime still needs one real application test that proves this sequence against the packed package and workerd:

1. sign in and verify the JWT before accepting its claims;
2. run a tenant-scoped mutation inside the owning Cdb transaction;
3. commit the domain rows and op-log result atomically;
4. execute the initial tenant-scoped query;
5. deliver a live update after the mutation;
6. reject a second tenant's read and write attempts;
7. replay the mutation id without running the handler twice.

Until that test passes, passing helper tests do not establish that Chardb works as a database.

## Verification state

The strict TypeScript check, repository-wide Biome check, package build, landing build, and packed chat typecheck and build pass. The package dry-run includes the MIT license.

CI runs ordinary tests together and starts each Miniflare workerd harness in its own process. The workerd harnesses can still fail to acquire their ephemeral port in this local sandbox, so CI on a normal runner remains the useful result for that part of the suite.

The remaining work is listed in dependency order in [`PLAN.md`](PLAN.md). Runtime relationships are described in [`ARCHITECTURE.md`](ARCHITECTURE.md).
