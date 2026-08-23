# chardb chat example

This is a compile-checked concept example for chardb's chat API: Drizzle tables, better-auth configuration, typed mutations and queries, and React hooks in one small application. It typechecks and produces a Vite build against a packed chardb package. It is not an end-to-end runnable demo. Gateway verifies JWT identity, then public mutations, subscriptions, and presence stop at the unbound membership and policy boundary. Cdb does not execute initial queries or live replacements.

The intended backend surface is one factory call:

```ts
// src/server/worker.ts, abbreviated. See the source for the full concept.
import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { chardb, defineAuth } from "chardb/server";
import * as api from "./api.ts";
import * as queries from "./queries.ts";
import * as domain from "./schema.ts";

export const auth = defineAuth({
  appName: "chat",
  plugins: [anonymous(), jwt()],
  // Bootstrap a shared demo org on every sign-in. Production apps
  // gate org creation behind their own flow.
  databaseHooks: { /* see worker.ts for the full hook */ },
});

export const app = chardb({ auth, schema: domain, api: { ...api, ...queries } });

app.get("/health", (c) => c.text("ok"));

export default app;
export const { BlobMeta, Catalog, Cdb, Gateway, GsiShard, Resharder } = app;
```

The source shows the intended composition of auth, schema, API handles, routes, and Durable Object exports. Treat that composition as design evidence, not proof that the full public request path works today.

Mutations and policies stay light:

```ts
// src/server/api.ts
import { api } from "chardb/server";
import { z } from "zod";
import { messages } from "./schema.ts";
export const postMessage = api.mutation({
  args: z.object({ id: z.string(), organizationId: z.string(), channelId: z.string(), body: z.string().min(1), clientCreatedAt: z.number() }),
  partitionKey: "organizationId",
  handler: (ctx, args) => {
    if (!ctx.auth.userId || !ctx.auth.tenantId || ctx.auth.tenantId !== args.organizationId) {
      throw new Error("CDB_FORBIDDEN");
    }
    ctx.db.insert(messages).values({
      id: args.id, channelId: args.channelId, body: args.body,
      createdAt: args.clientCreatedAt,
    }).run();
    return { id: args.id };
  },
});
```

The tenant, row, and column policies live in `schema.ts` on the `forOrg()`-bound `cdbTable` definitions.

Queries live in `queries.ts` so the React bundle can value-import them without dragging the worker module:

```ts
// src/server/queries.ts
import { api } from "chardb/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { messages } from "./schema.ts";

export const listMessages = api.query({
  args: z.object({ organizationId: z.string(), channelId: z.string(), limit: z.number().int().positive() }),
  // Server-owned routing intent. The browser sends only this export's
  // stamped ref and the raw arguments passed to useQuery.
  intent: (args) => ({
    kind: "select",
    tables: ["messages"],
    partitionKey: { table: "messages", column: "organization_id", values: [args.organizationId] },
    joinShape: "colocated",
    intervals: [{
      table: "messages", indexName: "channel_id",
      intervals: [{ kind: "range",
        lo: { kind: "value", value: [args.channelId], inclusive: true },
        hi: { kind: "value", value: [args.channelId], inclusive: true } }],
    }],
  }),
  handler: async (ctx, args) =>
    ctx.db.select().from(messages).where(
      and(eq(messages.organizationId, args.organizationId), eq(messages.channelId, args.channelId))
    ).limit(args.limit),
});
```

The React side uses the stamped handle without spelling out a `CdbIntent` or sending one over the wire:

```tsx
// src/web/App.tsx
import { createAuthClient } from "better-auth/client";
import { anonymousClient } from "better-auth/client/plugins";
import { ChardbProvider, useQuery } from "chardb/react";
import { listMessages } from "../server/queries.ts";

const authClient = createAuthClient({ baseURL: location.origin, plugins: [anonymousClient()] });

export function App() {
  return (
    <ChardbProvider endpoint={`wss://${location.host}/ws`} auth={authClient} crossTab>
      <Channel />
    </ChardbProvider>
  );
}

function Channel() {
  const { data, state } = useQuery(listMessages, { organizationId: "demo-org", channelId: "general", limit: 50 });
  // …
}
```

The rest of this README is the org-tenanted chat schema and React frontend.

## Layout

```
src/
  server/
    worker.ts                defineAuth + chardb({ auth, schema, api }) + routes + DOs
    schema.ts                Drizzle domain tables (channels, messages)
    api.ts                   api.mutation + presence handles
    queries.ts               api.query handles + intent extractors (client-safe value imports)
  web/
    main.tsx                 createRoot + <StrictMode> + styles.css
    App.tsx                  createAuthClient + <ChardbProvider endpoint=/ws auth={authClient} crossTab>
    hooks.ts                 useChatMessages / usePostMessage
    components/              ChannelList / MessageList / Composer
    styles.css

index.html                   Vite entry → /src/web/main.tsx
vite.config.ts               vite + @vitejs/plugin-react + chardb/vite plugin
wrangler.template.jsonc      illustrative bindings for a future workerd demo
test/e2e/                    bun:test + bun:sqlite stress tests for the pure layers
```

The example is excluded from the root unbuild config; nothing here ships in the published `chardb` package.

## Better-auth is built in

The four core better-auth tables (`user`, `session`, `account`, `verification`) plus every model contributed by a registered plugin (`organization`, `member`, `invitation`, `team`, `teamMember`, `passkey`, `apiKey`, `jwks`, `rateLimit`, and others) form a reserved namespace owned by chardb. You never write a Drizzle definition for them. `defineAuth(options)` returns the object the domain schema uses for foreign keys, with each table statically typed. Plugin tables are inferred from the `plugins` tuple:

```ts
defineAuth({ plugins: [organization()] });
//   ^ ChardbAuth<…> exposes:
//        auth.user.email           ← from KnownAuthTables
//        auth.organization.slug    ← from OrganizationSchema<O> via the
//                                    plugin's typed `schema` literal
//        auth.member.role          ← same path
//        auth.invitation.status    ← same path
//      Dropping `organization()` makes `auth.organization` a TS error.
```

`schema.ts` imports `auth` from `worker.ts` via the live ESM binding; Drizzle's `.references(() => auth.organization.id)` thunk defers evaluation past the cycle.

The reserved chardb prefixes (`/ws`, `/_chardb/*`) and the optional `/api/auth/*` better-auth mount are claimed inside `chardb({…})` before user routes run. Everything else falls through to Hono. Removed placeholders such as `/q`, `/f`, `/p`, and `/s` are not feature routes.

### Authorization lives on the table

`forOrg()` binds every `cdbTable` in `schema.ts` to the active organization. Each table's `roles` block declares row verbs and writable or readable columns. `selfBy` binds the `self` role to a user foreign key. The runtime compiles this metadata into its row and column policy forms; there are no separate `tenantScope` or `ownerScope` exports to keep in sync.

### Validator-driven args, intent extractors, no per-mutation type aliases

`api.ts` never declares a `Db`, `*Args`, or `*Row` alias. Each `api.mutation({...})` / `api.query({...})` call takes a **StandardSchemaV1 validator** (zod, valibot, arktype, typebox, drizzle-zod, …) as its `args:` field; chardb infers `TArgs` from the validator and runs it at the wire boundary, so the handler receives a fully typed, validated payload.

`api.query({...})` accepts an `intent: (args) => CdbIntent` extractor. The Vite transform stamps the exported handle with a stable ref. `useQuery(handle, args)` sends that ref and the raw arguments under protocol v2. Gateway resolves the server manifest, validates the arguments, and runs the intent extractor locally:

```tsx
// src/web/hooks.ts
import { useQuery } from "chardb/react";
import { listMessages } from "../server/queries.ts";

export function useChatMessages(channelId: string) {
  // The browser does not build or send intent. It sends the stamped
  // listMessages ref and these arguments.
  return useQuery(listMessages, { organizationId: "demo-org", channelId, limit: 50 });
}
```

Downstream consumers pull the wire shape out of the handle via `InferRow` / `InferArgs`:

```ts
import type { InferArgs, InferRow } from "chardb/react";

type PostMessageArgs = InferArgs<typeof postMessage>;
type MessageRow      = InferRow<typeof listMessages>;
```

Wire argument types live at the validator. The protocol decoder also rejects missing, extra, and incorrectly typed envelope fields. React hooks, tests, and other consumers import handle types through `typeof`.

The merged auth + domain schema is automatic: `chardb({ schema: domain, auth })` calls `synthesizeAuthSchema(auth.options)` internally and merges the synthesized tables into the runtime schema before the manifest is built. `schema.ts` only declares domain tables. Better Auth rows live in the singleton Catalog; Cdb stores domain rows, not auth models.

Catalog generates auth DDL with keys, uniqueness, foreign keys, indexes, supported defaults, nullability, and SQLite types. An existing table must have the exact matching `auth_ddl_v1` signature. Older layouts have no versioned upgrade path yet.

If a domain table shadows a reserved name (`organization`, `user`, `member`, …), `chardb({...})` raises `CDB_RESERVED_TABLE_NAME` at construction time with the conflicting names listed; rename the table or drop the plugin that owns the name.

## What this example demonstrates

- Organization-rooted Drizzle tables built with `forOrg()` and `cdbTable`.
- Mutation and query handles using the current exported package subpaths.
- Synchronous mutation handlers compatible with Durable Object SQLite transactions.
- A browser bundle that consumes the packed package instead of private source subpaths.
- The current React surface for auth, mutations, and queries.

The last item is API design, not proof of a working database. Gateway verifies JWT signatures and registered claims, but the public socket cannot call the trusted mutation dispatcher until Catalog resolves tenant membership, role, and policy authority. Initial query execution and live updates remain incomplete. Presence, upload, stream, and vector hooks are not exported. Migration commands do not apply domain DDL to deployed shards.

## Running

```bash
# 1) Build the package that the local file dependency will pack.
bun run build

# 2) Install the example's declared dependencies, then verify it.
cd example/chat
npm ci
npm run typecheck          # strict typecheck of server and web
npm run build              # production Vite build

# 3) Run the repository-only pure-layer test.
bun test test/e2e/
```

These commands verify package consumption, TypeScript contracts, the browser bundle, and the pure-layer tests. They do not verify a browser-to-workerd mutation, query, or live-subscription round trip.

## E2E coverage

- `e2e_oplog` runs 1000 mutations across 50 partitions. It checks deterministic vshard routing, op-log replay idempotency, `CDB_MUT_ID_COLLISION` on payload divergence, and per-partition serial commit order.

## Runtime wiring still required

Before this can be presented as a runnable demo, chardb needs Catalog-derived membership, role, and policy authority after its verified JWT identity boundary. It also needs domain migrations, initial query execution, and live replacement results. Query scatter must enumerate Catalog ranges instead of probing every 256th virtual shard. Shard subscriptions need composite Gateway, client, and subscription ids. Query identity must use canonical arguments plus verified auth and policy epochs. Existing `auth_ddl_v1` layouts need a versioned upgrade path.

Each auth mutation commits with every directly derivable old and new global, tenant, or principal epoch bump. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. Bulk updates and deletes preload matched rows to derive epoch scopes. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. Coverage uses a Bun fake-Durable-Object harness, not workerd.

JWT coverage includes real signatures, the Catalog resolver contract, and configured Gateway Durable Object WebSocket dispatch under Miniflare workerd with ES256 tokens and a real Catalog SQLite cache. The harness seeds `Catalog.putJwk` through a test-only HTTP route, so outbound JWKS fetch, cache refresh, and key rotation remain untested. The complete path still needs a workerd test covering sign-in, one authenticated write, one subscribed read, a live replacement, isolation from a second organization, and restart recovery. The Wrangler file remains a template until that test passes.
