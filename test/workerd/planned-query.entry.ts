import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { and, desc, eq, inArray } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { type ChardbBinding, client } from "../../src/index.ts";
import { gatewayBucketName } from "../../src/server/gateway-bucket.ts";
import { api, chardb, defineAuth, forOrg } from "../../src/server/index.ts";
import { type ChardbManifest, manifestFromExports } from "../../src/server/manifest.ts";
import { vshardOf } from "../../src/vshard.ts";

const ISSUER = "https://issuer.example";
const AUDIENCE = "chardb-workerd";
const JWKS_URL = "https://unreachable.invalid/jwks";
const USER_ID = "planned-query-user";
const OTHER_USER_ID = "planned-query-user-other";
const ORGANIZATION_ID = "planned-query-org";
const OTHER_ORGANIZATION_ID = "planned-query-org-other";
const QUERY_REF = "test/workerd/planned-query.entry.ts#listPlannedQueryRows";

const auth = defineAuth({
    appName: "planned-query-workerd-test",
    baseURL: ISSUER,
    plugins: [
        organization(),
        jwt({
            jwt: { issuer: ISSUER, audience: AUDIENCE },
            jwks: {
                remoteUrl: JWKS_URL,
                keyPairConfig: { alg: "ES256" },
            },
        }),
    ],
});

const { cdbTable } = forOrg(auth);
const plannedQueryRows = cdbTable(
    "planned_query_workerd_rows",
    {
        id: text("id").primaryKey(),
        channelId: text("channel_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    {
        roles: { member: { read: "*" } },
    }
);

const queryArgs = z.object({
    organizationId: z.string(),
    channelId: z.string(),
    limit: z.number().int().min(1).max(100),
});

const listPlannedQueryRows = api.query({
    ref: QUERY_REF,
    args: queryArgs,
    query: (db, args) =>
        db
            .select()
            .from(plannedQueryRows)
            .where(
                and(
                    eq(plannedQueryRows.organizationId, args.organizationId),
                    eq(plannedQueryRows.channelId, args.channelId)
                )
            )
            .orderBy(plannedQueryRows.id)
            .limit(args.limit),
});

const driftedPlannedQueryRows = api.query({
    ref: QUERY_REF,
    args: queryArgs,
    query: (db, args) =>
        db
            .select()
            .from(plannedQueryRows)
            .where(
                and(
                    eq(plannedQueryRows.organizationId, args.organizationId),
                    eq(plannedQueryRows.channelId, args.channelId)
                )
            )
            .orderBy(desc(plannedQueryRows.id))
            .limit(args.limit),
});

const driftedManifest = manifestFromExports({ driftedPlannedQueryRows });
const app = chardb({
    ownership: "organization",
    auth,
    schema: { plannedQueryRows },
    api: { listPlannedQueryRows },
});

export class Catalog extends app.Catalog {
    seedJwkForTest(jwksUrl: string, kid: string, jwkJson: string, ttlMs: number): void {
        const now = Date.now();
        const cursor = this.ctx.storage.sql.exec(
            `INSERT INTO catalog_jwks_v2
             (jwks_url, kid, jwk_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(jwks_url, kid) DO UPDATE SET
               jwk_json = excluded.jwk_json,
               fetched_at = excluded.fetched_at,
               expires_at = excluded.expires_at`,
            jwksUrl,
            kid,
            jwkJson,
            now,
            now + ttlMs
        );
        for (const _ of cursor.raw()) {
            // Drain the write cursor.
        }
    }
}

export class Gateway extends app.Gateway {}

export const DB = app.DB;

export class Cdb extends app.Cdb {
    private planDrift = false;

    protected override mutationManifest(): ChardbManifest {
        return this.planDrift ? driftedManifest : super.mutationManifest();
    }

    fixtureSeedRows(): void {
        const cursor = this.ctx.storage.sql.exec(
            `INSERT INTO planned_query_workerd_rows (id, organization_id, channel_id, created_at)
             VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
            "row-01",
            ORGANIZATION_ID,
            "general",
            1,
            "row-02",
            ORGANIZATION_ID,
            "general",
            2,
            "row-other-channel",
            ORGANIZATION_ID,
            "random",
            3
        );
        for (const _ of cursor.raw()) {
            // Drain the write cursor.
        }
    }

    fixtureSetPlanDrift(enabled: boolean): void {
        this.planDrift = enabled;
    }

    fixtureSeedBenchmark(organizationIds: readonly string[], channelCount: number, rowsPerChannel: number): void {
        if (
            organizationIds.length !== 2 ||
            organizationIds.some(organizationId => typeof organizationId !== "string" || organizationId.length === 0) ||
            !Number.isSafeInteger(channelCount) ||
            channelCount < 1 ||
            channelCount > 64 ||
            !Number.isSafeInteger(rowsPerChannel) ||
            rowsPerChannel < 1 ||
            rowsPerChannel > 500
        ) {
            throw new TypeError("planned query benchmark seed is outside its bounded fixture limits");
        }
        this.ctx.storage.transactionSync(() => {
            for (const [organizationIndex, organizationId] of organizationIds.entries()) {
                const organizationSuffix = organizationIndex === 0 ? "a" : "b";
                for (let channel = 1; channel <= channelCount; channel++) {
                    const channelId = `bench-channel-${String(channel).padStart(2, "0")}`;
                    for (let row = 1; row <= rowsPerChannel; row++) {
                        const cursor = this.ctx.storage.sql.exec(
                            `INSERT INTO planned_query_workerd_rows (id, organization_id, channel_id, created_at)
                             VALUES (?, ?, ?, ?)
                             ON CONFLICT(id) DO UPDATE SET
                               organization_id = excluded.organization_id,
                               channel_id = excluded.channel_id,
                               created_at = excluded.created_at`,
                            `bench-${organizationSuffix}-${String(channel).padStart(2, "0")}-${String(row).padStart(4, "0")}`,
                            organizationId,
                            channelId,
                            row
                        );
                        for (const _ of cursor.raw()) {
                            // Drain each fixture write cursor inside the transaction.
                        }
                    }
                }
            }
        });
    }
}

export class Resharder extends app.Resharder {}

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
}

interface PlannedQueryExecutionContext extends ExecutionContext {
    readonly exports: { readonly DB: ChardbBinding };
}

export default {
    async fetch(request: Request, env: Env, ctx: PlannedQueryExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/seed") {
            const body = (await request.json()) as { readonly kid: string; readonly jwk: JsonWebKey };
            const catalogId = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(catalogId) as unknown as {
                seedJwkForTest(jwksUrl: string, kid: string, jwkJson: string, ttlMs: number): Promise<void>;
                mutateAuth(
                    args: {
                        readonly model: string;
                        readonly op: "create";
                        readonly payload: Record<string, unknown>;
                    },
                    _recoveryGeneration: number
                ): Promise<unknown>;
                route(vshard: number): Promise<{ readonly shardId: string }>;
            };
            await catalog.seedJwkForTest(JWKS_URL, body.kid, JSON.stringify(body.jwk), 60_000);
            const now = Date.parse("2026-08-25T00:00:00Z");
            await catalog.mutateAuth(
                {
                    model: "user",
                    op: "create",
                    payload: {
                        id: USER_ID,
                        name: "Planned Query User",
                        email: "planned-query@example.com",
                        emailVerified: true,
                        createdAt: now,
                        updatedAt: now,
                    },
                },
                0
            );
            for (const [id, slug] of [
                [ORGANIZATION_ID, "planned-query-org"],
                [OTHER_ORGANIZATION_ID, "planned-query-org-other"],
            ] as const) {
                await catalog.mutateAuth(
                    {
                        model: "organization",
                        op: "create",
                        payload: { id, name: id, slug, createdAt: now },
                    },
                    0
                );
            }
            await catalog.mutateAuth(
                {
                    model: "member",
                    op: "create",
                    payload: {
                        id: "planned-query-member",
                        organizationId: ORGANIZATION_ID,
                        userId: USER_ID,
                        role: "member",
                        createdAt: now,
                    },
                },
                0
            );
            const route = await catalog.route(Number(vshardOf([ORGANIZATION_ID])));
            const cdbId = env.CDB_SHARD.idFromName(route.shardId);
            const cdb = env.CDB_SHARD.get(cdbId) as unknown as { fixtureSeedRows(): Promise<void> };
            await cdb.fixtureSeedRows();
            return Response.json({ queryRef: listPlannedQueryRows.__chardbRef, shardId: route.shardId });
        }
        if (url.pathname === "/plan-drift") {
            const body = (await request.json()) as { readonly shardId: string; readonly enabled: boolean };
            const cdbId = env.CDB_SHARD.idFromName(body.shardId);
            const cdb = env.CDB_SHARD.get(cdbId) as unknown as {
                fixtureSetPlanDrift(enabled: boolean): Promise<void>;
            };
            await cdb.fixtureSetPlanDrift(body.enabled);
            return Response.json({ ok: true });
        }
        if (url.pathname === "/seed-benchmark") {
            const body = (await request.json()) as {
                readonly shardId: string;
                readonly organizationIds: readonly string[];
                readonly channelCount: number;
                readonly rowsPerChannel: number;
            };
            const cdbId = env.CDB_SHARD.idFromName(body.shardId);
            const cdb = env.CDB_SHARD.get(cdbId) as unknown as {
                fixtureSeedBenchmark(
                    organizationIds: readonly string[],
                    channelCount: number,
                    rowsPerChannel: number
                ): Promise<void>;
            };
            await cdb.fixtureSeedBenchmark(body.organizationIds, body.channelCount, body.rowsPerChannel);
            return Response.json({
                ok: true,
                rows: body.organizationIds.length * body.channelCount * body.rowsPerChannel,
            });
        }
        if (url.pathname === "/authorize-benchmark-other-organization") {
            const catalogId = env.CDB_CATALOG.idFromName("global");
            const catalog = env.CDB_CATALOG.get(catalogId) as unknown as {
                mutateAuth(
                    args: {
                        readonly model: string;
                        readonly op: "create";
                        readonly payload: Record<string, unknown>;
                    },
                    _recoveryGeneration: number
                ): Promise<unknown>;
                route(vshard: number): Promise<{ readonly shardId: string }>;
            };
            const now = Date.parse("2026-08-25T00:00:00Z");
            await catalog.mutateAuth(
                {
                    model: "user",
                    op: "create",
                    payload: {
                        id: OTHER_USER_ID,
                        name: "Other Planned Query User",
                        email: "planned-query-other@example.com",
                        emailVerified: true,
                        createdAt: now,
                        updatedAt: now,
                    },
                },
                0
            );
            await catalog.mutateAuth(
                {
                    model: "member",
                    op: "create",
                    payload: {
                        id: "planned-query-member-other",
                        organizationId: OTHER_ORGANIZATION_ID,
                        userId: OTHER_USER_ID,
                        role: "member",
                        createdAt: now,
                    },
                },
                0
            );
            return Response.json(await catalog.route(Number(vshardOf([OTHER_ORGANIZATION_ID]))));
        }
        if (url.pathname === "/binding-select") {
            const body = (await request.json()) as {
                readonly jwt: string;
                readonly organizationId: string;
                readonly channelId: string;
                readonly limit?: number;
                readonly id?: string;
            };
            const db = client(ctx.exports.DB, { jwt: body.jwt, authOrigin: url.origin });
            const predicates = [
                eq(plannedQueryRows.organizationId, body.organizationId),
                eq(plannedQueryRows.channelId, body.channelId),
                ...(body.id === undefined ? [] : [eq(plannedQueryRows.id, body.id)]),
            ];
            const predicate = and(...predicates);
            if (!predicate) throw new TypeError("binding select predicate is empty");
            const query = db.select().from(plannedQueryRows).where(predicate).orderBy(plannedQueryRows.id);
            if (body.id !== undefined) return Response.json((await query.get()) ?? null);
            return Response.json(await query.limit(body.limit ?? 100));
        }
        if (url.pathname === "/binding-cross-partition") {
            const body = (await request.json()) as {
                readonly jwt: string;
                readonly organizationIds: readonly string[];
            };
            const rows = await client(ctx.exports.DB, { jwt: body.jwt, authOrigin: url.origin })
                .select()
                .from(plannedQueryRows)
                .where(inArray(plannedQueryRows.organizationId, body.organizationIds))
                .limit(100);
            return Response.json(rows);
        }
        if (url.pathname === "/ws") {
            const clientId = url.searchParams.get("clientId") ?? "missing-client";
            const gatewayId = env.CDB_GATEWAY.idFromName(gatewayBucketName(clientId));
            return env.CDB_GATEWAY.get(gatewayId).fetch(request);
        }
        return new Response("not found", { status: 404 });
    },
};
