# chardb chat tutorial

This is the small path through chardb. It has one organization-tenanted table, one mutation, one live query, and one React screen. Better Auth signs in an anonymous local user. Its organization client creates organizations, switches the active organization, and supplies the IDs used by every database call.

The files follow the same split an application should use:

```text
src/server/auth.ts       Better Auth organization, anonymous, and JWT plugins
src/server/schema.ts     one forOrg(auth) table
src/server/api.ts        postMessage mutation
src/server/queries.ts    listMessages live query
src/server/migrations/v1.ts  immutable deployed version-one schema snapshot
src/server/migrations.ts     append-only migration journal
src/server/worker.ts         chardb() and HTTP routes
src/web/App.tsx          Better Auth organization controls, live list, and message form
```

Do not edit `src/server/migrations/v1.ts` after a deployment reaches version one. Change the current schema in `src/server/schema.ts`, then append a versioned SQL entry to `src/server/migrations.ts`. Keeping the deployed snapshot separate prevents a later schema edit from changing the version-one digest.

`worker.ts` also exposes a direct read at `GET /api/messages?organizationId=<active-id>`. It uses the same schema and query compiler as the registered live handle:

```ts
const rows = await client(c.env.DB, { jwt, authOrigin: url.origin })
    .select()
    .from(messages)
    .where(eq(messages.organizationId, organizationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(50);
```

The live React path imports the server-owned query handle:

```tsx
const session = authClient.useSession();
const organizations = authClient.useListOrganizations();
const organizationId = session.data?.session.activeOrganizationId;

await authClient.organization.setActive({ organizationId });

function Messages({ organizationId }: { organizationId: string }) {
    return useQuery(listMessages, { organizationId, limit: 50 });
}
```

Run it locally:

```bash
bun run build
cd example/chat
npm ci
npm run typecheck
npm run build
npm run dev
```

`dev` starts Wrangler, reads the packaged schema version from `/health`, then applies that exact migration target. It prints the local URL only after the schema is active. Appending version two to `src/server/migrations.ts` makes the next `npm run dev` apply version two without another flag. The Wrangler config declares four same-Worker Durable Object namespaces for Chardb's internal calls. Application code uses only the exported `DB` binding.

The browser uses Better Auth's React client and native `useSession()` and `useListOrganizations()` hooks. It calls `organization.create()` and `organization.setActive()` directly. Chardb receives that same client through `ChardbProvider`; the tutorial does not maintain another session or membership store. The local auth configuration accepts an HTTP loopback browser origin only when the Worker request is also HTTP loopback. Production requests never inherit that development exception.

Wrangler sends `/api/auth/*`, `/ws`, and `/_chardb/*` through the Worker before static assets. Use `npm run dev:web` only when you need the separate Vite development server.

The previous multi-tenancy demo now lives in [`conformance/`](./conformance/README.md). It remains a source and stress-test fixture, but the tutorial compiler does not include it.
