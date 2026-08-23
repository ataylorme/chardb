# chardb

Experimental tenant-sharded SQLite for Cloudflare Durable Objects.

Chardb explores one idea: mark an organization boundary in a Drizzle schema, then derive data placement, per-tenant transactions, authorization, and live-query routing from that declaration.

The repository is public engineering work, not a database you should deploy yet. The routing, colocation, op-log, policy compilation, and resharding pieces have substantial tests. The domain mutation and query paths are not connected end to end.

## Current state

Implemented and tested in isolation:

- Deterministic foreign-key colocation
- 16,384 virtual-shard range routing
- SQLite mutation deduplication through an operation log
- Catalog routing, snapshot barriers, and resharding state machines
- Hibernated WebSocket bookkeeping
- Better Auth schema synthesis and SQL adapter helpers
- Schema-first row and column policy compilation
- TLA+ models for snapshot barriers and resharding

Still missing from the application path:

- Verifying WebSocket auth so public mutations can reach the owning Durable Object
- Constructing the handler's auth context from verified identity and membership
- Applying row and column policies during real reads and writes
- Executing an initial query for a subscription
- Sending live results after a committed mutation
- Applying domain migrations across shards
- Production JWT verification in the Gateway

Files, vectors, presence, streams, scheduling, cross-partition transactions, PITR, and automatic resharding remain experiments. They are not supported product features.

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

## License

MIT
