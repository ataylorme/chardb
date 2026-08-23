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
| Manifest construction and mutation routing decision | Implemented | Ref discovery, configured Gateway lookup, virtual-shard selection, Catalog routing, and typed Cdb dispatch have focused tests. Public organization mutations require an explicit stable ref. A workerd test imports two refs from a real emitted Vite browser chunk and matches them against an independently bundled Worker manifest. |
| Wire protocol and decoding | Implemented | Protocol v3 carries `protocolV` in `hello` and `welcome`, subscriptions carry only a server-stamped query ref plus raw arguments, and `snapshot` carries a subscription id, cookie, and JSON rows. The decoder rejects missing, extra, and incorrectly typed fields. The client replaces local rows and moves the subscription to `live` when a snapshot arrives. No server path produces that snapshot yet. |
| Op-log idempotency | Implemented | Replay, request collision, error envelopes, and rollback behavior are tested against the synchronous SQL abstraction. |
| Atomic domain transaction core | Isolated | Focused workerd tests cover commit, replay, rollback, and policy-wrapper failures inside Cdb. A raw escape attempted after typed SQL rolls back that SQL and the provisional op-log row. The public organization mutation path reaches the same executor after Gateway and Catalog authorization. |
| Domain schema bootstrap | Isolated | A configured Cdb renders and creates fresh `cdbTable` tables and indexes, records their signatures, enables local foreign keys, and rejects unsigned or changed existing layouts. Bun fake-Durable-Object tests cover bootstrap, reconstruction, constraints, authority foreign-key omission, and nonlocal foreign-key rejection. There is no versioned domain migration path. |
| Catalog routing and snapshot barrier storage | Isolated | Focused workerd tests use real Durable Object SQL storage. Full scheduled backup and restore do not exist. |
| Cdb reshard copy and tail RPCs | Isolated | Focused workerd tests cover bulk copy, trigger capture, tail replay, and range filtering. They do not drive the complete Resharder object through a deployed application. |
| Public organization mutation | Isolated | A mutation with an explicit stable `ref` and `authority: "organization"` crosses a configured workerd WebSocket, Gateway, Catalog membership lookup, Catalog routing, Cdb policy wrapper, and atomic op-log executor. Gateway validates and transforms raw arguments once before partition extraction, keeps only the verified JWT subject, and builds `ctx.auth` from Catalog membership, role, roles, and auth epochs. Cdb treats the request as a trusted post-validation internal seam and invokes the validated handler without re-transforming arguments. The harness seeds JWKs and auth rows through test-only routes rather than a Better Auth sign-in, and it is not the packed chat application. Mutations without an authority declaration stay closed with `CDB_AUTH_NOT_BOUND`. |
| Query registration | Partial | The isolated routing path resolves the query ref, validates arguments, derives intent and a hash on the server, and can register with Cdb. Scatter routing enumerates distinct current range owners through `Catalog.listShardIds()`. Cdb persists each registration under a composite Gateway, client, and subscription id and rebuilds its interval map on startup. Public subscriptions still fail closed because the organization-authority path is implemented only for declared mutations. |
| Shard-local query execution | Isolated | Direct `Cdb.query` resolves a registered query, supplies a policy-wrapped Drizzle database and the request auth context, executes the handler, and validates the JSON result. Full-row `cdbTable` selects apply row predicates and readable-column masks. Focused Bun tests cover persisted rows, empty results, failures, and blocked writes and escape paths. Gateway does not route public subscriptions to this RPC or establish its auth authority. |
| Initial query delivery | Missing | Protocol v3 defines a snapshot and the client handles it, but no server path executes a registered subscription query and emits that snapshot. |
| Live query update | Missing | Interval matching and patch batching exist, but committed writes do not produce row patches through the public runtime. |
| WebSocket reconnect, cookies, and auth refresh | Isolated | The client state machine is tested with a fake WebSocket. A real workerd Gateway serializes refresh barriers by server-generated connection id, drains admitted mutations, preserves the latest cookie, invalidates subscriptions, gates later mutations, and stores a terminal rejected attachment before closing on refresh failure. Resume still does not replay missed changes. |
| Presence | Partial | Gateway publish and fan-out helpers exist, but public presence operations deliberately remain closed with `CDB_AUTH_NOT_BOUND`. The organization authority added for mutations does not authorize presence. No React presence hook is exported. |
| Auth schema synthesis and SQL operations | Implemented | Core and plugin tables, epoch-scope rules, and SQL helpers have focused tests. |
| Catalog auth DDL | Implemented | Catalog renders executable DDL with keys, uniqueness, foreign keys, indexes, supported defaults, nullability, and SQLite types. Existing tables require matching `auth_ddl_v1` signatures. There is no versioned upgrade path. |
| Better-auth adapter | Partial | All synthesized auth models use singleton Catalog storage, and Cdb no longer stores or indexes auth rows. Each auth mutation and every directly derivable old and new global, tenant, or principal epoch scope commit in one Catalog transaction. Bulk updates and deletes preload matched rows to derive those scopes. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. Better Auth workflows remain sequential because the adapter reports `transaction: false`. Coverage uses a Bun fake-Durable-Object harness, not workerd; restart evidence and a full sign-in-to-domain-write test are missing. |
| Gateway JWT identity and mutation authority | Implemented | Configured Gateway `hello` and `updateAuth` verify real signatures, subject, expiry, not-before, issuer, audience, and allowed algorithms through the Catalog JWK resolver contract. The attachment stores no tenant, role, or custom claims. For each declared organization mutation, Catalog re-derives the organization membership, role, roles, and global, tenant, and principal epochs from the verified subject. A Miniflare workerd test covers the configured Gateway, real Catalog SQLite cache, and configured Cdb. Outbound JWKS fetch, cache refresh, key rotation, and a complete Better Auth sign-in remain untested. |
| Row and column authorization | Partial | Inserts enforce create grants, tenant and self authority, and writable columns. Updates enforce update grants and columns and make managed authority columns immutable. Updates, deletes, and full-row selects AND tenant and self predicates with the caller's `where`, including operations with no `where`; each requires a matching grant. Select results receive readable-column masks. Projections and joins fail closed because their result shapes cannot yet be masked. The application database wrapper also rejects raw, session, client, relational-query, count, plain-table CRUD, insert-select, conflict, `returning`, and unsupported pre-policy builder paths. Workerd transaction tests cover rollback on forbidden update, delete, and raw-escape operations. Declared organization mutations reach this policy path; public queries do not. |
| Schema migration | Missing | Fresh Cdb objects bootstrap the current domain schema and reject signature drift. The CLI does not apply versioned DDL across existing shards, coordinate a barrier, resume after failure, or roll back. |
| Snapshot export and restore | Missing | Barrier bookmarks exist. Durable export, restore, and verification do not. |
| Complete online resharding | Partial | The phase machine and shard RPCs exist, with focused tests and a TLA+ model. Automatic triggers, the entire Resharder RPC sequence, concurrent application writes, and recovery are not validated end to end. |
| Cross-partition transaction | Isolated | A two-phase protocol and recovery tests exist. The default runtime has no bound participant implementation and raises `CDB_DT_NOT_IMPLEMENTED`. |
| Files and uploads | Missing | Drizzle column types and validators exist. Runtime handles throw for upload and delete. No React upload hook or runtime HTTP endpoint is exported. |
| Vector search and streams | Missing | Types and helper code exist. No React stream or vector-search hooks and no runtime HTTP endpoints are exported. |
| Package and generated project | Implemented | The npm tarball contains `dist` and public documentation, not `src`. CI installs the tarball in empty consumers and checks advertised imports. `chardb init` emits pinned dependencies, TypeScript config, six Durable Object bindings, assets, and an honest prototype README; CI installs, typechecks, and asks Wrangler to bundle that project without workspace aliases. |
| Chat demo bootstrap | Isolated | The example sign-in hook finds or creates the shared demo organization, reuses an existing membership for the user, tolerates a confirmed concurrent create, and sets the session's active organization. Its mutation declares an explicit ref and organization authority. Focused tests cover repeated bootstrap, but no workerd test runs the packed chat app through sign-in, mutation, and persisted readback. |
| Operational CLI | Partial | Project generation, Wrangler checks, explain logic, and deploy-plan helpers exist. Migration apply, shard operations, export, restore, and schedule operations remain incomplete or labeled placeholders. |
| Dependency audit | Partial | Compatible paths now resolve to `nanoid@3.3.18`, `postcss@8.5.26`, `sharp@0.35.2`, `svgo@4.0.2`, and `ws@8.21.0`. Bun still reports five advisories through `miniflare@4.20260730.0 -> undici@7.28.0`. Miniflare 4 pins that version exactly; the fixed `undici@7.29.0` currently appears only through Miniflare 5 alpha, so the repository does not force an override or incompatible major. |

Only `/ws` and `/_chardb/*` are reserved Chardb routes. `/api/auth/*` is mounted when Better Auth is configured. Removed placeholder paths such as `/q`, `/f`, `/p`, and `/s` fall through to the application. React exports no placeholder presence, upload, stream, or vector hooks.

The committed trust boundary is deliberately narrow. Gateway sends `welcome` and stores a verified attachment only after JWT verification. It stores the subject and time bounds, not tenant, role, or custom claims. Declared organization mutations use the subject plus their validated partition key to ask Catalog for current membership, role, roles, and auth epochs. The Catalog read is the authorization linearization point. Revocation blocks the next dispatch but does not cancel a shard call that was already authorized. Undeclared mutations, public queries and subscriptions, and presence reject with `CDB_AUTH_NOT_BOUND`.

## The missing application flow

The focused workerd mutation harness now proves verified identity, Catalog-derived organization authority, routing, Cdb dispatch, policy enforcement, and atomic op-log execution. The runtime still needs one application test against the packed package that proves the broader sequence:

1. open the configured Gateway under workerd and verify a real signed JWT;
2. complete a Better Auth sign-in and bootstrap or select an organization;
3. run a declared tenant-scoped mutation and independently read back its persisted row;
4. execute the initial tenant-scoped query;
5. deliver a live update after the mutation;
6. reject a second tenant's read and write attempts;
7. replay the mutation id without running the handler twice;
8. restart the Worker and Durable Objects without losing auth or domain state.

Until that test passes, passing helper tests do not establish that Chardb works as a database.

## Verification state

CI runs the strict TypeScript check, repository-wide Biome check, package and landing builds, packed-package import checks, generated-project checks, and the packed chat typecheck and build. The tarball is limited to `dist`, the license, and public documentation.

CI runs ordinary tests together and starts each Miniflare workerd harness in its own process to avoid shared-port collisions. Those focused harnesses do not replace the missing configured-application restart and end-to-end tests.

The remaining work is listed in dependency order in [`PLAN.md`](PLAN.md). Runtime relationships are described in [`ARCHITECTURE.md`](ARCHITECTURE.md).
