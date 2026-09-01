import { client } from "@chardb/core";
import { chardb } from "@chardb/core/server";
import { desc, eq } from "drizzle-orm";
import * as api from "./api.ts";
import { auth } from "./auth.ts";
import { migrations } from "./migrations.ts";
import * as queries from "./queries.ts";
import * as schema from "./schema.ts";

export const app = chardb({
    ownership: "organization",
    auth,
    authBasePath: "/api/auth",
    schema,
    api: { ...api, ...queries },
    migrations,
});

function bearer(request: { header(name: string): string | undefined }): string | null {
    return request.header("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

app.get("/health", c =>
    c.json({
        ok: true,
        schemaVersion: migrations.version,
        releaseSha256: (c.env as unknown as { readonly CDB_RELEASE_SHA256?: string }).CDB_RELEASE_SHA256 ?? null,
    })
);

app.get("/api/messages", async c => {
    const jwt = bearer(c.req);
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const organizationId = url.searchParams.get("organizationId") ?? "";
    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
        return c.json({ error: "limit must be an integer from 1 through 100" }, 400);
    }
    const db = client(c.env.DB, { jwt, authOrigin: url.origin });
    const rows = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.organizationId, organizationId))
        .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
        .limit(requestedLimit);
    return c.json(rows);
});

app.post("/api/messages", async c => {
    const jwt = bearer(c.req);
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const body = await c.req.json<Parameters<typeof api.postMessage>[1] & { readonly mutId?: string }>();
    return c.json(
        await client(c.env.DB, { jwt, authOrigin: url.origin }).mutate(api.postMessage, body, {
            ...(body.mutId ? { mutId: body.mutId } : {}),
        })
    );
});

export default app;
export const { DB, Catalog, Cdb, Gateway, Resharder } = app;
