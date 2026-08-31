import { describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";
import {
    CHARDB_BINDING_MAX_IN_FLIGHT,
    type ChardbBinding,
    type ChardbBindingPlanRequest,
    client,
} from "../src/binding.ts";
import { CdbError } from "../src/errors.ts";
import { globalScope } from "../src/server/cdb-tenant.ts";

const { cdbTable } = globalScope();
const messages = cdbTable(
    "binding_select_messages",
    {
        id: text("id").primaryKey(),
        channelId: text("channel_id").notNull(),
        body: text("body").notNull(),
        rank: integer("rank").notNull(),
    },
    { partitionBy: "channelId", roles: { member: "*" } }
);

const auth = { jwt: "signed-token", authOrigin: "https://app.example.com" } as const;

function planBinding(executePlan: NonNullable<ChardbBinding["executePlan"]>): ChardbBinding {
    return {
        async executeQuery() {
            return { ok: true, result: null };
        },
        async executeMutation() {
            return { ok: true, cookie: "cookie", ran: true, result: null, rowsAffected: 0 };
        },
        executePlan,
    };
}

describe("native DB structured select client", () => {
    test("sends auth and an owned structured plan while preserving inferred rows", async () => {
        const calls: ChardbBindingPlanRequest[] = [];
        const binding = planBinding(async request => {
            calls.push(request);
            return {
                ok: true,
                result: [{ id: "message-1", channelId: "channel-1", body: "hello", rank: 7 }],
            };
        });
        const db = client(binding, auth);

        const rows: readonly (typeof messages.$inferSelect)[] = await db
            .select()
            .from(messages)
            .where(eq(messages.channelId, "channel-1"))
            .orderBy(desc(messages.rank))
            .limit(25);

        expect(rows[0]?.body).toBe("hello");
        expect(calls).toEqual([
            {
                ...auth,
                plan: {
                    version: 1,
                    kind: "select",
                    table: "binding_select_messages",
                    selection: { kind: "all" },
                    where: { kind: "compare", op: "eq", column: "channel_id", value: "channel-1" },
                    orderBy: [{ column: "rank", direction: "desc" }],
                    limit: 25,
                    cardinality: "many",
                },
            },
        ]);
        expect(JSON.stringify(calls)).not.toContain("SELECT ");
        expect(JSON.stringify(calls)).not.toContain('"sql"');
    });

    test("maps one-row null to undefined and owns get results", async () => {
        let call = 0;
        const row = { id: "message-1", channelId: "channel-1", body: "hello", rank: 7 };
        const db = client(
            planBinding(async request => {
                expect(request.plan.cardinality).toBe("one");
                call++;
                return { ok: true, result: call === 1 ? row : null };
            }),
            auth
        );

        const found: typeof messages.$inferSelect | undefined = await db.select().from(messages).get();
        expect(found).toEqual(row);
        await expect(db.select().from(messages).get()).resolves.toBeUndefined();
    });

    test("reexecutes immutable builders with a fresh plan per terminal", async () => {
        const plans: ChardbBindingPlanRequest["plan"][] = [];
        const row = { id: "message-1", channelId: "channel-1", body: "hello", rank: 7 };
        const db = client(
            planBinding(async request => {
                plans.push(request.plan);
                return { ok: true, result: request.plan.cardinality === "one" ? row : [] };
            }),
            auth
        );
        const query = db.select().from(messages).where(eq(messages.channelId, "channel-1")).limit(25);

        expect(await query).toEqual([]);
        await expect(query.all()).resolves.toEqual([]);
        await expect(query.get()).resolves.toEqual(row);

        expect(plans.map(plan => plan.cardinality)).toEqual(["many", "many", "one"]);
        expect(plans[0]).not.toBe(plans[1]);
        expect(plans[1]).not.toBe(plans[2]);
        expect(plans[0]?.selection).not.toBe(plans[1]?.selection);
        expect(plans[0]?.where).not.toBe(plans[1]?.where);
        expect(plans.every(plan => plan.limit === 25)).toBe(true);
    });

    test("reconstructs typed failures and rejects malformed plan responses", async () => {
        const forbidden = client(
            planBinding(async () => ({
                ok: false,
                error: new CdbError({ code: "CDB_FORBIDDEN", message: "membership revoked" }).toJSON(),
            })),
            auth
        );
        await expect(forbidden.select().from(messages).all()).rejects.toMatchObject({
            code: "CDB_FORBIDDEN",
            retryable: false,
            message: "membership revoked",
        });

        const malformed = client(
            planBinding(async () => ({ ok: true, result: new Date() }) as never),
            auth
        );
        await expect(malformed.select().from(messages).all()).rejects.toMatchObject({ code: "CDB_INVARIANT" });
    });

    test("keeps handle-only bindings compatible and fails only when select executes", async () => {
        const binding: ChardbBinding = {
            async executeQuery() {
                return { ok: true, result: { count: 1 } };
            },
            async executeMutation() {
                return { ok: true, cookie: "cookie", ran: true, result: null, rowsAffected: 0 };
            },
        };
        const db = client(binding, auth);
        const query = Object.assign(async () => ({ count: 1 }), {
            __chardbKind: "query" as const,
            __chardbRef: { toString: () => "queries.ts#count" },
        });

        await expect(db.query(query, {})).resolves.toEqual({ count: 1 });
        await expect(db.select().from(messages).all()).rejects.toMatchObject({
            code: "CDB_UNSUPPORTED_FEATURE",
        });
    });

    test("shares the in-flight cap across handle and structured queries", async () => {
        const planReleases: (() => void)[] = [];
        let releaseHandle!: () => void;
        const handleHeld = new Promise<void>(resolve => {
            releaseHandle = resolve;
        });
        const binding: ChardbBinding = {
            async executeQuery() {
                await handleHeld;
                return { ok: true, result: [] };
            },
            async executeMutation() {
                return { ok: true, cookie: "cookie", ran: true, result: null, rowsAffected: 0 };
            },
            executePlan() {
                return new Promise(resolve => {
                    planReleases.push(() => resolve({ ok: true, result: [] }));
                });
            },
        };
        const db = client(binding, auth);
        const query = Object.assign(async () => [], {
            __chardbKind: "query" as const,
            __chardbRef: { toString: () => "queries.ts#held" },
        });
        const handle = db.query(query, {});
        const plans = Array.from({ length: CHARDB_BINDING_MAX_IN_FLIGHT - 1 }, () => db.select().from(messages).all());

        await expect(db.select().from(messages).all()).rejects.toMatchObject({
            code: "CDB_RATE_LIMITED",
            retryable: true,
        });
        expect(planReleases).toHaveLength(CHARDB_BINDING_MAX_IN_FLIGHT - 1);
        releaseHandle();
        for (const release of planReleases) release();
        await expect(Promise.all([handle, ...plans])).resolves.toHaveLength(CHARDB_BINDING_MAX_IN_FLIGHT);
    });
});
