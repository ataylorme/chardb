/**
 * Coverage for the `chardb({…})` mega-factory.
 *
 * The factory is the wrangler-ready worker entry: one call composes a
 * pre-built `defineAuth(...)` value (or inline `plugins`/`options`),
 * the user's Drizzle schema, the API refs, a Hono router, and the
 * `mountChardb` reserved-prefix handler. The shape it returns is a
 * Hono instance augmented with the six chardb Durable Object classes,
 * a lazy merged `.schema`, the `auth` value, and a chardb-mounted
 * `.fetch`.
 *
 * These tests pin the wire contract: which routes go where, that
 * Hono chaining keeps working after construction, that the DO classes
 * are present as direct fields, and that `.schema` is lazy enough to
 * survive an ESM-cycle-style namespace.
 */

import { describe, expect, test } from "bun:test";
import { organization } from "better-auth/plugins/organization";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { defineAuth } from "../../src/auth/synthesize.ts";
import { cdbPolicyDigest } from "../../src/server/cdb-policy.ts";
import { forOrg } from "../../src/server/cdb-tenant.ts";
import { chardb } from "../../src/server/chardb.ts";
import { defineMutation, defineQuery } from "../../src/server/define.ts";
import { Cdb } from "../../src/server/do/cdb.ts";
import { Gateway } from "../../src/server/do/gateway.ts";
import type { RawJson } from "../../src/types.ts";
import { stableJson } from "../../src/util/canonical.ts";
import { vshardOf } from "../../src/vshard.ts";

const organizationTable = sqliteTable("organization", { id: text("id").primaryKey() });
const { cdbTable } = forOrg();
const items = cdbTable(
    "items",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organizationTable.id),
        name: text("name").notNull(),
    },
    { roles: { member: { read: "*" } } }
);

const auth = defineAuth({
    appName: "chardb-factory-test",
    plugins: [organization()],
});

type RoutedArgs = { readonly organizationId: string } & { readonly [key: string]: RawJson };
type RoutedQueryArgs = { readonly organizationId: string; readonly limit: number };
const routedMutation = defineMutation<unknown, RoutedArgs, null>(() => null, {
    ref: "api/items#route",
    authority: "organization",
    singlePartition: true,
    partitionKey: args => args.organizationId,
});
const routedQuery = defineQuery<unknown, RoutedQueryArgs, readonly []>({
    ref: "api/items#list",
    args: z.object({ organizationId: z.string(), limit: z.number().int().default(25) }),
    authority: "organization",
    partitionKey: "organizationId",
    handler: async () => [],
    intent: args => ({
        kind: "select",
        tables: ["items"],
        partitionKey: { table: "items", column: "organization_id", values: [args.organizationId] },
        joinShape: "colocated",
    }),
});
const queryWithoutIntent = defineQuery<unknown, RoutedArgs, readonly []>(async (): Promise<readonly []> => []);
const queryWithNonJsonTransform = defineQuery({
    args: z.object({ organizationId: z.string(), at: z.string().transform(() => new Date(0)) }),
    handler: async () => [],
    intent: args => ({
        kind: "select",
        tables: ["items"],
        partitionKey: { table: "items", column: "organization_id", values: [args.organizationId] },
    }),
});

describe("chardb({…})", () => {
    test("returns a Hono instance the user can chain routes on", async () => {
        const app = chardb({ auth, schema: { items } });
        app.get("/hello", c => c.text("world"));
        const res = await app.fetch(
            new Request("https://example.com/hello"),
            {} as Parameters<typeof app.fetch>[1],
            { waitUntil() {}, passThroughOnException() {}, props: undefined } as Parameters<typeof app.fetch>[2]
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("world");
    });

    test("the six Durable Object classes are direct fields and runtime classes are configured", () => {
        const app = chardb({ auth, schema: { items } });
        // Existence + identity — these are the named exports wrangler binds.
        expect(typeof app.Cdb).toBe("function");
        expect(app.Cdb).not.toBe(Cdb);
        expect(typeof app.Catalog).toBe("function");
        expect(typeof app.Gateway).toBe("function");
        expect(app.Gateway).not.toBe(Gateway);
        expect(typeof app.BlobMeta).toBe("function");
        expect(typeof app.Resharder).toBe("function");
        expect(typeof app.GsiShard).toBe("function");
    });

    test("the configured Gateway resolves mutation refs from the factory api manifest", () => {
        const app = chardb({ auth, schema: { items }, api: { routedMutation } });
        const gateway = Object.create(app.Gateway.prototype) as InstanceType<typeof app.Gateway>;
        expect(
            gateway.routeMutation({
                ref: routedMutation.__chardbRef,
                args: { organizationId: "org-7" },
            })
        ).toEqual({
            ok: true,
            vshard: Number(vshardOf(["org-7"])),
            authority: "organization",
            partitionKey: "org-7",
            args: { organizationId: "org-7" },
        });
        const missing = gateway.routeMutation({ ref: "api.ts#missing", args: {} });
        expect(missing.ok).toBe(false);
        if (!missing.ok) expect(missing.error.code).toBe("CDB_REF_NOT_FOUND");
    });

    test("the configured Gateway validates args, derives query intent, and fails closed without an extractor", async () => {
        const app = chardb({ auth, schema: { items }, api: { routedQuery, queryWithoutIntent } });
        const gateway = Object.create(app.Gateway.prototype) as InstanceType<typeof app.Gateway>;
        const routed = await gateway.routeQuery({ ref: routedQuery.__chardbRef, args: { organizationId: "org-7" } });
        expect(routed.ok).toBe(true);
        if (!routed.ok) throw new Error("expected query routing to succeed");
        expect(routed.intent).toEqual({
            kind: "select",
            tables: ["items"],
            partitionKey: { table: "items", column: "organization_id", values: ["org-7"] },
            joinShape: "colocated",
        });
        expect(routed.args).toEqual({ organizationId: "org-7", limit: 25 });
        expect(routed.authority).toBe("organization");
        expect(routed.partitionKey).toBe("org-7");
        const policyDigest = cdbPolicyDigest({ items }, routed.intent.tables);
        expect(routed.policyDigest).toBe(policyDigest);
        expect(routed.queryHash).toBe(
            stableJson({ ref: routedQuery.__chardbRef, args: routed.args, intent: routed.intent, policyDigest })
        );

        const invalid = await gateway.routeQuery({ ref: routedQuery.__chardbRef, args: { organizationId: 7 } });
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) expect(invalid.error.code).toBe("CDB_INVALID_ARGS");

        const closed = await gateway.routeQuery({
            ref: queryWithoutIntent.__chardbRef,
            args: { organizationId: "org-7" },
        });
        expect(closed.ok).toBe(false);
        if (!closed.ok) expect(closed.error.code).toBe("CDB_NO_INTENT_FOR_RAW_SQL");
    });

    test("query routing rejects non-JSON validator transforms", async () => {
        const app = chardb({ auth, schema: { items }, api: { queryWithNonJsonTransform } });
        const gateway = Object.create(app.Gateway.prototype) as InstanceType<typeof app.Gateway>;
        const result = await gateway.routeQuery({
            ref: queryWithNonJsonTransform.__chardbRef,
            args: { organizationId: "org-7", at: "now" },
        });
        expect(result).toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS" } });
    });

    test("`auth` is the pre-built bundle when supplied", () => {
        const app = chardb({ auth, schema: { items } });
        expect(app.auth).toBe(auth);
        expect(app.auth.user).toBeDefined();
        expect(app.auth.organization).toBeDefined();
    });

    test("inline `auth: { plugins, appName }` builds the bundle without a separate defineAuth call", () => {
        const app = chardb({
            auth: { appName: "inline-app", plugins: [organization()] },
            schema: { items },
        });
        expect(app.auth.options.appName).toBe("inline-app");
        expect(app.auth.user).toBeDefined();
        expect(app.auth.organization).toBeDefined();
    });

    test("`.schema` is a lazy getter (no eager spread of the schema namespace)", () => {
        let accessCount = 0;
        // Mimic an ESM-cycle namespace where touching the proxy counts.
        const schema = new Proxy(
            { items },
            {
                get(target, key) {
                    accessCount++;
                    return Reflect.get(target, key);
                },
                ownKeys(target) {
                    accessCount++;
                    return Reflect.ownKeys(target);
                },
                getOwnPropertyDescriptor(target, key) {
                    accessCount++;
                    return Reflect.getOwnPropertyDescriptor(target, key);
                },
            }
        );
        const app = chardb({ auth, schema });
        // Constructing the factory must NOT iterate the schema namespace —
        // the merge with auth tables is deferred to first `.schema` read.
        expect(accessCount).toBe(0);
        void app.schema;
        expect(accessCount).toBeGreaterThan(0);
    });

    test(".schema merges synthesized auth tables with the domain namespace", () => {
        const app = chardb({ auth, schema: { items } });
        const schema = app.schema as Record<string, unknown>;
        expect(schema.items).toBe(items);
        expect(schema.user).toBeDefined();
        expect(schema.organization).toBeDefined();
    });
});
