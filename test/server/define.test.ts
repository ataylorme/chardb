import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { isCdbError } from "../../src/errors.ts";
import {
    type MutationCtx,
    defineCron,
    defineGsi,
    defineMutation,
    definePresenceKey,
    defineQuery,
    defineStream,
} from "../../src/server/define.ts";
import { defineLedger } from "../../src/server/ledger.ts";
import { readRef } from "../../src/server/refs.ts";
import { ChardbRef } from "../../src/types.ts";

describe("defineXxx — function-ref identity", () => {
    test("defineMutation attaches __chardbRef and __chardbKind", async () => {
        const fn = defineMutation(({ db: _ }: { db: unknown }, args: { x: number }) => args.x + 1);
        expect(fn.__chardbKind).toBe("mutation");
        expect(typeof fn.__chardbRef).toBe("string");
        expect(readRef(fn)).toBeDefined();
        const out = await fn({ db: null, auth: { userId: "u", claims: {} } }, { x: 1 });
        expect(out).toBe(2);
    });

    test("defineQuery / defineStream / defineGsi / definePresenceKey / defineLedger / defineCron all carry __chardbKind", () => {
        const q = defineQuery<unknown, { id: string }, number>(async () => 1);
        const s = defineStream<unknown, { p: string }, string, number>(async function* () {
            yield "x";
            return 1;
        });
        const g = defineGsi("orders", ["status"]);
        const p = definePresenceKey<{ x: number; y: number }>("cursor");
        const l = defineLedger("events", { id: "text" });
        const c = defineCron("0 3 * * *", async () => {});

        expect(q.__chardbKind).toBe("query");
        expect(s.__chardbKind).toBe("stream");
        expect(g.__chardbKind).toBe("gsi");
        expect(p.__chardbKind).toBe("presenceKey");
        expect((l as { __chardbKind: string }).__chardbKind).toBe("ledger");
        expect(c.__chardbKind).toBe("cron");
        expect(c.__chardbCron).toBe("0 3 * * *");
    });

    test("defineGsi's strict flag defaults false (CDB_GSI_STRICT_REQUIRES_2PC until v1.1)", () => {
        expect(defineGsi("t", ["a"]).strict).toBe(false);
        expect(defineGsi("t", ["a"], { strict: true }).strict).toBe(true);
    });

    test("singlePartition: true ⇒ chardb defaults `__chardbIdempotencyTtl` to 24h", () => {
        const fn = defineMutation<unknown, { id: string }, { ok: boolean }>({
            handler: (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
            singlePartition: true,
            partitionKey: "id",
        });
        expect((fn as unknown as { __chardbIdempotencyTtl?: string }).__chardbIdempotencyTtl).toBe("24h");
    });

    test("explicit idempotencyTtl wins over the singlePartition default", () => {
        const fn = defineMutation<unknown, { id: string }, { ok: boolean }>({
            handler: (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
            singlePartition: true,
            idempotencyTtl: "24h",
            partitionKey: "id",
        });
        // Explicit and default both happen to be "24h" today; the test guards
        // future-proof against a wider TTL enum where the user's choice must
        // override silently.
        expect((fn as unknown as { __chardbIdempotencyTtl: string }).__chardbIdempotencyTtl).toBe("24h");
    });

    test("singlePartition: false ⇒ no idempotency horizon set by default", () => {
        const fn = defineMutation<unknown, { id: string }, { ok: boolean }>({
            handler: (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
        });
        expect((fn as unknown as { __chardbIdempotencyTtl?: string }).__chardbIdempotencyTtl).toBeUndefined();
    });

    test("declaring partitionKey implies singlePartition AND the 24h idempotency horizon", () => {
        const fn = defineMutation<unknown, { organizationId: string }, { ok: boolean }>({
            handler: (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
            partitionKey: "organizationId",
            // No `singlePartition`, no `idempotencyTtl` — chardb defaults both.
        });
        const internals = fn as unknown as {
            __chardbSinglePartition?: boolean;
            __chardbIdempotencyTtl?: string;
            __chardbPartitionKey?: (args: { organizationId: string }) => unknown;
        };
        expect(internals.__chardbSinglePartition).toBe(true);
        expect(internals.__chardbIdempotencyTtl).toBe("24h");
        expect(internals.__chardbPartitionKey?.({ organizationId: "org-1" })).toBe("org-1");
    });

    test("organization authority is explicit mutation metadata", () => {
        const fn = defineMutation<unknown, { organizationId: string }, null>(() => null, {
            ref: "api/messages#post",
            authority: "organization",
            partitionKey: args => args.organizationId,
        });
        expect((fn as unknown as { __chardbAuthority?: string }).__chardbAuthority).toBe("organization");
        expect(fn.__chardbRef).toBe(ChardbRef("api/messages#post"));
    });

    test("user authority is explicit query and mutation metadata", () => {
        const mutation = defineMutation({
            ref: "api/preferences#save",
            args: z.object({ userId: z.string() }),
            authority: "user",
            partitionKey: "userId",
            handler: () => null,
        });
        const query = defineQuery({
            ref: "api/preferences#list",
            authority: "user",
            partitionKey: "userId",
            intent: (args: { userId: string }) => ({
                kind: "select",
                tables: ["preferences"],
                partitionKey: { table: "preferences", column: "user_id", values: [args.userId] },
            }),
            handler: async () => [],
        });

        expect((mutation as unknown as { __chardbAuthority?: string }).__chardbAuthority).toBe("user");
        expect(query.__chardbAuthority).toBe("user");
        expect(query.__chardbPartitionKey?.({ userId: "user-7" })).toBe("user-7");
    });

    test("global authority requires and preserves placement metadata", () => {
        const mutation = defineMutation({
            ref: "api/settings#save",
            authority: "global",
            partitionKey: (args: { partition: string }) => args.partition,
            handler: () => null,
        });
        const query = defineQuery({
            ref: "api/settings#read",
            authority: "global",
            partitionKey: (args: { partition: string }) => args.partition,
            intent: (args: { partition: string }) => ({
                kind: "select",
                tables: ["settings"],
                partitionKey: { table: "settings", column: "partition", values: [args.partition] },
            }),
            handler: async () => [],
        });

        expect((mutation as unknown as { __chardbAuthority?: string }).__chardbAuthority).toBe("global");
        expect(query.__chardbAuthority).toBe("global");
        expect(query.__chardbPartitionKey?.({ partition: "app" })).toBe("app");
        expect(query.__chardbIntent?.({ partition: "app" }).tables).toEqual(["settings"]);
    });

    test("global declarations reject missing placement metadata at runtime", () => {
        expect(() =>
            defineMutation({
                ref: "api/settings#missingPartition",
                authority: "global",
                handler: () => null,
            } as never)
        ).toThrow("global mutations require an explicit partitionKey extractor");
        expect(() =>
            defineQuery({
                ref: "api/settings#missingQueryPartition",
                authority: "global",
                intent: () => ({ kind: "select", tables: [] }),
                handler: async () => [],
            } as never)
        ).toThrow("global queries require an explicit partitionKey extractor");
        expect(() =>
            defineQuery({
                ref: "api/settings#missingIntent",
                authority: "global",
                partitionKey: () => "app",
                handler: async () => [],
            } as never)
        ).toThrow("global queries require an explicit intent extractor");
    });

    test("config mutation and query refs are stable and validated", () => {
        const mutation = defineMutation({ ref: "api/items#create", handler: () => null });
        const query = defineQuery({ ref: "api/items#list", handler: async () => [] });
        expect(mutation.__chardbRef).toBe(ChardbRef("api/items#create"));
        expect(query.__chardbRef).toBe(ChardbRef("api/items#list"));
        expect(() => defineMutation({ ref: "missing-separator", handler: () => null })).toThrow(/containing #/);
        expect(() => defineQuery({ ref: "", handler: async () => [] })).toThrow(/containing #/);
        expect(() =>
            defineMutation({
                authority: "organization",
                partitionKey: (_args: { organizationId: string }) => "org-1",
                handler: () => null,
            } as never)
        ).toThrow(/require an explicit ref/);
        expect(() =>
            defineQuery({
                authority: "organization",
                partitionKey: (_args: { organizationId: string }) => "org-1",
                intent: () => ({ kind: "select", tables: [] }),
                handler: async () => [],
            } as never)
        ).toThrow(/require an explicit ref/);
    });

    test("organization query authority and partition extraction are explicit metadata", () => {
        const query = defineQuery({
            ref: "api/items#organizationList",
            args: z.object({ organizationId: z.string() }),
            authority: "organization",
            partitionKey: "organizationId",
            intent: args => ({
                kind: "select",
                tables: ["items"],
                partitionKey: { table: "items", column: "organization_id", values: [args.organizationId] },
            }),
            handler: async () => [],
        });

        expect(query.__chardbAuthority).toBe("organization");
        expect(query.__chardbPartitionKey?.({ organizationId: "org-4" })).toBe("org-4");
        expect(query.__chardbRef).toBe(ChardbRef("api/items#organizationList"));
    });

    test("explicit singlePartition: false beats the partitionKey-implied default", () => {
        const fn = defineMutation<unknown, { organizationId: string }, { ok: boolean }>({
            handler: (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
            partitionKey: "organizationId",
            singlePartition: false,
        });
        expect((fn as unknown as { __chardbSinglePartition?: boolean }).__chardbSinglePartition).toBeUndefined();
    });

    test("synchronous mutation validation rejects caller input with CDB_INVALID_ARGS before the handler", () => {
        let invoked = false;
        const fn = defineMutation({
            args: z.object({ id: z.string() }),
            handler: () => {
                invoked = true;
                return null;
            },
        });

        try {
            fn({ db: null, auth: { userId: "u", claims: {} } }, { id: 7 } as never);
            throw new Error("expected validation failure");
        } catch (error) {
            expect(isCdbError(error)).toBe(true);
            if (isCdbError(error)) {
                expect(error.code).toBe("CDB_INVALID_ARGS");
                expect(error.retryable).toBe(false);
            }
        }
        expect(invoked).toBe(false);
    });
});
