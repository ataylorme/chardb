# chardb chat example

This is a compile-checked concept example for chardb's chat API: Drizzle tables, better-auth configuration, typed mutations and queries, and React hooks in one small application. It typechecks and produces a Vite build against a packed chardb package. The `postMessage` mutation and `listMessages` query opt into organization authority with explicit stable refs and partition metadata. [`scripts/smoke-packed-chat.mjs`](../../scripts/smoke-packed-chat.mjs) installs version 0.1.0 from a clean tarball. It proves actual Better Auth anonymous sign-in, live replacement, same-`mutId` replay, independent readback, and denial between two principals in different organizations. Resume replay remains unfinished, and this example is not ready for production data.

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

The source shows the composition of auth, schema, API handles, routes, and Durable Object exports used by the packed smoke proof.

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
  // Developer-declared routing intent evaluated on the server. The browser
  // sends only this export's stamped ref and the raw arguments passed to useQuery.
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

Handlers can use typed builders only against registered `cdbTable` definitions. Chardb rejects raw SQL, session and client access, relational and count shortcuts, plain-table CRUD, insert-select, conflict methods, `returning`, and unsupported builder paths before policy enforcement can be bypassed. For live queries, Cdb records `cdbTable` dependencies at `FROM` construction and in tracked filters or ordering. It rejects raw or untracked predicates, embedded subqueries, and `orderBy` callbacks. Projections, joins, grouping, and richer query shapes remain closed.

### Validator-driven args, intent extractors, no per-operation type aliases

`api.ts` never declares a `Db`, `*Args`, or `*Row` alias. Each `api.mutation({...})` / `api.query({...})` call takes a **StandardSchemaV1 validator** such as zod, valibot, arktype, typebox, or drizzle-zod as its `args:` field. Chardb infers `TArgs` from the validator. For public organization mutations and queries, Gateway validates and transforms raw arguments once, then uses that exact value for partition extraction, Catalog authorization, the Cdb request, and the validated handler entry point.

`authority: "organization"` is an explicit opt-in. Mutations and queries require a literal stable `ref` and a nonempty string partition key; queries also require a developer-declared intent callback that Gateway evaluates on the server. Gateway sends Catalog only the verified JWT subject and the organization extracted from validated arguments. Catalog returns current membership, role, roles, and global, tenant, and principal auth epochs. JWT tenant, role, and custom claims are ignored. Cdb treats the request as a trusted post-validation internal seam and runs the validated handler without applying the argument transform again. Operations without the authority declaration stay closed with `CDB_AUTH_NOT_BOUND`.

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

For an explicit organization query, Gateway requires the declared partition and developer-declared server-side intent to identify the same exact organization and one virtual shard. It re-derives authority through Catalog and persists a unique generation before `Cdb.subscribe`. Matching commits enter the Cdb invalidation outbox. Gateway reruns dirty registrations with current Catalog authority and stages replacement snapshots until the client acknowledges the exact cookie. The client deduplicates and re-acknowledges a same-cookie retry. Before Cdb returns a supported full-row result, it compares the conservatively recorded `cdbTable` dependencies with `intent.tables`. Declared interval coverage is not yet verified.

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
- An explicit exact-partition organization query declaration for live replacement snapshots.
- Synchronous mutation handlers compatible with Durable Object SQLite transactions.
- A browser bundle that consumes the packed package instead of private source subpaths.
- The current React surface for auth, mutations, and queries.

The repository's focused workerd harnesses prove that refs imported from a real emitted Vite browser chunk match an independently bundled Worker and run a declared organization mutation through Gateway, Catalog, Cdb policy, and the atomic op-log. The live harness connects two org-A clients and one org-B client. It covers initial snapshots and acknowledgements, a public mutation, Cdb invalidation delivery, replacement snapshots and acknowledgements, an org-B rerun that stays empty under policy, outbox drain, and reconnect with a fresh subscription. It also evicts Gateway and Cdb with a hibernated socket and a staged replacement, then delivers and acknowledges the stored snapshot after both objects restart. Those harnesses use test-only auth setup.

The separate packed smoke copies this example into a clean temporary consumer, installs chardb 0.1.0 from its tarball, and builds the Vite client with both stable refs. Its first Better Auth principal confirms the demo organization hook selected `demo-org`, acknowledges an empty initial snapshot, executes `postMessage`, acknowledges the live replacement, replays the same `mutId`, and reads exactly one row through a second subscription. A second principal moves to another organization. Its `demo-org` query receives `CDB_FORBIDDEN`, while its own organization returns an empty snapshot. The smoke does not restart the Worker or Durable Objects and does not cover outbound JWKS rotation, resume replay, or migrations. Presence, upload, stream, and vector hooks are not exported.

Client mutations use `mutationTimeoutMs`, which defaults to 60 seconds and is also accepted by `ChardbProvider`. The original deadline continues across reconnects, and each resend uses the same pending `mutId`. Timeout rejects with nonretryable `CDB_MUTATION_OUTCOME_UNKNOWN` because the server may have committed the request. Synchronous send failure, client close or session failure, and a terminal server result clear the timer. The public API does not expose a retry handle or automatic retry policy.

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

These commands verify package consumption, TypeScript contracts, the browser bundle, and the pure-layer tests. The repository-level `scripts/smoke-packed-chat.mjs` adds the clean-tarball workerd proof.

## E2E coverage

- `e2e_oplog` runs 1000 mutations across 50 partitions. It checks deterministic vshard routing, op-log replay idempotency, `CDB_MUT_ID_COLLISION` on payload divergence, and per-partition serial commit order.

## Runtime wiring still required

The packed smoke proves two anonymous principals in different organizations. It covers same-`mutId` replay, live replacement, independent readback, denial of a cross-organization query, and an empty result inside the second principal's own organization. It still needs Worker and Durable Object restart, outbound JWKS rotation, versioned domain migrations, and missed-change replay. The narrow runtime persists exact Gateway and Cdb generations, auth epochs, retry state, and delivery cookies. Query identity still needs an enforced policy epoch or digest. Existing `auth_ddl_v1` layouts need a versioned upgrade path.

The repository audit still reports five advisories through `miniflare@4.20260730.0 -> undici@7.28.0`. Miniflare 4 pins that version, and the fixed `undici@7.29.0` currently requires Miniflare 5 alpha. The example does not override the dependency.

Each auth mutation commits with every directly derivable old and new global, tenant, or principal epoch bump. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. Bulk updates and deletes preload matched rows to derive epoch scopes. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. Coverage uses a Bun fake-Durable-Object harness, not workerd.

JWT coverage includes real signatures, the Catalog resolver contract, and configured Gateway Durable Object WebSocket dispatch under Miniflare workerd with ES256 tokens, a real Catalog SQLite cache, and a configured Cdb. The verified attachment stores the subject only. Catalog supplies current organization authority for each declared mutation, initial query, and dirty live-query rerun. A workerd test keeps a socket open through role downgrade, role restoration, and membership deletion. Auth refresh barriers use a server connection id, drain admitted operations, retire current durable registrations, report affected subscription ids through `mustRefetch`, gate later work, and store a terminal rejected attachment before closing on failure. Catalog's authority read does not cancel an in-flight Cdb call that it already authorized. A configured Catalog workerd test creates a user, session, organization, and member, evicts the Catalog Durable Object, proves a new instance started, and reads identical stored auth rows and canonical organization authority after reconstruction. Focused harnesses seed JWKs and auth rows through test-only routes, while the packed smoke separately uses Better Auth HTTP anonymous sign-in and token issue for both principals. Outbound JWKS fetch, cache refresh, key rotation, packed restart recovery, and general versioned auth migrations remain untested. The Wrangler file remains a template until those broader tests pass.
