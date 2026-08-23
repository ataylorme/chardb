# chardb chat example

This is a compile-checked concept example for chardb's intended chat API: Drizzle tables, better-auth configuration, typed mutations and queries, and React hooks in one small application. It currently typechecks and produces a Vite build against a packed chardb package. It is not an end-to-end runnable demo: the public mutation, query, and live-subscription path still needs to be completed and verified against workerd.

The intended backend surface is one factory call:

```ts
// src/server/worker.ts — abbreviated; see the source for the full concept
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
  // Live-subscription intent — picked up by useQuery(listMessages, args).
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

The React side reads it without ever spelling out a `CdbIntent`:

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

The four core better-auth tables (`user`, `session`, `account`, `verification`) plus every model contributed by a registered plugin (`organization`, `member`, `invitation`, `team`, `teamMember`, `passkey`, `apiKey`, `jwks`, `rateLimit`, …) are a **reserved namespace** owned by chardb. You never write a Drizzle definition for them — `defineAuth(options)` returns the single object the domain schema FKs into, with each table statically typed (autocomplete on `auth.organization.slug`, `auth.user.email`, `auth.member.organizationId`, …). Plugin tables are inferred from the `plugins` tuple:

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

The reserved chardb prefixes (`/ws`, `/_chardb/*`) and the optional `/api/auth/*` better-auth mount are claimed inside `chardb({…})` before user routes run; everything else falls through to Hono.

### Authorization lives on the table

`forOrg()` binds every `cdbTable` in `schema.ts` to the active organization. Each table's `roles` block declares row verbs and writable or readable columns. `selfBy` binds the `self` role to a user foreign key. The runtime compiles this metadata into its row and column policy forms; there are no separate `tenantScope` or `ownerScope` exports to keep in sync.

### Validator-driven args, intent extractors, no per-mutation type aliases

`api.ts` never declares a `Db`, `*Args`, or `*Row` alias. Each `api.mutation({...})` / `api.query({...})` call takes a **StandardSchemaV1 validator** (zod, valibot, arktype, typebox, drizzle-zod, …) as its `args:` field; chardb infers `TArgs` from the validator and runs it at the wire boundary, so the handler receives a fully typed, validated payload.

`api.query({...})` accepts an `intent: (args) => CdbIntent` extractor; the React `useQuery(handle, args)` overload reads it so the user never hand-writes a `CdbIntent` literal that has to track the handler's filter shape:

```tsx
// src/web/hooks.ts
import { useQuery } from "chardb/react";
import { listMessages } from "../server/queries.ts";

export function useChatMessages(channelId: string) {
  // No `useMemo<CdbIntent>(...)` — the intent extractor lives with the
  // server query in `queries.ts` (`defineQuery({intent: ...})`).
  return useQuery(listMessages, { organizationId: "demo-org", channelId, limit: 50 });
}
```

Downstream consumers pull the wire shape out of the handle via `InferRow` / `InferArgs`:

```ts
import type { InferArgs, InferRow } from "chardb/react";

type PostMessageArgs = InferArgs<typeof postMessage>;
type MessageRow      = InferRow<typeof listMessages>;
```

Wire types live at one site — the validator. React hooks, e2e tests, and anything else import them via `typeof`. Swap zod for valibot or arktype and the rest of the code is unchanged.

The merged auth + domain schema is automatic: `chardb({ schema: domain, auth })` calls `synthesizeAuthSchema(auth.options)` internally and merges the synthesized tables into the runtime schema before the manifest is built. `schema.ts` only declares domain tables.

If a domain table shadows a reserved name (`organization`, `user`, `member`, …), `chardb({...})` raises `CDB_RESERVED_TABLE_NAME` at construction time with the conflicting names listed; rename the table or drop the plugin that owns the name.

## What this example demonstrates

- Organization-rooted Drizzle tables built with `forOrg()` and `cdbTable`.
- Mutation and query handles using the current exported package subpaths.
- Synchronous mutation handlers compatible with Durable Object SQLite transactions.
- A browser bundle that consumes the packed package instead of private source subpaths.
- The intended React surface for auth, mutations, and queries.

The last item is API design, not working runtime behavior. Gateway JWT verification, public mutation dispatch, initial query execution, and live updates remain incomplete. Presence has no React hook until its client path works. Migration commands also do not apply domain DDL to deployed shards.

## Running

```bash
# 1) Build the package that the local file dependency will pack.
bun run build

# 2) Install the example's declared dependencies, then verify it.
cd example/chat
npm install
npm run typecheck          # strict typecheck of server and web
npm run build              # production Vite build

# 3) Run the repository-only pure-layer test.
bun test test/e2e/        # 5 files, deterministic, <300ms/test on a laptop
```

These commands verify package consumption, TypeScript contracts, the browser bundle, and the pure-layer tests. They do not verify a browser-to-workerd mutation, query, or live-subscription round trip.

## E2E coverage

- **e2e_oplog** — 1000 mutations × 50 partitions: deterministic vshard routing, op-log replay idempotency, `CDB_MUT_ID_COLLISION` on payload divergence, per-partition serial commit order.

## Runtime wiring still required

Before this can be presented as a runnable demo, chardb needs a supported public path from the generated Worker entrypoint through mutation dispatch, query execution, and live subscriptions. That path then needs a workerd integration test covering one authenticated write and one subscribed read. The Wrangler file is only a template until that test passes.
