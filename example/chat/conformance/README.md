# chardb chat conformance fixture

This directory preserves the former example after it grew into a multi-tenancy and durability test bed. It is deliberately outside the tutorial's TypeScript and Vite inputs. Use it to inspect the broader cases or run `npm run test:conformance` from `example/chat`.

This is a compile-checked example for chardb's chat API: Drizzle tables, better-auth configuration, a packaged schema journal, typed mutations and queries, and React hooks in one small application. It typechecks and produces a Vite build against a packed chardb package. The `postMessage` mutation and `listMessages` query opt into organization authority with explicit stable refs and partition metadata. [`scripts/smoke-packed-chat.mjs`](../../scripts/smoke-packed-chat.mjs) installs version 0.1.0 from a clean tarball, applies its packaged journal through that tarball's CLI, and proves Better Auth anonymous sign-in, live replacement, exact same-`mutId` replay, persistent restart, independent readback, and denial between principals in different organizations. Miniflare uses the same four explicit internal Durable Object namespaces as the deployed Wrangler config. This example is not ready for production data.

The intended backend surface is one factory call:

```ts
// src/server/worker.ts, abbreviated. See the source for the full concept.
import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { chardb, defineAuth, defineMigrations, defineSchemaBaseline } from "@chardb/core/server";
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

export const migrations = defineMigrations([
  defineSchemaBaseline({
    version: 1,
    name: "initial_schema",
    domainSchema: domain,
    authOptions: auth.options,
  }),
]);

export const app = chardb({ auth, schema: domain, api: { ...api, ...queries }, migrations });

app.get("/health", (c) => c.text("ok"));

export default app;
export const { DB, Catalog, Cdb, Gateway, Resharder } = app;
```

The source shows the composition of auth, schema, API handles, routes, and Durable Object exports used by the packed smoke proof.

Mutations and policies stay light:

```ts
// src/server/api.ts
import { api } from "@chardb/core/server";
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
import { api } from "@chardb/core/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { messages } from "./schema.ts";

export const listMessages = api.query({
  ref: "src/server/queries.ts#listMessages",
  args: z.object({ organizationId: z.string(), channelId: z.string(), limit: z.number().int().min(1).max(100) }),
  query: (db, args) =>
    db.select().from(messages).where(
      and(eq(messages.organizationId, args.organizationId), eq(messages.channelId, args.channelId))
    ).orderBy(desc(messages.createdAt), desc(messages.id)).limit(args.limit),
});
```

The React side uses the stamped handle without spelling out a `CdbIntent` or sending one over the wire:

```tsx
// src/web/App.tsx
import { createAuthClient } from "better-auth/client";
import { anonymousClient } from "better-auth/client/plugins";
import { ChardbProvider, useQuery } from "@chardb/react";
import { listMessages } from "../server/queries.ts";

const authClient = createAuthClient({ baseURL: location.origin, plugins: [anonymousClient()] });

export function App() {
  return (
    <ChardbProvider endpoint={`wss://${location.host}/ws`} auth={authClient}>
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
    queries.ts               api.query handles + single-source Drizzle plans
  web/
    main.tsx                 createRoot + <StrictMode> + styles.css
    App.tsx                  createAuthClient + <ChardbProvider endpoint=/ws auth={authClient}>
    hooks.ts                 useChatMessages / usePostMessage
    components/              ChannelList / MessageList / Composer
    styles.css

index.html                   Vite entry → /src/web/main.tsx
vite.config.ts               vite + @vitejs/plugin-react + @chardb/core/vite plugin
wrangler.template.toml       native migrations and optional platform resources
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

`publicRead` removes the matching table-role requirement for selects only. Gateway still requires a verified JWT, Catalog organization membership, and the exact tenant partition. It does not grant writes or cross-organization reads. Better Auth anonymous users count as authenticated principals only after sign-in issues a JWT and the account has organization membership. Subjectless Gateway queries stay closed.

Handlers can use typed builders only against registered `cdbTable` definitions. Chardb rejects raw SQL, session and client access, relational and count shortcuts, plain-table CRUD, insert-select, conflict methods, `returning`, and unsupported builder paths before policy enforcement can be bypassed. For live queries, Cdb records `cdbTable` dependencies at `FROM` construction and in tracked filters or ordering. It rejects raw or untracked predicates, embedded subqueries, and `orderBy` callbacks. Projections, joins, grouping, and richer query shapes remain closed.

### Validator-driven args and compiled query plans

`api.ts` never declares a `Db`, `*Args`, or `*Row` alias. Each `api.mutation({...})` / `api.query({...})` call takes a **StandardSchemaV1 validator** such as zod, valibot, arktype, typebox, or drizzle-zod as its `args:` field. Chardb infers `TArgs` from the validator. For public organization mutations and queries, Gateway validates and transforms raw arguments once, then uses that exact value for partition extraction, Catalog authorization, the Cdb request, and the validated handler entry point.

Mutations still declare `authority` and `partitionKey`. Planned queries use one synchronous Drizzle builder callback instead. Chardb derives authority, the exact partition, table dependencies, predicate intervals, projection, ordering, and limit from that builder before asking Catalog for authority. Cdb compiles the same callback again before execution and includes the plan hash in query identity, so a Gateway and Cdb build mismatch fails closed. SQL text never crosses the RPC boundary.

Planned queries require an explicit stable `ref`. `useQuery(handle, args)` sends that ref and the raw arguments under protocol v3. Gateway resolves the server manifest, validates the arguments, and compiles the builder locally:

```tsx
// src/web/hooks.ts
import { useQuery } from "@chardb/react";
import { listMessages } from "../server/queries.ts";

export function useChatMessages(channelId: string) {
  // The browser does not build or send intent. It sends the stamped
  // listMessages ref and these arguments.
  return useQuery(listMessages, { organizationId: "demo-org", channelId, limit: 50 });
}
```

The first planned-query version accepts one full-row `cdbTable` select with recognized typed predicate shapes, one exact nonempty string partition, at most 100 `inArray` values, deterministic ordering ending in the primary key, and a limit from 1 through 100. It rejects projections, joins, CTEs, raw SQL outside that recognized predicate grammar, placeholders, grouping, aggregates, set operations, offset pagination, multiple partitions, and async callbacks. Legacy `handler` plus `intent` queries remain compatible while applications migrate.

Gateway re-derives authority through Catalog and persists a unique generation before `Cdb.subscribe`. Matching commits enter the Cdb invalidation outbox. Gateway reruns dirty registrations with current Catalog authority and stages replacement snapshots until the client acknowledges the exact cookie. The client deduplicates and re-acknowledges a same-cookie retry. Cdb compares the derived table and range declaration with the reads it observes after row policy is applied. Gateway and Cdb also persist a static digest of those tables' row and column policy metadata.

Downstream consumers pull the wire shape out of the handle via `InferRow` / `InferArgs`:

```ts
import type { InferArgs, InferRow } from "@chardb/react";

type PostMessageArgs = InferArgs<typeof postMessage>;
type MessageRow      = InferRow<typeof listMessages>;
```

Wire argument types live at the validator. The protocol decoder also rejects missing, extra, and incorrectly typed envelope fields. React hooks, tests, and other consumers import handle types through `typeof`.

The merged auth + domain schema is automatic: `chardb({ schema: domain, auth })` calls `synthesizeAuthSchema(auth.options)` internally and merges the synthesized tables into the runtime schema before the manifest is built. `schema.ts` only declares domain tables. Better Auth rows live in the singleton Catalog; Cdb stores domain rows, not auth models.

Catalog generates auth DDL with keys, uniqueness, foreign keys, indexes, supported defaults, nullability, and SQLite types. Migration completion verifies every table and index against that rendered schema before recording current `auth_ddl_v1` signatures.

The example's version-one journal is a rendered baseline containing its full domain and Catalog auth DDL. Fresh and existing version-zero storage remains closed until `chardb migrate` applies that exact packaged version. Later forward migrations can supply ordered Cdb and Catalog SQL. This is a maintenance path, not an online migration protocol.

The packed smoke creates an organization through Better Auth, explicitly activates it, invites a second anonymous principal, and has that principal accept the invitation. The organization ID returned by Better Auth drives every Chardb read, write, subscription, and restart check.

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

The separate packed smoke copies this example into a clean temporary consumer, installs chardb 0.1.0 from its tarball, builds the Vite client with both stable refs, starts workerd, and applies version one through the packed CLI. One Better Auth principal creates and activates an organization, invites a second principal, and both acknowledge the empty initial result and the same live replacement. The smoke replays the exact mutation with an identical result and one row, closes both sockets, restarts Miniflare over the same Durable Object storage, and reconstructs both sessions. The second principal then leaves the organization and is denied access while the owner retains the row. It does not cover outbound JWKS rotation, exact resume replay, or a multi-version production upgrade. Presence, upload, stream, and vector hooks are not exported.

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

# Start the local Worker and apply the packaged journal before it reports ready.
bun run dev:worker

# 3) Run the repository-only pure-layer test.
bun test test/e2e/
```

These commands verify package consumption, TypeScript contracts, the browser bundle, and the pure-layer tests. The repository-level `scripts/smoke-packed-chat.mjs` adds the clean-tarball workerd proof.

## E2E coverage

- `e2e_oplog` runs 1000 mutations across 50 partitions. It checks deterministic vshard routing, op-log replay idempotency, `CDB_MUT_ID_COLLISION` on payload divergence, and per-partition serial commit order.

## Runtime wiring still required

The packed smoke proves two anonymous principals across the packed migration, same-organization live delivery, persistent Worker and Durable Object restart, same-`mutId` replay, independent readback, and later organization isolation. It still needs outbound JWKS rotation and exact missed-change replay. The narrow runtime persists exact Gateway and Cdb generations, auth epochs, the static table-policy digest, retry state, and delivery cookies. Intent interval verification remains open. The separate configured migration harness proves a real version-zero to version-one domain and Catalog upgrade, fresh journal install, baseline adoption, stale and future epoch rejection, replay, and reconstruction.

The repository audit still reports five advisories through `miniflare@4.20260730.0 -> undici@7.28.0`. Miniflare 4 pins that version, and the fixed `undici@7.29.0` currently requires Miniflare 5 alpha. The example does not override the dependency.

Each auth mutation commits with every directly derivable old and new global, tenant, or principal epoch bump. Better Auth workflows that make several adapter calls remain sequential because the adapter reports `transaction: false`. Bulk updates and deletes preload matched rows to derive epoch scopes. Indirect plugin relationships without placement metadata or conventional `organizationId` or `userId` fields may lack a secondary scope. Coverage uses a Bun fake-Durable-Object harness, not workerd.

JWT coverage includes real signatures, the Catalog resolver contract, and configured Gateway Durable Object WebSocket dispatch under Miniflare workerd with ES256 tokens, a real Catalog SQLite cache, and a configured Cdb. The verified attachment stores the subject only. Catalog supplies current organization authority for each declared mutation, initial query, and dirty live-query rerun. A workerd test keeps a socket open through role downgrade, role restoration, and membership deletion. Auth refresh barriers use a server connection id, drain admitted operations, retire current durable registrations, report affected subscription ids through `mustRefetch`, gate later work, and store a terminal rejected attachment before closing on failure. Catalog's authority read does not cancel an in-flight Cdb call that it already authorized. A configured Catalog workerd test creates a user, session, organization, and member, evicts the Catalog Durable Object, proves a new instance started, and reads identical stored auth rows and canonical organization authority after reconstruction. Focused harnesses seed JWKs and auth rows through test-only routes, while the packed smoke separately uses Better Auth HTTP anonymous sign-in and token issue for both principals. Outbound JWKS fetch, cache refresh, key rotation, and packed restart recovery have configured or packed coverage. The Wrangler file remains a template because exact resume replay and broader operational claims are still open.
