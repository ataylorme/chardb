import { describe, expect, test } from "bun:test";
import { sourceChardbEnv, withChardbLoopbacks } from "../../src/server/loopback.ts";

function namespace(label: string): DurableObjectNamespace {
    return {
        get() {
            return { label };
        },
        idFromName(name: string) {
            return { name };
        },
        idFromString(id: string) {
            return { id };
        },
    } as unknown as DurableObjectNamespace;
}

function callableNamespace(label: string): DurableObjectNamespace {
    const binding = Object.assign(() => binding, namespace(label));
    return binding as unknown as DurableObjectNamespace;
}

describe("native loopback binding resolution", () => {
    test("maps the native DB service entrypoint onto the application environment", () => {
        const db = { async executeQuery() {}, async executeMutation() {} };
        const resolved = withChardbLoopbacks({}, { exports: { DB: db } });
        expect((resolved as { readonly DB?: unknown }).DB).toBe(db);
    });

    test("keeps an explicit split-Worker DB service binding", () => {
        const explicit = { async executeQuery() {}, async executeMutation() {} };
        const loopback = { async executeQuery() {}, async executeMutation() {} };
        const resolved = withChardbLoopbacks({ DB: explicit }, { exports: { DB: loopback } });
        expect(resolved.DB).toBe(explicit);
    });

    test("maps exported class names onto CharDB's internal environment", () => {
        const rawEnv = { APP_SETTING: "kept" };
        const catalog = namespace("catalog");
        const cdb = namespace("cdb");
        const gateway = namespace("gateway");
        const resharder = namespace("resharder");

        const resolved = withChardbLoopbacks(rawEnv, {
            exports: { Catalog: catalog, Cdb: cdb, Gateway: gateway, Resharder: resharder },
        }) as typeof rawEnv & {
            CDB_CATALOG: DurableObjectNamespace;
            CDB_SHARD: DurableObjectNamespace;
            CDB_GATEWAY: DurableObjectNamespace;
            CDB_RESHARD: DurableObjectNamespace;
        };

        expect(resolved).not.toBe(rawEnv);
        expect(resolved.APP_SETTING).toBe("kept");
        expect(resolved.CDB_CATALOG).toBe(catalog);
        expect(resolved.CDB_SHARD).toBe(cdb);
        expect(resolved.CDB_GATEWAY).toBe(gateway);
        expect(resolved.CDB_RESHARD).toBe(resharder);
        expect(sourceChardbEnv(resolved)).toBe(rawEnv);
    });

    test("accepts Wrangler's callable ctx.exports namespaces", () => {
        const catalog = callableNamespace("wrangler-catalog");

        const resolved = withChardbLoopbacks({}, { exports: { Catalog: catalog } });

        expect((resolved as Record<string, unknown>).CDB_CATALOG).toBe(catalog);
    });

    test("keeps explicit Wrangler bindings for split-Worker deployments", () => {
        const explicit = namespace("explicit");
        const loopback = namespace("loopback");
        const rawEnv = { CDB_CATALOG: explicit };

        const resolved = withChardbLoopbacks(rawEnv, { exports: { Catalog: loopback } });

        expect(resolved).toBe(rawEnv);
        expect(resolved.CDB_CATALOG).toBe(explicit);
        expect(sourceChardbEnv(resolved)).toBe(rawEnv);
    });

    test("accepts Miniflare's exported-name Durable Object bindings", () => {
        const catalog = namespace("miniflare-catalog");
        const cdb = namespace("miniflare-cdb");
        const rawEnv = { Catalog: catalog, Cdb: cdb };

        const resolved = withChardbLoopbacks(rawEnv, { exports: {} });

        expect((resolved as Record<string, unknown>).CDB_CATALOG).toBe(catalog);
        expect((resolved as Record<string, unknown>).CDB_SHARD).toBe(cdb);
        expect(sourceChardbEnv(resolved)).toBe(rawEnv);
    });

    test("ignores non-namespace named exports", () => {
        const rawEnv = {};
        const resolved = withChardbLoopbacks(rawEnv, {
            exports: { Catalog: { fetch: () => new Response() } },
        });

        expect(resolved).toBe(rawEnv);
    });

    test("only synthesizes the supported internal Durable Object classes", () => {
        const rawEnv = {};
        const resolved = withChardbLoopbacks(rawEnv, {
            exports: {
                BlobMeta: namespace("blobmeta"),
                Resharder: namespace("resharder"),
                GsiShard: namespace("gsi"),
            },
        });

        expect(resolved).not.toBe(rawEnv);
        expect(resolved).not.toHaveProperty("CDB_BLOBMETA");
        expect(resolved).toHaveProperty("CDB_RESHARD");
        expect(resolved).not.toHaveProperty("CDB_RESHARDER");
        expect(resolved).not.toHaveProperty("CDB_GSI");
    });
});
