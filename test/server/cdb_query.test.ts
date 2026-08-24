import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, exists, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createApi } from "../../src/server/define.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { forOrg } from "../../src/server/index.ts";
import { manifestFromExports, resolveQuery } from "../../src/server/manifest.ts";
import type {
    CdbQueryRequest,
    CdbRegisteredQueryRequest,
    CdbSubscriptionRequest,
    LiveSubscriptionId,
} from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";
import { stableJson } from "../../src/util/canonical.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            return {
                columnNames,
                raw: () => rawRows.values(),
                *[Symbol.iterator]() {
                    yield* rows as T[];
                },
            };
        },
    };
}

function construct(CdbClass: typeof Cdb, db: Database): { readonly cdb: Cdb; readonly ready: Promise<unknown> } {
    let ready: Promise<unknown> = Promise.resolve();
    const state = {
        id: { toString: () => "query-shard-1" },
        storage: {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        },
        blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
            ready = callback();
        },
    } as unknown as DurableObjectState;
    return { cdb: new CdbClass(state, {}), ready };
}

const organization = sqliteTable("organization", { id: text("id").primaryKey() });
const user = sqliteTable("user", { id: text("id").primaryKey() });
const { cdbTable } = forOrg();
const records = cdbTable(
    "query_records",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
        ownerId: text("owner_id")
            .notNull()
            .references(() => user.id),
        groupId: text("group_id").notNull(),
        value: integer("value").notNull(),
        secretNote: text("secret_note"),
    },
    {
        selfBy: "ownerId",
        roles: {
            member: { read: { exclude: ["secretNote"] } },
            self: { read: "*" },
        },
    }
);
const privateRecords = cdbTable(
    "query_private_records",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
    },
    { roles: { member: { create: "*" } } }
);
const publicRecords = cdbTable(
    "query_public_records",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
        displayName: text("display_name").notNull(),
    },
    { publicRead: true }
);
const joinTarget = sqliteTable("query_join_target", { id: text("id").primaryKey() });
const schema = { organization, user, records, privateRecords, publicRecords };
const api = createApi(schema);

const listRecords = api.query(async function listRecordsHandler(ctx, args: { groupId: string }) {
    return ctx.db.select().from(records).where(eq(records.groupId, args.groupId)).orderBy(records.id).all();
});
const getRecord = api.query(async function getRecordHandler(ctx, args: { id: string }) {
    return ctx.db.select().from(records).where(eq(records.id, args.id)).get();
});
const awaitRecords = api.query(async function awaitRecordsHandler(ctx) {
    return await ctx.db.select().from(records).orderBy(records.id);
});
let registeredProbeRuns = 0;
let registeredQueryPause:
    | {
          readonly entered: () => void;
          readonly release: Promise<void>;
      }
    | undefined;
const registeredListRecords = api.query({
    ref: "queries.ts#registeredListRecords",
    authority: "organization",
    partitionKey: "organizationId",
    intent: (args: { organizationId: string; groupId: string }) => ({
        kind: "select" as const,
        tables: ["query_records"],
        partitionKey: {
            table: "query_records",
            column: "organization_id",
            values: [args.organizationId],
        },
    }),
    handler: async function registeredListRecordsHandler(ctx, args: { organizationId: string; groupId: string }) {
        registeredProbeRuns++;
        const pause = registeredQueryPause;
        if (pause) {
            pause.entered();
            await pause.release;
        }
        return ctx.db.select().from(records).where(eq(records.groupId, args.groupId)).orderBy(records.id).all();
    },
});
const registeredGetRecord = api.query({
    ref: "queries.ts#registeredGetRecord",
    authority: "organization",
    partitionKey: "organizationId",
    intent: (args: { organizationId: string; id: string }) => ({
        kind: "select" as const,
        tables: ["query_records"],
        partitionKey: {
            table: "query_records",
            column: "organization_id",
            values: [args.organizationId],
        },
    }),
    handler: async function registeredGetRecordHandler(ctx, args: { organizationId: string; id: string }) {
        return ctx.db.select().from(records).where(eq(records.id, args.id)).get();
    },
});
const registeredNonJsonResult = api.query({
    ref: "queries.ts#registeredNonJsonResult",
    authority: "organization",
    partitionKey: "organizationId",
    intent: (args: { organizationId: string }) => ({
        kind: "select" as const,
        tables: ["query_records"],
        partitionKey: {
            table: "query_records",
            column: "organization_id",
            values: [args.organizationId],
        },
    }),
    handler: async function registeredNonJsonResultHandler() {
        return new Date("2026-08-23T00:00:00Z");
    },
});
type IntentCoverageMode = "complete" | "duplicate" | "empty" | "omitted" | "failure";
function intentCoverage(mode: IntentCoverageMode, organizationId = "org-a") {
    const tables =
        mode === "duplicate"
            ? ["query_records", "query_records"]
            : mode === "complete" || mode === "empty"
              ? ["query_records"]
              : [];
    return {
        kind: "select" as const,
        tables,
        partitionKey: {
            table: "query_records",
            column: "organization_id",
            values: [organizationId],
        },
    };
}
const registeredIntentCoverage = api.query({
    ref: "queries.ts#registeredIntentCoverage",
    authority: "organization",
    partitionKey: "organizationId",
    intent: (args: { organizationId: string; mode: IntentCoverageMode }) =>
        intentCoverage(args.mode, args.organizationId),
    handler: async function registeredIntentCoverageHandler(
        ctx,
        args: { organizationId: string; mode: IntentCoverageMode }
    ) {
        const rows = ctx.db
            .select()
            .from(records)
            .where(
                and(
                    args.mode === "empty" ? eq(records.groupId, "missing") : eq(records.groupId, "group-a"),
                    eq(records.organizationId, args.organizationId)
                )
            )
            .orderBy(records.id)
            .all();
        if (args.mode === "failure") throw new Error("intent coverage handler failed");
        return rows;
    },
});
const subqueryAttempt = api.query({
    ref: "queries.ts#subqueryAttempt",
    authority: "organization",
    partitionKey: "organizationId",
    intent: (args: { organizationId: string; declareInner: boolean }) => ({
        kind: "select" as const,
        tables: args.declareInner ? ["query_records", "query_public_records"] : ["query_records"],
        partitionKey: {
            table: "query_records",
            column: "organization_id",
            values: [args.organizationId],
        },
    }),
    handler: async function subqueryAttemptHandler(ctx) {
        const inner = ctx.db.select().from(publicRecords).where(eq(publicRecords.id, "public-a"));
        return ctx.db.select().from(records).where(exists(inner)).all();
    },
});
const rawPredicateAttempt = api.query({
    ref: "queries.ts#rawPredicateAttempt",
    authority: "organization",
    partitionKey: "organizationId",
    intent: (args: { organizationId: string }) => ({
        kind: "select" as const,
        tables: ["query_records", "query_public_records"],
        partitionKey: {
            table: "query_records",
            column: "organization_id",
            values: [args.organizationId],
        },
    }),
    handler: async function rawPredicateAttemptHandler(ctx) {
        return ctx.db.select().from(records).where(sql.raw('EXISTS (SELECT 1 FROM "query_public_records")')).all();
    },
});
const listPrivateRecords = api.query(async function listPrivateRecordsHandler(ctx) {
    return ctx.db.select().from(privateRecords).all();
});
const listPublicRecords = api.query(async function listPublicRecordsHandler(ctx) {
    return ctx.db.select().from(publicRecords).orderBy(publicRecords.id).all();
});
const projectionAttempt = api.query(async function projectionAttemptHandler(ctx) {
    return ctx.db.select({ id: records.id }).from(records).all();
});
const joinAttempt = api.query(async function joinAttemptHandler(ctx) {
    return ctx.db.select().from(records).innerJoin(joinTarget, eq(joinTarget.id, records.id)).all();
});
const groupAttempt = api.query(async function groupAttemptHandler(ctx) {
    return ctx.db.select().from(records).groupBy(records.groupId).all();
});
const setAttempt = api.query(async function setAttemptHandler(ctx) {
    return ctx.db.select().from(records).union(ctx.db.select().from(records)).all();
});
const distinctAttempt = api.query(async function distinctAttemptHandler(ctx) {
    return ctx.db.selectDistinct().from(records).all();
});
const relationalAttempt = api.query(async function relationalAttemptHandler(ctx) {
    return (ctx.db.query as unknown as { records: { findMany(): Promise<unknown> } }).records.findMany();
});
const countAttempt = api.query(async function countAttemptHandler(ctx) {
    return ctx.db.$count(records);
});
const nonCdbAttempt = api.query(async function nonCdbAttemptHandler(ctx) {
    return ctx.db.select().from(organization).all();
});
const nonJsonResult = api.query(async function nonJsonResultHandler() {
    return new Date("2026-08-23T00:00:00Z");
});
const thrownQuery = api.query(async function thrownQueryHandler() {
    throw new Error("query exploded");
});
const insertAttempt = api.query(async function insertAttemptHandler(ctx) {
    ctx.db.insert(records).values({ id: "write-insert", groupId: "group-a", value: 9 }).run();
    return null;
});
const updateAttempt = api.query(async function updateAttemptHandler(ctx) {
    ctx.db.update(records).set({ value: 9 }).run();
    return null;
});
const deleteAttempt = api.query(async function deleteAttemptHandler(ctx) {
    ctx.db.delete(records).run();
    return null;
});
const rawAttempt = api.query(async function rawAttemptHandler(ctx) {
    ctx.db.run(sql.raw('DELETE FROM "query_records"'));
    return null;
});
const transactionAttempt = api.query(async function transactionAttemptHandler(ctx) {
    ctx.db.transaction(() => null);
    return null;
});

const manifest = manifestFromExports({
    listRecords,
    getRecord,
    awaitRecords,
    registeredListRecords,
    registeredGetRecord,
    registeredNonJsonResult,
    registeredIntentCoverage,
    subqueryAttempt,
    rawPredicateAttempt,
    listPrivateRecords,
    listPublicRecords,
    projectionAttempt,
    joinAttempt,
    groupAttempt,
    setAttempt,
    distinctAttempt,
    relationalAttempt,
    countAttempt,
    nonCdbAttempt,
    nonJsonResult,
    thrownQuery,
    insertAttempt,
    updateAttempt,
    deleteAttempt,
    rawAttempt,
    transactionAttempt,
});
const ConfiguredCdb = configureCdbRuntime({ schema: () => schema, manifest: () => manifest });
const AUTH: CdbQueryRequest["auth"] = {
    userId: "user-1",
    tenantId: "org-a",
    roles: ["member"],
    claims: {},
};
const ANONYMOUS: CdbQueryRequest["auth"] = { userId: "", claims: {} };

function liveIdentity(overrides: Partial<LiveSubscriptionId> = {}): LiveSubscriptionId {
    return {
        gatewayId: "gateway-1",
        registrationId: "registration-1",
        connectionId: "connection-1",
        clientId: ClientId("client-1"),
        subId: SubId(1),
        ...overrides,
    };
}

function liveRequest(
    subscription: LiveSubscriptionId,
    ref: ChardbRef = registeredListRecords.__chardbRef,
    args: CdbSubscriptionRequest["args"] = { organizationId: "org-a", groupId: "group-a" }
): CdbSubscriptionRequest {
    const intent = {
        kind: "select" as const,
        tables: ["query_records"],
        partitionKey: {
            table: "query_records",
            column: "organization_id",
            values: ["org-a"],
        },
    };
    return {
        subscription,
        principalId: PrincipalId("user-1"),
        organizationId: TenantId("org-a"),
        ref,
        args,
        queryHash: stableJson({ ref, args, intent }),
        tables: ["query_records"],
        intervals: [{ table: "query_records", indexName: "by_group", intervals: [{ kind: "full" }] }],
    };
}

function registeredQuery(
    subscription: LiveSubscriptionId,
    auth: CdbRegisteredQueryRequest["auth"] = AUTH
): CdbRegisteredQueryRequest {
    return { subscription, auth };
}

function intentCoverageLiveRequest(subscription: LiveSubscriptionId, mode: IntentCoverageMode): CdbSubscriptionRequest {
    const args = { organizationId: "org-a", mode };
    const intent = intentCoverage(mode);
    return {
        subscription,
        principalId: PrincipalId("user-1"),
        organizationId: TenantId("org-a"),
        ref: registeredIntentCoverage.__chardbRef,
        args,
        queryHash: stableJson({ ref: registeredIntentCoverage.__chardbRef, args, intent }),
        tables: intent.tables,
        intervals: [...new Set(intent.tables)].map(table => ({
            table,
            indexName: "by_id",
            intervals: [{ kind: "full" as const }],
        })),
    };
}

describe("Cdb registered query execution", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    async function setup(): Promise<{ readonly db: Database; readonly cdb: Cdb }> {
        registeredProbeRuns = 0;
        registeredQueryPause = undefined;
        const db = new Database(":memory:");
        databases.push(db);
        const configured = construct(ConfiguredCdb, db);
        await configured.ready;
        db.run(
            "INSERT INTO query_records (id, organization_id, owner_id, group_id, value, secret_note) VALUES (?, ?, ?, ?, ?, ?)",
            ["record-1", "org-a", "user-1", "group-a", 1, "mine"]
        );
        db.run(
            "INSERT INTO query_records (id, organization_id, owner_id, group_id, value, secret_note) VALUES (?, ?, ?, ?, ?, ?)",
            ["record-2", "org-a", "user-2", "group-a", 2, "theirs"]
        );
        db.run(
            "INSERT INTO query_records (id, organization_id, owner_id, group_id, value, secret_note) VALUES (?, ?, ?, ?, ?, ?)",
            ["record-other-tenant", "org-b", "user-1", "group-a", 3, "cross-tenant"]
        );
        db.run("INSERT INTO query_private_records (id, organization_id) VALUES ('private-1', 'org-a')");
        db.run(
            "INSERT INTO query_public_records (id, organization_id, display_name) VALUES ('public-a', 'org-a', 'Alpha'), ('public-b', 'org-b', 'Beta')"
        );
        return { db, cdb: configured.cdb };
    }

    test("runs the persisted query and arguments with fresh policy auth", async () => {
        const { cdb } = await setup();
        const subscription = liveIdentity();
        await cdb.subscribe(liveRequest(subscription));

        await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toEqual({
            ok: true,
            result: [
                {
                    id: "record-1",
                    organizationId: "org-a",
                    ownerId: "user-1",
                    groupId: "group-a",
                    value: 1,
                    secretNote: "mine",
                },
                {
                    id: "record-2",
                    organizationId: "org-a",
                    ownerId: "user-2",
                    groupId: "group-a",
                    value: 2,
                    secretNote: null,
                },
            ],
        });
        expect(registeredProbeRuns).toBe(1);
    });

    test("checks registered query reads against complete, duplicate, and omitted intent tables", async () => {
        const { cdb } = await setup();

        for (const mode of ["complete", "duplicate", "empty"] as const) {
            const subscription = liveIdentity({ registrationId: `registration-intent-${mode}` });
            await cdb.subscribe(intentCoverageLiveRequest(subscription, mode));
            await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject(
                mode === "empty"
                    ? { ok: true, result: [] }
                    : { ok: true, result: [{ id: "record-1" }, { id: "record-2" }] }
            );
        }

        const omitted = liveIdentity({ registrationId: "registration-intent-omitted" });
        await cdb.subscribe(intentCoverageLiveRequest(omitted, "omitted"));
        const response = await cdb.queryRegistered(registeredQuery(omitted));
        expect(response).toMatchObject({
            ok: false,
            error: {
                code: "CDB_INVARIANT",
                message: expect.stringContaining("read undeclared cdbTable: query_records"),
            },
        });
        expect(response).not.toHaveProperty("result");
    });

    test("checks direct queries with intent and preserves handler failures", async () => {
        const { cdb } = await setup();

        for (const mode of ["complete", "duplicate", "empty"] as const) {
            await expect(
                cdb.query({
                    ref: registeredIntentCoverage.__chardbRef,
                    args: { organizationId: "org-a", mode },
                    auth: AUTH,
                })
            ).resolves.toMatchObject(
                mode === "empty"
                    ? { ok: true, result: [] }
                    : { ok: true, result: [{ id: "record-1" }, { id: "record-2" }] }
            );
        }

        await expect(
            cdb.query({
                ref: registeredIntentCoverage.__chardbRef,
                args: { organizationId: "org-a", mode: "omitted" },
                auth: AUTH,
            })
        ).resolves.toMatchObject({
            ok: false,
            error: {
                code: "CDB_INVARIANT",
                message: expect.stringContaining("read undeclared cdbTable: query_records"),
            },
        });
        await expect(
            cdb.query({
                ref: registeredIntentCoverage.__chardbRef,
                args: { organizationId: "org-a", mode: "failure" },
                auth: AUTH,
            })
        ).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT", message: "intent coverage handler failed" },
        });
    });

    test("blocks embedded select builders even when intent declares the inner table", async () => {
        const { cdb } = await setup();

        for (const declareInner of [false, true]) {
            const response = await cdb.query({
                ref: subqueryAttempt.__chardbRef,
                args: { organizationId: "org-a", declareInner },
                auth: AUTH,
            });
            expect(response).toMatchObject({
                ok: false,
                error: {
                    code: "CDB_UNSUPPORTED_FEATURE",
                    message: expect.stringContaining("subqueries are unavailable"),
                },
            });
            expect(response).not.toHaveProperty("result");
        }
    });

    test("blocks raw predicates that hide a table reference", async () => {
        const { cdb } = await setup();
        const response = await cdb.query({
            ref: rawPredicateAttempt.__chardbRef,
            args: { organizationId: "org-a" },
            auth: AUTH,
        });

        expect(response).toMatchObject({
            ok: false,
            error: {
                code: "CDB_UNSUPPORTED_FEATURE",
                message: expect.stringContaining("raw SQL identifiers or keywords"),
            },
        });
        expect(response).not.toHaveProperty("result");
    });

    test("does not return a result when the generation retires during the handler await", async () => {
        const { cdb } = await setup();
        const subscription = liveIdentity({ registrationId: "registration-retired-during-query" });
        await cdb.subscribe(liveRequest(subscription));

        let signalEntered: (() => void) | undefined;
        const entered = new Promise<void>(resolve => {
            signalEntered = resolve;
        });
        let releaseHandler: (() => void) | undefined;
        const release = new Promise<void>(resolve => {
            releaseHandler = resolve;
        });
        registeredQueryPause = {
            entered: () => signalEntered?.(),
            release,
        };

        const pending = cdb.queryRegistered(registeredQuery(subscription));
        await entered;
        await cdb.unsubscribe(subscription);
        releaseHandler?.();
        const response = await pending;

        expect(response).toMatchObject({ ok: false, error: { code: "CDB_INVARIANT" } });
        expect(response).not.toHaveProperty("result");
        expect(registeredProbeRuns).toBe(1);
        registeredQueryPause = undefined;
    });

    test("rejects missing, forged, principal-mismatched, and retired registrations before execution", async () => {
        const { cdb } = await setup();
        const subscription = liveIdentity();
        await cdb.subscribe(liveRequest(subscription));

        for (const request of [
            registeredQuery(liveIdentity({ registrationId: "missing" })),
            registeredQuery({ ...subscription, connectionId: "connection-forged" }),
            registeredQuery(subscription, { ...AUTH, userId: "user-forged" }),
            registeredQuery(subscription, { ...AUTH, tenantId: "org-forged" }),
        ]) {
            await expect(cdb.queryRegistered(request)).resolves.toMatchObject({
                ok: false,
                error: { code: "CDB_INVARIANT" },
            });
        }
        await cdb.unsubscribe(subscription);
        await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
        expect(registeredProbeRuns).toBe(0);
    });

    test("rejects authority, partition, and intent deploy drift before execution", async () => {
        const queries = manifest.queries as Map<ChardbRef, ReturnType<typeof resolveQuery>>;
        const original = resolveQuery(manifest, registeredListRecords.__chardbRef);
        const { authority: _authority, ...withoutAuthority } = original;
        const drifted = [
            withoutAuthority,
            { ...original, extractPartitionKey: () => "org-drifted" },
            {
                ...original,
                extractIntent: () => ({
                    kind: "select" as const,
                    tables: ["query_records", "query_drifted"],
                    partitionKey: {
                        table: "query_records",
                        column: "organization_id",
                        values: ["org-a"],
                    },
                }),
            },
        ];

        for (const [index, descriptor] of drifted.entries()) {
            const { cdb } = await setup();
            const subscription = liveIdentity({ registrationId: `registration-drift-${index}` });
            await cdb.subscribe(liveRequest(subscription));
            queries.set(registeredListRecords.__chardbRef, descriptor);
            try {
                await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
                    ok: false,
                    error: { code: "CDB_INVARIANT" },
                });
                expect(registeredProbeRuns).toBe(0);
            } finally {
                queries.set(registeredListRecords.__chardbRef, original);
            }
        }
    });

    test("rejects corrupt payloads and table mappings before execution", async () => {
        const { cdb, db } = await setup();
        const subscription = liveIdentity();
        await cdb.subscribe(liveRequest(subscription));

        db.run("DELETE FROM _chardb_live_subscription_tables WHERE gateway_id = ? AND registration_id = ?", [
            subscription.gatewayId,
            subscription.registrationId,
        ]);
        await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
        db.run(
            "INSERT INTO _chardb_live_subscription_tables (gateway_id, registration_id, table_name) VALUES (?, ?, ?)",
            [subscription.gatewayId, subscription.registrationId, "query_records"]
        );
        db.run("UPDATE _chardb_live_subscriptions SET args_json = ? WHERE gateway_id = ? AND registration_id = ?", [
            '{"groupId":"different"}',
            subscription.gatewayId,
            subscription.registrationId,
        ]);
        await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
        db.run("UPDATE _chardb_live_subscriptions SET args_json = ? WHERE gateway_id = ? AND registration_id = ?", [
            "{",
            subscription.gatewayId,
            subscription.registrationId,
        ]);
        await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
        expect(registeredProbeRuns).toBe(0);
    });

    test("returns typed failures for unknown refs and non-array or invalid results", async () => {
        const cases = [
            { ref: ChardbRef("queries.ts#missing"), args: {} },
            { ref: registeredGetRecord.__chardbRef, args: { organizationId: "org-a", id: "record-1" } },
            { ref: registeredNonJsonResult.__chardbRef, args: { organizationId: "org-a" } },
        ] as const;

        for (const [index, testCase] of cases.entries()) {
            const { cdb } = await setup();
            const subscription = liveIdentity({ registrationId: `registration-result-${index}` });
            await cdb.subscribe(liveRequest(subscription, testCase.ref, testCase.args));
            await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
                ok: false,
                error: { code: index === 0 ? "CDB_REF_NOT_FOUND" : "CDB_INVARIANT" },
            });
        }
    });

    test("reads persisted rows and returns an empty JSON array when nothing matches", async () => {
        const { cdb } = await setup();
        await expect(
            cdb.query({ ref: listRecords.__chardbRef, args: { groupId: "group-a" }, auth: AUTH })
        ).resolves.toEqual({
            ok: true,
            result: [
                {
                    id: "record-1",
                    organizationId: "org-a",
                    ownerId: "user-1",
                    groupId: "group-a",
                    value: 1,
                    secretNote: "mine",
                },
                {
                    id: "record-2",
                    organizationId: "org-a",
                    ownerId: "user-2",
                    groupId: "group-a",
                    value: 2,
                    secretNote: null,
                },
            ],
        });
        await expect(
            cdb.query({ ref: listRecords.__chardbRef, args: { groupId: "missing" }, auth: AUTH })
        ).resolves.toEqual({ ok: true, result: [] });
    });

    test("masks get and awaited full-row results while preserving JS field names", async () => {
        const { cdb } = await setup();
        await expect(cdb.query({ ref: getRecord.__chardbRef, args: { id: "record-2" }, auth: AUTH })).resolves.toEqual({
            ok: true,
            result: {
                id: "record-2",
                organizationId: "org-a",
                ownerId: "user-2",
                groupId: "group-a",
                value: 2,
                secretNote: null,
            },
        });
        await expect(cdb.query({ ref: awaitRecords.__chardbRef, args: {}, auth: AUTH })).resolves.toMatchObject({
            ok: true,
            result: [
                { id: "record-1", secretNote: "mine" },
                { id: "record-2", secretNote: null },
            ],
        });
    });

    test("default-denies private reads and permits anonymous publicRead", async () => {
        const { cdb } = await setup();
        await expect(cdb.query({ ref: listPrivateRecords.__chardbRef, args: {}, auth: AUTH })).resolves.toEqual({
            ok: true,
            result: [],
        });
        await expect(cdb.query({ ref: listPublicRecords.__chardbRef, args: {}, auth: ANONYMOUS })).resolves.toEqual({
            ok: true,
            result: [
                { id: "public-a", organizationId: "org-a", displayName: "Alpha" },
                { id: "public-b", organizationId: "org-b", displayName: "Beta" },
            ],
        });
    });

    test("rejects unmaskable select shapes and query-builder bypasses", async () => {
        const { cdb } = await setup();
        for (const ref of [
            projectionAttempt.__chardbRef,
            joinAttempt.__chardbRef,
            groupAttempt.__chardbRef,
            setAttempt.__chardbRef,
            distinctAttempt.__chardbRef,
            relationalAttempt.__chardbRef,
            countAttempt.__chardbRef,
            nonCdbAttempt.__chardbRef,
        ]) {
            await expect(cdb.query({ ref, args: {}, auth: AUTH })).resolves.toMatchObject({
                ok: false,
                error: { code: "CDB_UNSUPPORTED_FEATURE" },
            });
        }
    });

    test("returns typed failures for unknown refs, non-JSON results, and thrown handlers", async () => {
        const { cdb } = await setup();
        await expect(cdb.query({ ref: ChardbRef("queries.ts#missing"), args: {}, auth: AUTH })).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_REF_NOT_FOUND" },
        });
        await expect(cdb.query({ ref: nonJsonResult.__chardbRef, args: {}, auth: AUTH })).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT", message: expect.stringContaining("query result is not JSON") },
        });
        await expect(cdb.query({ ref: thrownQuery.__chardbRef, args: {}, auth: AUTH })).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT", message: "query exploded" },
        });
    });

    test("rejects write, raw, and transaction entry points before data changes", async () => {
        const { cdb, db } = await setup();
        for (const ref of [
            insertAttempt.__chardbRef,
            updateAttempt.__chardbRef,
            deleteAttempt.__chardbRef,
            rawAttempt.__chardbRef,
            transactionAttempt.__chardbRef,
        ]) {
            await expect(cdb.query({ ref, args: {}, auth: AUTH })).resolves.toMatchObject({
                ok: false,
                error: { code: "CDB_UNSUPPORTED_FEATURE" },
            });
            expect(db.query("SELECT id, value FROM query_records ORDER BY id").all()).toEqual([
                { id: "record-1", value: 1 },
                { id: "record-2", value: 2 },
                { id: "record-other-tenant", value: 3 },
            ]);
        }
    });
});
