# chardb

Experimental tenant-sharded SQLite for Cloudflare Durable Objects.

Chardb explores one idea: mark an organization boundary in a Drizzle schema, then derive data placement, per-tenant transactions, authorization, and live-query routing from that declaration.

This is engineering work intended for public review, not a database you should deploy yet. The routing, colocation, op-log, policy compilation, and resharding pieces have substantial tests. The domain mutation and query paths are not connected end to end.

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
- Schema-first insert, update, and delete authorization, with writable-column checks on inserts and updates
- Read-only shard-local query execution with JSON result validation
- Protocol-v3 snapshot decoding and client replacement handling
- Catalog-backed scatter enumeration without sampled virtual-shard probes
- Persistent composite Gateway, client, and subscription identities on Cdb shards
- TLA+ models for snapshot barriers and resharding
- Packed-package import checks and a standalone `chardb init` scaffold

Still missing from the application path:

- Resolving tenant membership, role, and policy authority after Gateway verifies identity
- Constructing the handler's auth context from verified identity and server-owned authority
- Applying row and column policies to select paths
- Routing a public subscription to shard-local query execution
- Producing the protocol-v3 initial snapshot on the server
- Sending live results after a committed mutation
- Applying domain migrations across shards
- Canonicalizing query identity with verified auth and policy epochs
- Adding versioned auth-schema upgrades and proving restart behavior in workerd

Files, vectors, presence, streams, scheduling, cross-partition transactions, PITR, and automatic resharding remain experiments. They are not supported product features.

The WebSocket protocol does not trust client routing metadata. Protocol v3 subscriptions carry a server-stamped query ref and raw arguments. It also defines a snapshot message that replaces client rows and moves the subscription to `live`, but no server path produces that message yet. Gateway verifies JWT signatures, subject, time bounds, issuer, audience, and allowed algorithms through a Catalog-backed JWK resolver. It stores verified identity but no tenant or role authority. Mutations, subscriptions, and presence therefore fail closed with `CDB_AUTH_NOT_BOUND` until membership and policy resolution exist.

The JWT tests use real signatures and the Catalog resolver contract. A Miniflare workerd test drives the configured Gateway Durable Object and WebSocket with ES256 tokens and a real Catalog SQLite cache. It seeds `Catalog.putJwk` through a test-only HTTP route, so outbound JWKS fetch, cache refresh, and key rotation remain untested. Catalog auth DDL preserves constraints and indexes for new storage. Existing tables need exact matching `auth_ddl_v1` signatures; no versioned upgrade path exists.

Each auth mutation commits with every directly derivable old and new global, tenant, or principal epoch bump. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. Bulk updates and deletes preload matched rows to derive epoch scopes. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. These cases have Bun fake-Durable-Object coverage, not workerd coverage.

Fresh Cdb objects render domain tables and indexes from the configured Drizzle schema, record signatures, and reject drift. This does not migrate an existing shard. Inserts, updates, and deletes require schema-declared grants. Inserts and updates check writable columns; updates forbid authority-column changes. Updates and deletes AND tenant and self predicates with the caller's filter, including operations with no filter. Select and raw SQL enforcement remain open. Direct `Cdb.query` calls can execute a registered handler through a read-only wrapper, but Gateway does not route public subscriptions to that RPC.

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

The organization foreign key identifies the intended transaction and placement boundary. Related rows colocate through their foreign-key chain. The unfinished runtime must enforce that boundary rather than trusting a tenant ID from the client.

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
