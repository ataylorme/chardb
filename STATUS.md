# Chardb status

Chardb is an experimental architecture prototype. Its package and generated scaffold can be built and inspected, but it is not ready for production data. The repository contains substantial routing, transaction, policy, auth, and resharding work, but the main application flow is not connected end to end.

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
| Wire protocol and decoding | Implemented | Protocol v2 carries `protocolV` in `hello` and `welcome`, and subscriptions carry only a server-stamped query ref plus raw arguments. The decoder rejects missing, extra, and incorrectly typed fields. Compatibility enforcement has focused tests. |
| Op-log idempotency | Implemented | Replay, request collision, error envelopes, and rollback behavior are tested against the synchronous SQL abstraction. |
| Atomic domain transaction core | Isolated | A focused workerd test runs two Drizzle writes and the op-log in one Durable Object SQLite transaction and tests rollback and replay. Gateway now verifies identity, but the public WebSocket path has no tenant membership, role, or policy authority with which to call the trusted dispatcher. |
| Catalog routing and snapshot barrier storage | Isolated | Focused workerd tests use real Durable Object SQL storage. Full scheduled backup and restore do not exist. |
| Cdb reshard copy and tail RPCs | Isolated | Focused workerd tests cover bulk copy, trigger capture, tail replay, and range filtering. They do not drive the complete Resharder object through a deployed application. |
| End-to-end domain mutation | Missing | Gateway, Catalog, and Cdb share a serializable request and response contract, and Cdb resolves the handler locally. Public WebSocket mutations verify identity, then fail closed with `CDB_AUTH_NOT_BOUND` because membership, role, and policy authority are absent. |
| Query registration | Partial | The isolated routing path resolves the query ref, validates arguments, derives intent and a hash on the server, and can register with Cdb. Public subscriptions now fail closed before routing because verified identity does not establish tenant membership. Scatter routing can miss narrow Catalog ranges because it probes every 256th virtual shard. |
| Initial query | Missing | A subscription registers intervals but Cdb never invokes its query descriptor or returns the initial row set. |
| Live query update | Missing | Interval matching and patch batching exist, but committed writes do not produce row patches through the public runtime. |
| WebSocket reconnect and cookies | Isolated | The client state machine is tested with a fake WebSocket. The full Worker, Gateway, and Cdb resume path is not tested together. |
| Presence | Partial | Gateway publish and fan-out helpers exist, but public presence operations fail closed after identity verification because membership and policy authority are absent. No React presence hook is exported. |
| Auth schema synthesis and SQL operations | Implemented | Core and plugin tables, epoch-scope rules, and SQL helpers have focused tests. |
| Catalog auth DDL | Implemented | Catalog renders executable DDL with keys, uniqueness, foreign keys, indexes, supported defaults, nullability, and SQLite types. Existing tables require matching `auth_ddl_v1` signatures. There is no versioned upgrade path. |
| Better-auth adapter | Partial | All synthesized auth models use singleton Catalog storage, and Cdb no longer stores or indexes auth rows. Each auth mutation and every directly derivable old and new global, tenant, or principal epoch scope commit in one Catalog transaction. Bulk updates and deletes preload matched rows to derive those scopes. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. Better Auth workflows remain sequential because the adapter reports `transaction: false`. Coverage uses a Bun fake-Durable-Object harness, not workerd; restart evidence and a full sign-in-to-domain-write test are missing. |
| Gateway JWT identity verification | Implemented | Configured Gateway `hello` and `updateAuth` verify real signatures, subject, expiry, not-before, issuer, audience, and allowed algorithms through the Catalog JWK resolver contract. A Miniflare workerd test drives the actual Gateway Durable Object and WebSocket with ES256 tokens and a real Catalog SQLite cache. It seeds `Catalog.putJwk` through a test-only HTTP route, so outbound JWKS fetch, cache refresh, and key rotation remain untested. Membership, role, and policy authority are separate and still missing. |
| Row and column authorization | Partial | Policy compilation, row predicates, column masks, writable-column checks, and insert auto-fill have focused tests. They are not applied by a complete query and mutation executor. |
| Schema migration | Missing | The CLI prints migration SQL. It does not apply DDL across shards, coordinate a barrier, resume after failure, or roll back. |
| Snapshot export and restore | Missing | Barrier bookmarks exist. Durable export, restore, and verification do not. |
| Complete online resharding | Partial | The phase machine and shard RPCs exist, with focused tests and a TLA+ model. Automatic triggers, the entire Resharder RPC sequence, concurrent application writes, and recovery are not validated end to end. |
| Cross-partition transaction | Isolated | A two-phase protocol and recovery tests exist. The default runtime has no bound participant implementation and raises `CDB_DT_NOT_IMPLEMENTED`. |
| Files and uploads | Missing | Drizzle column types and validators exist. Runtime handles throw for upload and delete. No React upload hook or runtime HTTP endpoint is exported. |
| Vector search and streams | Missing | Types and helper code exist. No React stream or vector-search hooks and no runtime HTTP endpoints are exported. |
| Package and generated project | Implemented | The npm tarball contains `dist` and public documentation, not `src`. CI installs the tarball in empty consumers and checks advertised imports. `chardb init` emits pinned dependencies, TypeScript config, six Durable Object bindings, assets, and an honest prototype README; CI installs, typechecks, and asks Wrangler to bundle that project without workspace aliases. |
| Operational CLI | Partial | Project generation, Wrangler checks, explain logic, and deploy-plan helpers exist. Migration apply, shard operations, export, restore, and schedule operations remain incomplete or labeled placeholders. |

Only `/ws` and `/_chardb/*` are reserved Chardb routes. `/api/auth/*` is mounted when Better Auth is configured. Removed placeholder paths such as `/q`, `/f`, `/p`, and `/s` fall through to the application. React exports no placeholder presence, upload, stream, or vector hooks.

The committed trust boundary is deliberately narrow. Gateway sends `welcome` and stores a verified attachment only after JWT verification. It stores no tenant or role claims from the token. Verified identity alone cannot authorize tenant data. Mutations, subscriptions, and presence reject with `CDB_AUTH_NOT_BOUND` until Catalog-derived membership, role, auth epoch, and policy authority are available.

## The missing application flow

The runtime still needs one real application test that proves this sequence against the packed package and workerd:

1. open the configured Gateway under workerd and verify a real signed JWT;
2. resolve tenant membership, role, auth epoch, and policy authority from Catalog;
3. run a tenant-scoped mutation inside the owning Cdb transaction;
4. commit the domain rows and op-log result atomically;
5. execute the initial tenant-scoped query;
6. deliver a live update after the mutation;
7. reject a second tenant's read and write attempts;
8. replay the mutation id without running the handler twice.

Until that test passes, passing helper tests do not establish that Chardb works as a database.

## Verification state

CI runs the strict TypeScript check, repository-wide Biome check, package and landing builds, packed-package import checks, generated-project checks, and the packed chat typecheck and build. The tarball is limited to `dist`, the license, and public documentation.

CI runs ordinary tests together and starts each Miniflare workerd harness in its own process to avoid shared-port collisions. Those focused harnesses do not replace the missing configured-application restart and end-to-end tests.

The remaining work is listed in dependency order in [`PLAN.md`](PLAN.md). Runtime relationships are described in [`ARCHITECTURE.md`](ARCHITECTURE.md).
