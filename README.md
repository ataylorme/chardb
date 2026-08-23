# chardb

Experimental tenant-sharded SQLite for Cloudflare Durable Objects.

Chardb explores one idea: mark an organization boundary in a Drizzle schema, then derive data placement, per-tenant transactions, authorization, and live-query routing from that declaration.

This is engineering work intended for public review, not a database you should deploy yet. A declared organization mutation now crosses the public WebSocket, Gateway, Catalog, and Cdb path in a focused workerd test. The public query and live-update paths remain disconnected, and no packed example has passed a full sign-in-to-read round trip.

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
- Atomic Catalog auth mutations with directly derivable old and new epoch bumps
- Gateway JWT signature and registered-claim verification
- Public organization-authorized mutations with explicit stable refs
- Catalog-derived membership, roles, and auth epochs for each declared organization mutation
- Single-pass mutation argument validation and transformation before partition routing
- Schema-first insert, update, delete, and full-row select authorization, including writable-column checks and readable-column masks
- A fail-closed database wrapper that rejects raw, session, client, plain-table, insert-select, conflict, returning, and unsupported builder paths
- Read-only shard-local query execution with JSON result validation
- Protocol-v3 snapshot decoding and client replacement handling
- Catalog-backed scatter enumeration without sampled virtual-shard probes
- Persistent composite Gateway, client, and subscription identities on Cdb shards
- TLA+ models for snapshot barriers and resharding
- Packed-package import checks and a standalone `chardb init` scaffold

Still missing from the application path:

- A complete Better Auth sign-in through the packed example and a persisted domain readback
- Routing a public subscription to shard-local query execution
- Producing the protocol-v3 initial snapshot on the server
- Sending live results after a committed mutation
- Applying domain migrations across shards
- Canonicalizing query identity with verified auth and policy epochs
- Adding versioned auth-schema upgrades and proving restart behavior in workerd

Files, vectors, presence, streams, scheduling, cross-partition transactions, PITR, and automatic resharding remain experiments. They are not supported product features.

The WebSocket protocol does not trust client routing or authority metadata. Gateway verifies the JWT signature and registered claims, then keeps only the verified subject and time bounds in the socket attachment. A mutation becomes public only when its server definition declares `authority: "organization"` and an explicit stable `ref`. Gateway validates and transforms the raw arguments once, extracts the organization partition from that exact value, and asks Catalog to re-derive membership, role, roles, and global, tenant, and principal auth epochs. Token tenant, role, and custom claims never become authority. Mutations without the declaration return `CDB_AUTH_NOT_BOUND`; all public query, subscription, and presence operations remain closed with the same code.

Catalog's authority read is the authorization linearization point. A revocation blocks the next dispatch, but it does not cancel a Cdb call that Catalog already authorized. Cdb treats its mutation RPC as a trusted post-validation internal seam. It invokes the validated handler under the database policy wrapper and commits domain SQL with the provisional op-log row in one transaction.

The JWT tests use real signatures and the Catalog resolver contract. A Miniflare workerd test drives the configured Gateway Durable Object and WebSocket with ES256 tokens, a real Catalog SQLite cache, Catalog membership resolution, and a configured Cdb mutation. The test imports refs from a real emitted Vite browser chunk and compares them with the independently bundled workerd Worker. It still seeds the JWK and auth rows through test-only HTTP routes, so Better Auth sign-in, outbound JWKS fetch, cache refresh, and key rotation remain untested. Catalog auth DDL preserves constraints and indexes for new storage. Existing tables need exact matching `auth_ddl_v1` signatures; no versioned upgrade path exists.

Auth refreshes serialize per server-generated connection id. Gateway drains already admitted mutations before replacing the verified attachment, invalidates subscriptions, and gates later mutations behind the refresh result. Failed refreshes serialize a terminal rejected attachment before closing the socket, so queued mutations cannot run against stale identity.

Each auth mutation commits with every directly derivable old and new global, tenant, or principal epoch bump. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. Bulk updates and deletes preload matched rows to derive epoch scopes. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. These cases have Bun fake-Durable-Object coverage, not workerd coverage.

Fresh Cdb objects render domain tables and indexes from the configured Drizzle schema, record signatures, and reject drift. This does not migrate an existing shard. Inserts, updates, deletes, and full-row selects require schema-declared grants. Inserts and updates check writable columns; updates forbid authority-column changes. Updates, deletes, and selects AND tenant and self predicates with the caller's filter, including operations with no filter. Select results receive readable-column masks. Projections, joins, and other shapes that cannot yet be masked safely fail closed.

Application handlers can use only typed builders against registered `cdbTable` definitions. The wrapper rejects raw SQL, Drizzle session and client access, relational and count shortcuts, plain-table CRUD, insert-select, conflict methods, `returning`, and unsupported properties before or after policy attachment. Direct `Cdb.query` calls can execute a registered handler through this read-only policy wrapper, but Gateway does not route public subscriptions to that RPC.

The chat example's sign-in hook reuses the shared demo organization and an existing membership for the user, then updates the session's active organization. Its `postMessage` mutation opts into the public path with an explicit ref and organization authority. Repeated sessions and concurrent bootstrap attempts do not blindly insert the same rows. The example still lacks a workerd run that starts with Better Auth sign-in and reads the persisted message back.

Scatter routing asks Catalog for the distinct physical shards that own current ranges. Cdb persists shard registrations under composite Gateway, client, and subscription ids, then rebuilds its interval map from SQLite on startup. Persisted registrations still lack verified tenant, auth epoch, policy epoch, and delivery-cookie state.

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

The organization foreign key identifies the intended transaction and placement boundary. Related rows colocate through their foreign-key chain. Declared organization mutations enforce that boundary by checking the extracted organization against Catalog membership. Public queries do not yet cross the same authority path.

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

The npm tarball contains built `dist` files and the public documents. It does not contain `src`. CI also runs `chardb init` from that tarball in a temporary project, installs its pinned dependencies without workspace aliases, typechecks it, and runs a Wrangler dry-run build. The generated README warns that domain migrations and the authenticated mutation, query, and live-update path are unfinished.

## License

MIT
