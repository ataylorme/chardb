import { describe, expect, test } from "bun:test";
import { CHARDB_BINDING_MAX_IN_FLIGHT, type ChardbBinding, client } from "../src/binding.ts";
import { CdbError } from "../src/errors.ts";
import { defineMutation, defineQuery } from "../src/server/define.ts";

const query = defineQuery<unknown, { organizationId: string }, { count: number }>({
    ref: "queries.ts#countMessages",
    handler: async () => ({ count: 3 }),
});
const mutation = defineMutation<unknown, { organizationId: string; body: string }, { id: string }>({
    ref: "api.ts#postMessage",
    authority: "organization",
    partitionKey: "organizationId",
    handler: () => ({ id: "message-1" }),
});

describe("typed DB binding client", () => {
    test("sends stable refs and auth while returning inferred handler results", async () => {
        const calls: unknown[] = [];
        const binding: ChardbBinding = {
            async executeQuery(request) {
                calls.push(request);
                return { ok: true, result: { count: 3 } };
            },
            async executeMutation(request) {
                calls.push(request);
                return { ok: true, cookie: "cookie-1", ran: true, result: { id: "message-1" }, rowsAffected: 1 };
            },
        };
        const db = client(binding, { jwt: "signed-token", authOrigin: "https://app.example.com" });

        const queryResult: { count: number } = await db.query(query, { organizationId: "org-1" });
        const mutationResult: { id: string } = await db.mutate(
            mutation,
            { organizationId: "org-1", body: "hello" },
            { mutId: "request-7" }
        );

        expect(queryResult).toEqual({ count: 3 });
        expect(mutationResult).toEqual({ id: "message-1" });
        expect(calls).toEqual([
            {
                jwt: "signed-token",
                authOrigin: "https://app.example.com",
                ref: "queries.ts#countMessages",
                args: { organizationId: "org-1" },
            },
            {
                jwt: "signed-token",
                authOrigin: "https://app.example.com",
                ref: "api.ts#postMessage",
                args: { organizationId: "org-1", body: "hello" },
                mutId: "request-7",
            },
        ]);
    });

    test("generates a mutation id and reconstructs typed binding failures", async () => {
        let generated = "";
        const binding: ChardbBinding = {
            async executeQuery() {
                return {
                    ok: false,
                    error: new CdbError({ code: "CDB_FORBIDDEN", message: "membership revoked" }).toJSON(),
                };
            },
            async executeMutation(request) {
                generated = request.mutId;
                return { ok: true, cookie: "cookie-1", ran: true, result: { id: "message-1" }, rowsAffected: 1 };
            },
        };
        const db = client(binding, { jwt: "signed-token", authOrigin: "https://app.example.com" });
        await db.mutate(mutation, { organizationId: "org-1", body: "hello" });
        expect(generated).toMatch(/^[0-9a-f-]{36}$/);
        await expect(db.query(query, { organizationId: "org-1" })).rejects.toMatchObject({
            name: "CdbError",
            code: "CDB_FORBIDDEN",
            retryable: false,
            message: "membership revoked",
        });
    });

    test("rejects the wrong handle kind before RPC", async () => {
        let calls = 0;
        const binding: ChardbBinding = {
            async executeQuery() {
                calls++;
                return { ok: true, result: null };
            },
            async executeMutation() {
                calls++;
                return { ok: true, cookie: "cookie", ran: true, result: null, rowsAffected: 0 };
            },
        };
        const db = client(binding, { jwt: "signed-token", authOrigin: "https://app.example.com" });
        await expect(db.query(mutation as never, { organizationId: "org-1" } as never)).rejects.toBeInstanceOf(
            TypeError
        );
        expect(calls).toBe(0);
    });

    test("bounds concurrent operations and releases every settled slot", async () => {
        const releases: (() => void)[] = [];
        let hold = true;
        const binding: ChardbBinding = {
            executeQuery() {
                if (!hold) return Promise.resolve({ ok: true, result: { count: 3 } });
                return new Promise(resolve => {
                    releases.push(() => resolve({ ok: true, result: { count: 3 } }));
                });
            },
            async executeMutation() {
                return { ok: true, cookie: "cookie", ran: true, result: null, rowsAffected: 0 };
            },
        };
        const db = client(binding, { jwt: "signed-token", authOrigin: "https://app.example.com" });
        const admitted = Array.from({ length: CHARDB_BINDING_MAX_IN_FLIGHT }, () =>
            db.query(query, { organizationId: "org-1" })
        );
        await expect(db.query(query, { organizationId: "org-1" })).rejects.toMatchObject({
            code: "CDB_RATE_LIMITED",
            retryable: true,
        });
        expect(releases).toHaveLength(CHARDB_BINDING_MAX_IN_FLIGHT);
        for (const release of releases) release();
        await expect(Promise.all(admitted)).resolves.toHaveLength(CHARDB_BINDING_MAX_IN_FLIGHT);
        hold = false;
        await expect(db.query(query, { organizationId: "org-1" })).resolves.toEqual({ count: 3 });
    });

    test("owns arguments before RPC and rejects malformed success envelopes", async () => {
        let observed: unknown;
        let release!: () => void;
        const held = new Promise<void>(resolve => {
            release = resolve;
        });
        const binding: ChardbBinding = {
            async executeQuery(request) {
                await held;
                observed = request.args;
                return { ok: true, result: { count: 3 } };
            },
            async executeMutation() {
                return { ok: true, cookie: "cookie", ran: true, result: null, rowsAffected: 0 };
            },
        };
        const db = client(binding, { jwt: "signed-token", authOrigin: "https://app.example.com" });
        const args = { organizationId: "org-1" };
        const pending = db.query(query, args);
        args.organizationId = "org-forged";
        release();
        await expect(pending).resolves.toEqual({ count: 3 });
        expect(observed).toEqual({ organizationId: "org-1" });

        const malformed = client(
            {
                async executeQuery() {
                    return { ok: true } as never;
                },
                async executeMutation() {
                    return { ok: true, cookie: "", ran: true, result: null, rowsAffected: -1 } as never;
                },
            },
            { jwt: "signed-token", authOrigin: "https://app.example.com" }
        );
        await expect(malformed.query(query, { organizationId: "org-1" })).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
        await expect(malformed.mutate(mutation, { organizationId: "org-1", body: "hello" })).rejects.toMatchObject({
            code: "CDB_INVARIANT",
        });
    });
});
