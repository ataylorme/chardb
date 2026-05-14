# chardb chat example

The Cloudflare-native database with **better-auth built in**. Drizzle is the data heart, better-auth options drive the plumbing, plugins extend the auth surface — and routes that don't touch the auth layer still get the database. The whole backend is one factory call:

```ts
// src/server/worker.ts — paste-ready, this is the whole Worker
import { anonymous } from "better-auth/plugins/anonymous";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { chardb, defineAuth, defineRoles } from "chardb/server";
import * as api from "./api.ts";
import * as queries from "./queries.ts";
import * as domain from "./schema.ts";

export const auth = defineAuth({
  appName: "chat",
  plugins: [organization(), anonymous(), jwt()],
  // Bootstrap a shared demo org on every sign-in. Production apps
  // gate org creation behind their own flow.
  databaseHooks: { /* see worker.ts for the full hook */ },
});

export const chatRoles = defineRoles(
  {
    messages: ["create", "update", "delete"],
    channels: ["create", "rename", "delete"],
  },
  {
    admin:  { channels: ["create", "rename"] },
    member: { messages: ["create"] },
  },
);

export const app = chardb({ auth, schema: domain, api: { ...api, ...queries } });

app.get("/health", (c) => c.text("ok"));

export default app;
export const { BlobMeta, Catalog, Cdb, Gateway, GsiShard, Resharder } = app;
```

Auth, RBAC, the synthesized schema, the manifest, the Hono router, and the six Durable Object classes — **all visible top-to-bottom in one file**. The chardb-native better-auth adapter is wired automatically: every model write routes to the partition-owning Cdb shard (or the Catalog DO for replicated tables like `jwks`/`rateLimit`); every JWT-bearing request populates `ctx.auth.{userId, tenantId, role}` so policies + handlers read authenticated identity, not client-supplied args.

Mutations and policies stay light:

```ts
// src/server/api.ts
import { api, ownerScope, requirePermission, tenantScope } from "chardb/server";
import { z } from "zod";
import { messages } from "./schema.ts";
import { chatRoles } from "./worker.ts";

export const postMessage = api.mutation({
  args: z.object({ id: z.string(), channelId: z.string(), body: z.string().min(1), clientCreatedAt: z.number() }),
  // organizationId + authorId come from ctx.auth — never from the client.
  partitionKey: () => undefined,
  handler: async (ctx, args) => {
    if (!ctx.auth.userId || !ctx.auth.tenantId) throw new Error("CDB_FORBIDDEN");
    await ctx.db.insert(messages).values({
      id: args.id, channelId: args.channelId, body: args.body,
      organizationId: ctx.auth.tenantId, authorId: ctx.auth.userId,
      createdAt: args.clientCreatedAt,
    });
    return { id: args.id };
  },
});

export const orgIsolation     = tenantScope(() => messages);
export const messageOwnerOnly = ownerScope(() => messages, { for: "all" });
export const messageAdmins    = requirePermission(() => messages, () => chatRoles, {
  messages: ["delete", "update"],
});
```

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

The rest of this README is the org-tenanted chat schema, the React frontend, and the typing presence the example exercises.

## Layout

```
src/
  server/
    worker.ts                defineAuth + defineRoles + chardb({ auth, schema, api }) + routes + DOs
    schema.ts                Drizzle domain tables (channels, messages)
    api.ts                   api.mutation/presence + tenantScope/ownerScope/requirePermission
    queries.ts               api.query handles + intent extractors (client-safe value imports)
  web/
    main.tsx                 createRoot + <StrictMode> + styles.css
    App.tsx                  createAuthClient + <ChardbProvider endpoint=/ws auth={authClient} crossTab>
    hooks.ts                 useChatMessages / usePostMessage / useTypingPresence
    components/              ChannelList / MessageList / Composer / PresenceBar
    styles.css

index.html                   Vite entry → /src/web/main.tsx
vite.config.ts               vite + @vitejs/plugin-react + chardb/vite plugin
wrangler.template.jsonc      copy-pasteable wrangler.jsonc with assets binding
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

### Authorization rides on better-auth — one-line policies

chardb's row-level policies lift better-auth's `createAccessControl` / `role.authorize` primitives **verbatim** — the same `RolesMap` you hand to better-auth's `hasPermission` route gates chardb live-query reads and mutations. No parallel authorization model.

Helpers take the table as their first arg, or a `() => table` thunk to dodge the api.ts ↔ schema.ts ESM cycle (same idiom as Drizzle's `.references(() => …)`). Names auto-derive from the table identifier; pass `options.name` only when one table is gated by multiple policies of the same kind.

| Primitive                                 | What it does                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `tenantScope(table)`                      | `eq(table.organizationId, auth.tenantId)` + `authDependsOn` for tenant-keyed models. Name: `<table>_tenant`.            |
| `ownerScope(table)`                       | `eq(table.authorId, auth.userId)` + `authDependsOn` for principal-keyed models. Name: `<table>_owner`.                  |
| `requireRole(table, roles)`               | `auth.role` intersects `roles` (multi-role via comma split, matching better-auth). Name: `<table>_role`.                |
| `requirePermission(table, roles, req)`    | `roles[auth.role].authorize(req).success` — the exact better-auth check. Name: `<table>_permission`.                    |
| `publicRead(table)`                       | `to: "*"`, anonymous traffic admitted. Name: `<table>_public_read`.                                                     |

`chatRoles` (declared in `worker.ts`) powers both chardb's row-level policies and better-auth's REST `/hasPermission` check — one source of truth.

`defineRoles` ships with conventions that match better-auth's `organization()` plugin: `owner` and `admin` implicitly grant every action on every declared resource, `member` grants nothing. Per-role overrides are deltas — typically 1-2 lines per role. Custom role names (`billing`, `viewer`, …) get no defaults and must be specified explicitly.

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

## What's chardb-shaped about it

- **Single-partition by organization.** `auth.organization` is the distribution root. `channels` and `messages` FK into it, so chardb's colocation algorithm pins the org subtree to one vshard (`vshardOf([organizationId])`). The Gateway routes the mutation to the owning shard without loading the closure.
- **`ctx.auth` is authoritative.** `postMessage` reads `organizationId`/`authorId` from `ctx.auth.tenantId`/`ctx.auth.userId` — never from `args`. The Gateway threads JWT claims (`sub`, `activeOrganizationId`, `role`) into the mutation envelope so handlers and policies share the same vocabulary.
- **chardb-native better-auth adapter.** `chardb({auth})` auto-mounts `/api/auth/*` against an adapter that routes every model write to the partition-owning Cdb shard. Per-tenant models (`organization`/`member`/`invitation`) hash on `organizationId`; per-principal models (`user`/`session`/`account`/`passkey`/`apiKey`) hash on `userId`/`id`. Replicated models (`jwks`, `rateLimit`) pin to the Catalog DO so every shard sees the same canonical copy.
- **Better-auth `auth_epoch_*` bumps.** The adapter dispatches `bumpTenant(organizationId)` on writes to tenant-keyed models and `bumpPrincipal(userId)` on writes to principal-keyed ones, so tenant-scoped live queries re-validate on the next `poke`.
- **Op-log idempotency.** `runWrappedMutation` wraps every mutation inside the same `transactionSync` as the user closure: `INSERT OR IGNORE` into `_chardb_op_log` first; if the row exists with the same payload hash, return the cached envelope and skip the closure. Different payload for the same `mutId` raises `CDB_MUT_ID_COLLISION`.
- **Live queries via intent extractors.** `listMessages` declares an `intent: (args) => CdbIntent` extractor right next to its Drizzle handler; the React `useQuery(listMessages, args)` overload reads it. The extractor pins to one shard via the `partitionKey` field and narrows to one channel via an `intervals` block on `channel_id`.
- **Row-level isolation.** `orgIsolation` is a `chardbPolicy` whose `usingSql` AND-s `messages.organization_id = auth.tenantId` into the query before the planner sees it; the rewritten AST is what hashes for live-query fan-in, so two tenants share zero subscriber state.
- **Anonymous JWT flow.** `App.tsx` calls `authClient.signIn.anonymous()` then `ChardbProvider auth={authClient}` derives `getJwt` from `authClient.$fetch("/token")` — better-auth's `jwt()` plugin signs a JWT with the active session as `sub` and the active org as `activeOrganizationId`. The Gateway verifies it on every WS hello via the JWKS-backed `verifyJwt` resolver in the Catalog DO.
- **Presence.** `typing` is a `definePresenceKey<{user, until}>` — best-effort, ephemeral, riding the same hibernated WebSocket as live queries but bypassing the IntervalMap pipeline. `useTypingPresence` debounces `publish` to once per second so a fast typist doesn't drown the channel.

## Platform schema generation + migrations

`synthesizeAuthSchema(authOptions)` is the source of truth for the auth tables at runtime. For SQL migrations the same options object is the input that `bunx @better-auth/cli generate` consumes:

1. `drizzle-kit generate` emits DDL files against the merged schema that `defineChardb({ auth, schema })` exposes via `Configured.schema`. Adding a plugin adds tables; removing one drops them.
2. `chardb migrate` reads the `drizzle/_journal.json` produced by drizzle-kit and surfaces each pending DDL statement so the runtime applier can execute them. The applier itself (per-shard barrier, schema-epoch bump, `mustRefetch:schemaChanged` fan-out from `Catalog.cutover`) is on the roadmap; today the CLI emits the plan so your CI can pipe it.
3. The colocation walker hashes `policyDigest(assignments)` at `defineChardb` time and the `Catalog` DO compares it against the deployed value. `chardb doctor schema` is a planned wrapper around this check; today the diff fires at construction time only.

## How a write travels

```
client (Composer)      gateway DO              entrypoint Worker            Catalog DO            Cdb shard DO
------------------     ----------              ----------------            ----------            ------------
useMutation(postMessage)(args)
   ─wire──▶
                       Up.mut {ref, args, mutId}
                       ────▶ runMutation(ref, args, mutId)
                                                 manifest.resolveMutation(ref)
                                                 vshardOf([ extractPartitionKey(args) ])
                                                 ─────────────────────────▶ route(vshard) → ShardId
                                                                                          ────────▶ Cdb.mutate
                                                                                                       transactionSync:
                                                                                                         _chardb_op_log INSERT OR IGNORE
                                                                                                         (replay? return cached envelope)
                                                                                                         user closure runs
                                                                                                         _chardb_op_log UPDATE payload_enc
                       ◀──── MutResult ──────────────────────────────────────────────────────────
   ◀── poke(cookie, patches, mutResults)
useQuery re-renders with the new row; <Composer> resolves its `await send(...)`.
```

Every response carries `cf-chardb-correlation-id` + `Server-Timing` so the trace joins on a single id across client, gateway, entrypoint, and tail worker.

## Running

```bash
# 1) Pure-layer e2e tests (no install needed — workspace deps only).
cd example/chat
bun test test/e2e/        # 5 files, deterministic, <300ms/test on a laptop
bunx tsc --noEmit         # strict typecheck of both server and web

# 2) Bring the React frontend up locally against a workerd-backed chardb.
#    Install once (these deps are NOT part of the chardb workspace install).
bun add -d vite @vitejs/plugin-react
bun add react react-dom
bun run dev               # http://localhost:5173 — Vite proxies /ws → wrangler

#    In a second terminal:
cp wrangler.template.jsonc wrangler.jsonc
bunx wrangler@latest dev  # http://localhost:8787
```

The example imports chardb directly from `../../src/*` via the tsconfig `paths` mapping; no install or build step is needed for the workspace typecheck / test path.

## E2E coverage

- **e2e_oplog** — 1000 mutations × 50 partitions: deterministic vshard routing, op-log replay idempotency, `CDB_MUT_ID_COLLISION` on payload divergence, per-partition serial commit order.

## Production wiring (out of scope for the tests)

The `defineChardb` DO classes only run inside workerd. For a real deployment: copy `wrangler.template.jsonc` to `wrangler.jsonc`, run `chardb doctor` to confirm the binding shape, `vite build` to materialize the SPA into `./dist` (served by the `assets` binding), and `chardb deploy` to provision the tail consumer + Logpush jobs.
