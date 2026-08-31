import { client } from "@chardb/core";
import { chardb, defineMigrations, defineSchemaBaseline } from "@chardb/core/server";
import { and, eq, inArray } from "drizzle-orm";
import * as api from "./api.ts";
import { auth } from "./auth.ts";
import * as queries from "./queries.ts";
import * as domain from "./schema.ts";

export const migrations = defineMigrations([
    defineSchemaBaseline({
        version: 1,
        name: "initial_schema",
        domainSchema: domain,
        authOptions: auth.options,
    }),
]);

export const app = chardb({ auth, schema: domain, api: { ...api, ...queries }, migrations });

app.get("/health", c => c.text("ok"));
app.get("/api/version", c => c.json({ name: "chardb-chat-example", version: "0.1.0" }));
app.get("/api/db/messages", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const rows = await client(c.env.DB, { jwt, authOrigin: url.origin }).query(queries.listMessages, {
        organizationId: url.searchParams.get("organizationId") ?? "",
        channelId: url.searchParams.get("channelId") ?? "",
        limit: Number(url.searchParams.get("limit") ?? 50),
    });
    return c.json(rows);
});
app.get("/api/db/select/messages", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const organizationId = url.searchParams.get("organizationId") ?? "";
    const channelId = url.searchParams.get("channelId") ?? "";
    const id = url.searchParams.get("id");
    const db = client(c.env.DB, { jwt, authOrigin: url.origin });
    const predicate = and(
        eq(domain.messages.organizationId, organizationId),
        eq(domain.messages.channelId, channelId),
        ...(id === null ? [] : [eq(domain.messages.id, id)])
    );
    if (!predicate) throw new Error("direct select predicate is empty");
    const query = db.select().from(domain.messages).where(predicate);
    if (id !== null) return c.json((await query.get()) ?? null);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return c.json(await query.orderBy(domain.messages.createdAt, domain.messages.id).limit(limit));
});
app.get("/api/db/select/cross-partition", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const rows = await client(c.env.DB, { jwt, authOrigin: url.origin })
        .select()
        .from(domain.messages)
        .where(
            inArray(domain.messages.organizationId, [
                url.searchParams.get("left") ?? "",
                url.searchParams.get("right") ?? "",
            ])
        )
        .all();
    return c.json(rows);
});
app.post("/api/db/messages", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const body = await c.req.json<{
        id: string;
        organizationId: string;
        channelId: string;
        body: string;
        clientCreatedAt: number;
        mutId?: string;
    }>();
    const result = await client(c.env.DB, { jwt, authOrigin: url.origin }).mutate(api.postMessage, body, {
        ...(body.mutId ? { mutId: body.mutId } : {}),
    });
    return c.json(result);
});
app.get("/api/db/preferences", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const rows = await client(c.env.DB, { jwt, authOrigin: url.origin }).query(queries.listUserPreferences, {
        userId: url.searchParams.get("userId") ?? "",
    });
    return c.json(rows);
});
app.post("/api/db/preferences", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const body = await c.req.json<{ id: string; userId: string; theme: string; mutId?: string }>();
    const result = await client(c.env.DB, { jwt, authOrigin: url.origin }).mutate(api.createUserPreference, body, {
        ...(body.mutId ? { mutId: body.mutId } : {}),
    });
    return c.json(result);
});
app.get("/api/db/notices", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const rows = await client(c.env.DB, { jwt, authOrigin: url.origin }).query(queries.listGlobalNotices, {
        namespace: url.searchParams.get("namespace") ?? "",
    });
    return c.json(rows);
});
app.post("/api/db/notices", async c => {
    const jwt = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    const url = new URL(c.req.url);
    const body = await c.req.json<{ id: string; namespace: string; body: string; mutId?: string }>();
    const result = await client(c.env.DB, { jwt, authOrigin: url.origin }).mutate(api.createGlobalNotice, body, {
        ...(body.mutId ? { mutId: body.mutId } : {}),
    });
    return c.json(result);
});

export default app;
export const { DB, Catalog, Cdb, Gateway, Resharder } = app;
