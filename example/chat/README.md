# chardb chat example

This is a compile-checked concept example for chardb's chat API: Drizzle tables, better-auth configuration, typed mutations and queries, and React hooks in one small application. It typechecks and produces a Vite build against a packed chardb package. The `postMessage` mutation and `listMessages` query opt into organization authority with explicit stable refs and partition metadata. A focused repository workerd harness proves the mutation path and one exact-partition initial query snapshot, but it does not run this packed app or Better Auth sign-in. Server registration, live updates, replay, and presence remain unfinished, so this is not an end-to-end runnable demo.

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
  // Reuse the shared demo org and this user's membership on sign-in.
  // Production apps gate org creation behind their own flow.
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
  ref: "src/server/api.ts#postMessage",
  authority: "organization",
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
  ref: "src/server/queries.ts#listMessages",
  args: z.object({ organizationId: z.string(), channelId: z.string(), limit: z.number().int().positive() }),
  authority: "organization",
  partitionKey: "organizationId",
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

`forOrg()` binds every `cdbTable` in `schema.ts` to the active organization. Each table's `roles` block declares row verbs and writable or readable columns. `selfBy` binds the `self` role to a user foreign key. Inserts, updates, deletes, and full-row selects require matching grants. Inserts and updates enforce writable columns, and managed authority columns cannot change. Updates, deletes, and selects add tenant and self predicates even without a caller `where`. Select results receive readable-column masks. Projections and joins stay blocked until their result shapes can be masked safely. There are no separate `tenantScope` or `ownerScope` exports to keep in sync.

Handlers can use typed builders only against registered `cdbTable` definitions. Chardb rejects raw SQL, session and client access, relational and count shortcuts, plain-table CRUD, insert-select, conflict methods, `returning`, and unsupported builder paths before policy enforcement can be bypassed.

### Validator-driven args, intent extractors, no per-operation type aliases

`api.ts` never declares a `Db`, `*Args`, or `*Row` alias. Each `api.mutation({...})` / `api.query({...})` call takes a **StandardSchemaV1 validator** (zod, valibot, arktype, typebox, drizzle-zod, …) as its `args:` field; chardb infers `TArgs` from the validator. For public organization mutations and initial queries, Gateway validates and transforms raw arguments once, then uses that exact value for partition extraction, Catalog authorization, the Cdb request, and the validated handler entry point.

`authority: "organization"` is an explicit opt-in. Mutations and queries require a literal stable `ref` and a nonempty string partition key; queries also require a server-owned intent. Gateway sends Catalog only the verified JWT subject and the organization extracted from validated arguments. Catalog returns current membership, role, roles, and global, tenant, and principal auth epochs. JWT tenant, role, and custom claims are ignored. Cdb treats the request as a trusted post-validation internal seam and runs the validated handler without applying the argument transform again. Operations without the authority declaration stay closed with `CDB_AUTH_NOT_BOUND`.

`api.query({...})` accepts an `intent: (args) => CdbIntent` extractor. The Vite transform stamps the exported handle with a stable ref. `useQuery(handle, args)` sends that ref and the raw arguments under protocol v3. Gateway resolves the server manifest, validates the arguments, and runs the intent extractor locally:

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

For an explicit organization query, Gateway requires the declared partition and server-owned intent to identify the same exact organization and one virtual shard. It re-derives authority through Catalog, routes to one Cdb read, and sends one protocol-v3 snapshot, including an empty snapshot. This initial read does not register the query on Gateway or Cdb, and committed mutations do not invalidate or re-run it.

Downstream consumers pull the wire shape out of the handle via `InferRow` / `InferArgs`:

```ts
import type { InferArgs, InferRow } from "chardb/react";

type PostMessageArgs = InferArgs<typeof postMessage>;
type MessageRow      = InferRow<typeof listMessages>;
```

Wire argument types live at the validator. The protocol decoder also rejects missing, extra, and incorrectly typed envelope fields. React hooks, tests, and other consumers import handle types through `typeof`.

The merged auth + domain schema is automatic: `chardb({ schema: domain, auth })` calls `synthesizeAuthSchema(auth.options)` internally and merges the synthesized tables into the runtime schema before the manifest is built. `schema.ts` only declares domain tables. Better Auth rows live in the singleton Catalog; Cdb stores domain rows, not auth models.

Catalog generates auth DDL with keys, uniqueness, foreign keys, indexes, supported defaults, nullability, and SQLite types. An existing table must have the exact matching `auth_ddl_v1` signature. Older layouts have no versioned upgrade path yet.

Fresh Cdb storage also renders the configured domain tables and indexes, records their signatures, and rejects drift. This bootstrap does not migrate an existing shard to a newer schema.

The demo session hook finds or creates the shared organization, reuses the user's existing membership, and sets the session's active organization. It confirms a row exists before treating a concurrent create error as success. Focused tests cover repeated bootstrap, so returning users no longer collide with the demo membership primary key.

If a domain table shadows a reserved name (`organization`, `user`, `member`, …), `chardb({...})` raises `CDB_RESERVED_TABLE_NAME` at construction time with the conflicting names listed; rename the table or drop the plugin that owns the name.

## What this example demonstrates

- Organization-rooted Drizzle tables built with `forOrg()` and `cdbTable`.
- Mutation and query handles using the current exported package subpaths.
- A public organization mutation declaration with an explicit stable ref.
- An explicit exact-partition organization query declaration for an initial snapshot.
- Synchronous mutation handlers compatible with Durable Object SQLite transactions.
- A browser bundle that consumes the packed package instead of private source subpaths.
- The current React surface for auth, mutations, and queries.

The repository's workerd harness proves that refs imported from a real emitted Vite browser chunk match an independently bundled Worker, runs a declared organization mutation through Gateway, Catalog, Cdb policy, and the atomic op-log, then returns one authorized exact-partition Cdb read as a protocol-v3 snapshot. It covers nonempty and empty snapshots but uses test-only routes to seed JWKs and auth rows rather than this example's Better Auth sign-in. It does not register the query or produce live results after later writes. Presence, upload, stream, and vector hooks are not exported. Migration commands do not upgrade domain DDL on deployed shards.

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

Before this can be presented as a runnable demo, the packed chat app needs a workerd test that starts with Better Auth sign-in, runs `postMessage`, and independently reads the stored row through its declared initial query. It also needs versioned domain migrations, server-side query registration, replay, and live invalidation with replacement snapshots. Query identity must use canonical arguments plus verified auth and policy epochs. Persisted shard registrations already use composite Gateway, client, and subscription ids and rebuild after Cdb startup, but the public initial-query path does not create them and they still lack verified tenant, epoch, and delivery-cookie state. Existing `auth_ddl_v1` layouts need a versioned upgrade path.

The repository audit still reports five advisories through `miniflare@4.20260730.0 -> undici@7.28.0`. Miniflare 4 pins that version, and the fixed `undici@7.29.0` currently requires Miniflare 5 alpha. The example does not override the dependency.

Each auth mutation commits with every directly derivable old and new global, tenant, or principal epoch bump. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. Bulk updates and deletes preload matched rows to derive epoch scopes. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. Coverage uses a Bun fake-Durable-Object harness, not workerd.

JWT coverage includes real signatures, the Catalog resolver contract, and configured Gateway Durable Object WebSocket dispatch under Miniflare workerd with ES256 tokens, a real Catalog SQLite cache, and a configured Cdb. The verified attachment stores the subject only. Catalog supplies current organization authority for each declared mutation and exact-partition initial query. Auth refresh barriers use a server connection id, drain admitted operations, report delivered snapshot ids through `mustRefetch`, gate later work, and store a terminal rejected attachment before closing on failure. Catalog's authority read does not cancel an in-flight Cdb call that it already authorized. The harness seeds JWKs and auth rows through test-only routes, so outbound JWKS fetch, cache refresh, key rotation, and the full Better Auth sign-in path remain untested. The complete packed-app test still needs sign-in, persisted readback, a live replacement, isolation from a second organization, and restart recovery. The Wrangler file remains a template until that test passes.
