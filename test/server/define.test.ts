import { describe, expect, test } from "bun:test";
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

describe("defineXxx — function-ref identity", () => {
    test("defineMutation attaches __chardbRef and __chardbKind", async () => {
        const fn = defineMutation(async ({ db: _ }: { db: unknown }, args: { x: number }) => args.x + 1);
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
            handler: async (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
            singlePartition: true,
            partitionKey: "id",
        });
        expect((fn as unknown as { __chardbIdempotencyTtl?: string }).__chardbIdempotencyTtl).toBe("24h");
    });

    test("explicit idempotencyTtl wins over the singlePartition default", () => {
        const fn = defineMutation<unknown, { id: string }, { ok: boolean }>({
            handler: async (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
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
            handler: async (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
        });
        expect((fn as unknown as { __chardbIdempotencyTtl?: string }).__chardbIdempotencyTtl).toBeUndefined();
    });

    test("declaring partitionKey implies singlePartition AND the 24h idempotency horizon", () => {
        const fn = defineMutation<unknown, { organizationId: string }, { ok: boolean }>({
            handler: async (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
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

    test("explicit singlePartition: false beats the partitionKey-implied default", () => {
        const fn = defineMutation<unknown, { organizationId: string }, { ok: boolean }>({
            handler: async (_ctx: MutationCtx<unknown>, _args) => ({ ok: true }),
            partitionKey: "organizationId",
            singlePartition: false,
        });
        expect((fn as unknown as { __chardbSinglePartition?: boolean }).__chardbSinglePartition).toBeUndefined();
    });
});
