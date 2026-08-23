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
import { defineAuth } from "../../src/auth/synthesize.ts";
import { chardb } from "../../src/server/chardb.ts";
import { Cdb } from "../../src/server/do/cdb.ts";

const items = sqliteTable("items", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
});

const auth = defineAuth({
    appName: "chardb-factory-test",
    plugins: [organization()],
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

    test("the six Durable Object classes are direct fields", () => {
        const app = chardb({ auth, schema: { items } });
        // Existence + identity — these are the named exports wrangler binds.
        expect(typeof app.Cdb).toBe("function");
        expect(app.Cdb).not.toBe(Cdb);
        expect(typeof app.Catalog).toBe("function");
        expect(typeof app.Gateway).toBe("function");
        expect(typeof app.BlobMeta).toBe("function");
        expect(typeof app.Resharder).toBe("function");
        expect(typeof app.GsiShard).toBe("function");
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
