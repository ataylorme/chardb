# chardb

Experimental organization-tenanted SQLite for Cloudflare Durable Objects.

Chardb derives placement, authorization, and live-query routing from a Drizzle schema. The supported product path is small: one organization boundary, one physical Cdb transaction per operation, registered mutations, planned live queries, bounded direct selects, and opt-in organization files and vectors.

Do not deploy this as a production database yet. Clean-tarball and Workerd tests cover the organization path, but backup, restore, failover, and longer failure runs do not exist.

## Start here

Let Chardb create the project directory and write the Worker, React app, Better Auth setup, migration journal, and `wrangler.toml`:

```sh
bunx @chardb/core init my-chardb-app
cd my-chardb-app
bun install
bun run typecheck
bun run dev
```

`chardb init` refuses to write if any generated target already exists or if the directory contains anything except
`.git` and `.DS_Store`. A failed preflight writes nothing.

The development command starts Wrangler and Miniflare, applies the packaged schema version, starts Vite, and prints the local URL. Sign in through Better Auth, create an organization, write a message, receive the live update, and reload the persisted row. The generated tutorial also includes an optional image attachment backed by local R2. Range-movement controls stay in conformance fixtures, not onboarding.

## Define auth and schema

Better Auth owns identity, sessions, and organizations. Configure it once with the plugins your application uses:

```ts
// src/auth.ts
import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { defineAuth } from "@chardb/core/server";

export const auth = defineAuth({
    plugins: [anonymous(), organization(), jwt()],
});
```

Reference those synthesized Better Auth tables from the Drizzle schema:

```ts
// src/schema.ts
import { text } from "drizzle-orm/sqlite-core";
import { forOrg } from "@chardb/core/server";
import { auth } from "./auth.ts";

const { cdbTable } = forOrg();

export const messages = cdbTable(
    "messages",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id, { onDelete: "cascade" }),
        body: text("body").notNull(),
    },
    {
        roles: {
            owner: "*",
            admin: "*",
            member: { read: "*", create: ["id", "body"] },
        },
    }
);
```

The foreign key identifies organization ownership. The role policy decides which members may read or write each column. Application code does not maintain a second organization or session model.

The `roles` block is Chardb's policy for domain rows. It does not add roles or permissions to Better Auth's organization or admin plugins. Configure those plugins in `defineAuth()` and manage their roles through Better Auth. Chardb reads the current Better Auth organization role at request time, then applies the matching domain-row grant above.

Some organization data belongs to one user. Put those tables behind `forOrgUser()` so Chardb fills and checks both foreign keys. Keep organization-wide tables behind `forOrg()`, in a separate schema module:

```ts
// src/project-schema.ts
import { text } from "drizzle-orm/sqlite-core";
import { forOrg } from "@chardb/core/server";
import { auth } from "./auth.ts";

const { cdbTable: orgTable } = forOrg();
export const projects = orgTable(
    "projects",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        name: text("name").notNull(),
    },
    { roles: { owner: "*", admin: "*", member: { read: "*" } } }
);

// src/draft-schema.ts
import { text } from "drizzle-orm/sqlite-core";
import { forOrgUser } from "@chardb/core/server";
import { auth } from "./auth.ts";

const { cdbTable: orgUserTable } = forOrgUser();
export const drafts = orgUserTable(
    "drafts",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        userId: text("user_id")
            .notNull()
            .references(() => auth.user.id),
        title: text("title").notNull(),
    },
    {
        roles: {
            admin: { read: "*" },
            self: { create: ["id", "title"], read: "*", update: ["title"], delete: true },
        },
    }
);
```

`projects` is shared across the organization. Each `drafts` row belongs to its organization and its author. The mutation handler inserts `{ id, title }`; Chardb takes `organizationId` and `userId` from verified Better Auth state. An organization admin can read every draft here, while members can only read and edit their own.

## Define queries

Define a stable server handle. The ref is the wire identity shared by Worker and browser builds:

```ts
import { api } from "@chardb/core/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { messages } from "./schema.ts";

export const listMessages = api.query({
    ref: "src/queries.ts#listMessages",
    args: z.object({ organizationId: z.string() }),
    query: (db, args) =>
        db
            .select()
            .from(messages)
            .where(eq(messages.organizationId, args.organizationId))
            .orderBy(asc(messages.id))
            .limit(100),
});
```

A mutation uses the same organization routing field and writes through the policy-wrapped Drizzle database:

```ts
// src/api.ts
import { api } from "@chardb/core/server";
import { z } from "zod";
import { messages } from "./schema.ts";

export const postMessage = api.mutation({
    ref: "src/api.ts#postMessage",
    authority: "organization",
    partitionKey: "organizationId",
    args: z.object({
        organizationId: z.string(),
        id: z.string(),
        body: z.string().trim().min(1).max(2_000),
    }),
    handler: (ctx, args) => {
        ctx.db.insert(messages).values({ id: args.id, body: args.body }).run();
        return { id: args.id };
    },
});
```

`organizationId` routes each operation to one organization shard. It does not grant access. Chardb verifies the Better Auth JWT, refreshes current membership, and applies the schema policy before executing the handle. Inserts fill the managed organization column from that verified authority, so handlers do not trust a caller-supplied owner.

## Add files or vectors

Organization files and vectors are opt-in public experiments. Ordinary organization rows do not require either feature. The generated app includes a working R2-backed file example using `@chardb/core/files`; rows store an opaque file ID, while upload and download still use the active Better Auth organization and row policy.

Vectors require an explicit column, Vectorize binding, and metadata index. Add the vector import and column to the table above, and grant only the roles that may write it:

```ts
import { vector } from "@chardb/core/server";

// Inside the messages column definition:
embedding: vector("embedding", {
    dim: 768,
    binding: "VECTORS",
    metric: "cosine",
}),

// Replace the member role entry with:
member: { read: "*", create: ["id", "body", "embedding"] },
```

Chardb can generate the immutable initial journal from conventional `src/auth.ts` and `src/schema.ts` files:

```sh
bunx @chardb/core migrations generate --name initial_schema
```

The command inspects the schema twice in separate Bun processes and rejects different output. The first run writes static `src/migrations/v1.json`, `src/migrations/v1.ts`, and `src/migrations.ts` files without importing the mutable application schema. Run it after each additive schema change to append the next sequential version. Every later run verifies the complete canonical JSON digest chain, the generated TypeScript for each version, and the exact journal before it writes. The additive diff accepts new tables, nonunique indexes, and nullable unconstrained columns. It rejects gaps, edits to old history, drops, renames, type or constraint changes, new unique indexes, and mutation of an existing file or vector resource.

Vector writes use the same organization mutation and SQLite transaction as the owning row. Search uses the existing registered-query and live-query path:

```ts
import { api, searchVector } from "@chardb/core/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { messages } from "./schema.ts";

export const putMessage = api.mutation({
    ref: "src/api.ts#putMessage",
    args: z.object({
        organizationId: z.string(),
        id: z.string(),
        body: z.string(),
        values: z.array(z.number()).length(768),
    }),
    authority: "organization",
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        const embedding = ctx.vector.set(messages.embedding, args.id, args.values);
        ctx.db.insert(messages).values({ id: args.id, body: args.body, embedding }).run();
        return { id: args.id };
    },
});

export const deleteMessage = api.mutation({
    ref: "src/api.ts#deleteMessage",
    args: z.object({ organizationId: z.string(), id: z.string() }),
    authority: "organization",
    partitionKey: "organizationId",
    handler: (ctx, args) => {
        ctx.vector.delete(messages.embedding, args.id);
        ctx.db.delete(messages).where(eq(messages.id, args.id)).run();
        return { id: args.id };
    },
});

export const searchMessages = api.query({
    ref: "src/queries.ts#searchMessages",
    args: z.object({
        organizationId: z.string(),
        values: z.array(z.number()).length(768),
        limit: z.number().int().min(1).max(100),
    }),
    query: (_db, args) => searchVector(messages.embedding, args),
});
```

`ctx.vector.set()` returns the opaque handle stored in the Drizzle column. `ctx.vector.delete()` and the row delete belong in the same mutation. Both operations stage domain SQL, the current vector head, and delivery intent atomically. Vectorize delivery happens after commit, so search is eventually consistent. Once an upsert or delete settles, Chardb invalidates subscriptions for that exact vector resource and the existing `useQuery(searchMessages, args)` hook refetches it.

Every vector mutation and search uses the same organization authority as ordinary rows. Chardb verifies the Better Auth JWT, refreshes membership and placement, and applies the table policy and authoritative vector head. The `organizationId` in `searchVector()` is a checked routing input, not a client-controlled filter for another organization.

Search returns only `{ rowPk, score }`. Chardb asks Vectorize for the requested limit plus at most 16 extra candidates, then rejects stale, cross-organization, and policy-hidden candidates against SQLite. That bounded filtering can return fewer than `limit`; continuation is not implemented because Vectorize does not provide the cursor contract Chardb needs.

Bind the descriptor to a native Vectorize index in `wrangler.toml`:

```toml
[[vectorize]]
binding = "VECTORS"
index_name = "my-app-vectors"
```

Search filters every candidate by Chardb's exact resource identity. Create the configured Vectorize index, then prepare its required string metadata index:

```sh
bunx wrangler vectorize create my-app-vectors --dimensions 768 --metric cosine
bunx @chardb/core vectorize prepare
```

TOML is the generated default. `bunx @chardb/core doctor` also accepts `wrangler.json` and `wrangler.jsonc` and checks configured Vectorize bindings. `bunx @chardb/core vectorize prepare` reads TOML first, then JSON, then JSONC, and uses the project's installed Wrangler CLI. It creates a missing `cdb_resource:string` metadata index, accepts an already-correct one, waits for bounded readiness, and refuses conflicting or malformed remote state.

The logical head and delivery outbox follow the organization's normal virtual-shard route. Proven vector-aware movement transfers the SQLite heads, outbox rows, delivery attempts, and deletion tombstones without calling Vectorize during the move. Vectorize remains an external, eventually consistent index; application code never chooses a physical shard or rewrites an index record during resharding.

Organization deletion has a finite fail-closed contract. Chardb records accepted-delete evidence before removing local state and never treats a different opaque Vectorize watermark as proof of order or absence. An unproven external result stops for operator intervention after the bounded settlement and retry budget is exhausted.

## Compose the Worker

One `chardb()` call mounts Better Auth, the database routes, your API handles, and the Durable Object exports required by Wrangler. The generated project supplies the migration journal used here:

```ts
// src/worker.ts
import { chardb } from "@chardb/core/server";
import * as api from "./api.ts";
import * as queries from "./queries.ts";
import { auth } from "./auth.ts";
import { migrations } from "./migrations.ts";
import * as schema from "./schema.ts";

export const app = chardb({
    auth,
    schema,
    api: { ...api, ...queries },
    migrations,
});

app.get("/me", async c =>
    c.json(await c.var.auth.api.getSession({ headers: c.req.raw.headers }))
);

export default app;
export const { DB, Catalog, Cdb, Gateway, Resharder } = app;
```

Custom Worker routes can query the same schema through the native `DB` binding. They pass the request JWT back through the same Better Auth and policy checks:

```ts
import { client } from "@chardb/core";
import { eq } from "drizzle-orm";
import { messages } from "./schema.ts";

app.get("/api/messages", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);

    const url = new URL(c.req.url);
    const organizationId = url.searchParams.get("organizationId") ?? "";
    if (!organizationId) return c.json({ error: "missing organizationId" }, 400);
    const rows = await client(c.env.DB, { jwt, authOrigin: url.origin })
        .select()
        .from(messages)
        .where(eq(messages.organizationId, organizationId))
        .limit(100);
    return c.json(rows);
});
```

The planned live query and direct select compile to the same versioned select plan. Both execute through one policy-wrapped runner. No SQL string crosses RPC.

In React, configure Chardb once with the public Worker URL. The client gives that URL to Better Auth, derives `/ws`, and adds the active organization to database operations.

```tsx
import { createAuthClient } from "better-auth/react";
import { anonymousClient, jwtClient, organizationClient } from "better-auth/client/plugins";
import { createChardbReactClient } from "@chardb/react";
import { listMessages } from "./queries.ts";

const workerUrl = window.location.origin;
const db = createChardbReactClient({
    url: workerUrl,
    ownership: "organization",
    auth: ({ baseURL }) =>
        createAuthClient({
            baseURL,
            plugins: [anonymousClient(), organizationClient(), jwtClient()],
        }),
});

function Messages() {
    const { data = [] } = db.useQuery(listMessages, { limit: 50 });
    return <ul>{data.map(message => <li key={message.id}>{message.body}</li>)}</ul>;
}

export function App() {
    const session = db.auth.useSession();
    const organizations = db.auth.useListOrganizations();
    if (!session.data) return <p>Sign in to continue.</p>;

    const activeOrganizationId = session.data.session.activeOrganizationId;
    return (
        <>
            <select
                value={activeOrganizationId ?? ""}
                onChange={event =>
                    void db.auth.organization.setActive({ organizationId: event.target.value || null })
                }
            >
                <option value="">Choose an organization</option>
                {(organizations.data ?? []).map(org => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                ))}
            </select>
            <db.Provider>
                {activeOrganizationId ? <Messages /> : null}
            </db.Provider>
        </>
    );
}
```

## Public package entries

Chardb publishes these public imports:

| Import | Purpose |
| --- | --- |
| `@chardb/core` | Browser client, native binding client, and shared errors |
| `@chardb/core/server` | Organization tables, API handles, auth, migrations, vectors, and `chardb()` |
| `@chardb/react` | Configured React client with Better Auth identity and owner-scoped hooks |
| `@chardb/core/files` | Branded file columns, browser-safe locators, and the same-origin file client |
| `@chardb/core/vite` | Ref-only browser handles for queries and mutations |

The preview binary ships `init`, `doctor`, `migrations generate`, `migrate`, and `vectorize prepare`. Range movement is available only under `chardb experimental shards` and is absent from primary help and generated onboarding. Doctor validates Wrangler configuration. Schema and auth doctor targets are not shipped. Durable Object classes, RPC types, policy compilers, presence, streams, distributed transactions, and runtime configuration are not public package exports.

## Cloudflare runtime

Generated projects run through Wrangler and Miniflare with native Durable Objects, SQLite, and four explicit same-Worker namespace bindings. The scaffold includes a native R2-backed file example. Vector columns use a native Vectorize binding after the application configures one. The generated default is `wrangler.toml`; `chardb doctor` and resource preparation also accept `wrangler.json` and `wrangler.jsonc`. Application code uses the exported `DB` entrypoint. Runtime-provided `ctx.exports` remains a fallback, but internal Durable Object calls in generated deployments do not depend on it. [ARCHITECTURE.md](ARCHITECTURE.md) documents the internal ownership and routing model.

Migration execution is resumable and fail-closed. Generation is deterministic and writes static, digest-chained JSON and TypeScript snapshots, so deployed history does not import mutable schema or auth modules. Versions after the initial snapshot deliberately support only SQLite changes that do not require a table rewrite or data cleanup.

## Release proof

Every release starts from one packed npm tarball. The same bytes must pass package-boundary checks, the generated app, Better Auth organization isolation, live queries, restart recovery, R2 files, Vectorize vectors, combined row/file/vector movement, and the Linux, macOS, and Windows CI matrix. Reports identify the tarball by SHA-256, keep correctness separate from timing, and reject evidence from any other package.

Cloudflare proofs use disposable Workers, R2 buckets, and Vectorize indexes. They retain no credentials, delete only resources recorded in their ownership ledger, and fail unless independent checks confirm cleanup. These are release-engineering controls, not a durability or production-readiness claim.

## Benchmarks

Benchmarks use named, versioned workloads. Warmups are excluded from latency summaries, fresh processes are explicit, and each sample carries correctness flags. Comparison tools reject mismatched candidates, runtimes, profiles, scenarios, and metrics. The caller chooses the regression budget. Repository reports do not turn one laptop, region, or short run into an SLA.

Local fake-index vector results measure Worker, SQLite, routing, and live-query work. They do not measure Vectorize or Cloudflare network cost. A local and deployed comparison is valid only when both tracks use the same packed candidate and workload.

[COST.md](COST.md) maps Chardb operations to Cloudflare's published meters. Timings are not CPU, Durable Object duration, or an invoice estimate.

## Deliberately out of scope

User-tenanted and global-table paths remain inside internal conformance fixtures. They are useful implementation evidence, but they are not supported product modes and no public builder exposes them.

User-owned and global files, user-owned and global vectors, vector-search continuation, presence, streams, scheduling, cross-partition transactions, PITR, export, restore, and automatic resharding are unsupported. Organization files and organization vectors are public and experimental within the narrow lifecycles documented above. Lower-level barrier and operator-driven range-movement code remains internal. Scheduled requests no longer create PITR barriers automatically because retention, export, and restore do not exist.

See [OPERATIONS.md](OPERATIONS.md) for the threat model and recovery limits, [COST.md](COST.md) for the measured-cost boundary, and [ARCHITECTURE.md](ARCHITECTURE.md) for runtime ownership.

## License

MIT. See [LICENSE](LICENSE).
