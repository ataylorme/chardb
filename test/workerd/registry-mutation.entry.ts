import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { chardb } from "../../src/server/chardb.ts";
import { createApi } from "../../src/server/define.ts";
import type { CdbMutationRequest, CdbMutationResponse } from "../../src/server/do/cdb.ts";

const entries = sqliteTable("registry_entries", {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    value: integer("value").notNull(),
});
const schema = { entries };
const api = createApi(schema);

const putEntry = api.mutation({
    args: z.object({ id: z.string().min(1), value: z.number().int() }),
    handler: function putEntry(ctx, args) {
        if (args.id === "explode") throw new Error("unexpected handler failure");
        ctx.db.run(
            "CREATE TABLE IF NOT EXISTS registry_entries (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, value INTEGER NOT NULL)"
        );
        ctx.db.insert(entries).values({ id: args.id, ownerId: ctx.auth.userId, value: args.value }).run();
        return {
            saved: { id: args.id, value: args.value },
            actor: {
                userId: ctx.auth.userId,
                tenantId: ctx.auth.tenantId ?? null,
                role: ctx.auth.role ?? null,
                probeClaim: ctx.auth.claims.probe ?? null,
            },
        };
    },
});

const inspectEntries = api.mutation({
    args: z.object({ label: z.string() }),
    handler: function inspectEntries(ctx, args) {
        ctx.db.run(
            "CREATE TABLE IF NOT EXISTS registry_entries (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, value INTEGER NOT NULL)"
        );
        const rows = ctx.db.select().from(entries).orderBy(entries.id).all();
        return {
            label: args.label,
            rows,
            reader: ctx.auth.userId,
        };
    },
});

const app = chardb({ schema, api: { putEntry, inspectEntries } });
export const Cdb = app.Cdb;

interface DispatchBody {
    readonly operation: "put" | "inspect" | "unknown";
    readonly mutId: string;
    readonly args: unknown;
}

const AUTH = {
    userId: "registry-user",
    tenantId: "registry-org",
    role: "member",
    claims: { probe: "claim-ok" },
} as const;

export default {
    async fetch(request: Request, env: { readonly CDB: DurableObjectNamespace }): Promise<Response> {
        const body = (await request.json()) as DispatchBody;
        const ref =
            body.operation === "put"
                ? putEntry.__chardbRef
                : body.operation === "inspect"
                  ? inspectEntries.__chardbRef
                  : "src/probe.ts#missing";
        const mutationRequest: CdbMutationRequest = {
            principalId: AUTH.userId,
            mutId: body.mutId,
            ref,
            args: body.args as CdbMutationRequest["args"],
            auth: AUTH,
            schemaEpoch: 1,
        };
        const id = env.CDB.idFromName("configured-registry");
        const stub = env.CDB.get(id) as unknown as {
            mutate(input: CdbMutationRequest): Promise<CdbMutationResponse>;
        };
        return Response.json(await stub.mutate(mutationRequest));
    },
};
