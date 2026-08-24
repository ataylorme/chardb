import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { and, between, eq, exists, gt, gte, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { cdbPolicyDigest } from "../../src/server/cdb-policy.ts";
import { createApi } from "../../src/server/define.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { forOrg } from "../../src/server/index.ts";
import { manifestFromExports, resolveQuery } from "../../src/server/manifest.ts";
import { CDB_RESULT_MAX_BYTES } from "../../src/server/result_limits.ts";
import type {
    CdbQueryRequest,
    CdbRegisteredQueryRequest,
    CdbSubscriptionRequest,
    LiveSubscriptionId,
} from "../../src/server/rpc.ts";
import { ChardbRef, ClientId, PrincipalId, type RawJson, SubId, TenantId } from "../../src/types.ts";
import { stableHashHex, stableJson } from "../../src/util/canonical.ts";
import type { WireEndpoint, WireInterval } from "../../src/wire.ts";

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
const policyDriftRecords = cdbTable(
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
    { selfBy: "ownerId", roles: { member: { read: "*" }, self: { read: "*" } } }
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
const registeredSizedResult = api.query({
    ref: "queries.ts#registeredSizedResult",
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
    handler: async function registeredSizedResultHandler(
        _ctx,
        args: { organizationId: string; rows: number; character: string; characterCount: number }
    ) {
        const value = args.character.repeat(args.characterCount);
        return Array.from({ length: args.rows }, () => value);
    },
});
let hostileResultDescriptorValue = "descriptor-value";
let hostileResultGetValue = "get-trap-value";
let hostileResultGetRuns = 0;
let hostileResultOwnKeysRuns = 0;
let hostileResultSnapshotSideEffect: (() => void) | undefined;
let hostileResultReadsUndeclaredTable = false;

function hostileNestedProxyResult(): RawJson[] {
    const target = [hostileResultDescriptorValue];
    const proxy = new Proxy(target, {
        ownKeys(value) {
            hostileResultOwnKeysRuns++;
            const sideEffect = hostileResultSnapshotSideEffect;
            hostileResultSnapshotSideEffect = undefined;
            sideEffect?.();
            return Reflect.ownKeys(value);
        },
        get(value, key, receiver) {
            hostileResultGetRuns++;
            if (key === "0") return hostileResultGetValue;
            return Reflect.get(value, key, receiver);
        },
    });
    return [proxy];
}

const registeredHostileResult = api.query({
    ref: "queries.ts#registeredHostileResult",
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
    handler: async function registeredHostileResultHandler(ctx) {
        if (hostileResultReadsUndeclaredTable) {
            hostileResultSnapshotSideEffect = () => {
                void ctx.db.select().from(publicRecords);
            };
        }
        return hostileNestedProxyResult();
    },
});

let retainedQueryResult: Array<{ value: string }> | undefined;
const retainedResult = api.query(async function retainedResultHandler() {
    retainedQueryResult = [{ value: "original" }];
    return retainedQueryResult;
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
type RangeCoverageMode =
    | "point-ok"
    | "point-outside"
    | "partial-range"
    | "open-covered"
    | "closed-missed"
    | "unfiltered-narrow"
    | "broad-then-narrow"
    | "discarded-outside"
    | "tenant-floor"
    | "hostile-tenant";
const endpoint = (value: number | string, inclusive: boolean): WireEndpoint => ({
    kind: "value",
    value: [value],
    inclusive,
});
const declaredRange = (
    lo: number | string,
    hi: number | string,
    loInclusive = true,
    hiInclusive = true
): WireInterval => ({
    kind: "range",
    lo: endpoint(lo, loInclusive),
    hi: endpoint(hi, hiInclusive),
});
const registeredRangeCoverage = api.query({
    ref: "queries.ts#registeredRangeCoverage",
    authority: "organization",
    partitionKey: "organizationId",
    intent: (args: { organizationId: string; mode: RangeCoverageMode }) => {
        const onOrganization = args.mode === "tenant-floor" || args.mode === "hostile-tenant";
        const intervals: readonly WireInterval[] =
            args.mode === "point-outside"
                ? [declaredRange(2, 2)]
                : args.mode === "partial-range"
                  ? [declaredRange(2, 3)]
                  : args.mode === "open-covered"
                    ? [{ kind: "range", lo: endpoint(1, true), hi: { kind: "pos_inf" } }]
                    : args.mode === "closed-missed"
                      ? [{ kind: "range", lo: endpoint(1, false), hi: { kind: "pos_inf" } }]
                      : args.mode === "unfiltered-narrow"
                        ? [declaredRange(1, 1)]
                        : onOrganization
                          ? [declaredRange(args.organizationId, args.organizationId)]
                          : [declaredRange(1, 1)];
        return {
            kind: "select" as const,
            tables: ["query_records"],
            partitionKey: {
                table: "query_records",
                column: "organization_id",
                values: [args.organizationId],
            },
            intervals: [
                {
                    table: "query_records",
                    indexName: onOrganization ? "organization_id" : "value",
                    intervals,
                },
            ],
        };
    },
    handler: async function registeredRangeCoverageHandler(
        ctx,
        args: { organizationId: string; mode: RangeCoverageMode }
    ) {
        const query = ctx.db.select().from(records);
        switch (args.mode) {
            case "unfiltered-narrow":
                return query.all();
            case "tenant-floor":
                return query.where(eq(records.groupId, "group-a")).all();
            case "hostile-tenant":
                return query.where(eq(records.organizationId, "org-b")).all();
            case "partial-range":
                return query.where(between(records.value, 1, 3)).all();
            case "open-covered":
                return query.where(gt(records.value, 1)).all();
            case "closed-missed":
                return query.where(gte(records.value, 1)).all();
            case "discarded-outside":
                await query.where(eq(records.value, 99)).all();
                return query.where(eq(records.value, 1)).all();
            case "broad-then-narrow":
                await query.all();
                return query.where(eq(records.value, 1)).all();
            case "point-ok":
            case "point-outside":
                return query.where(eq(records.value, 1)).all();
        }
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
let argumentProbeRuns = 0;
const argumentProbe = api.query(async function argumentProbeHandler() {
    argumentProbeRuns++;
    return [];
});

const manifest = manifestFromExports({
    listRecords,
    getRecord,
    awaitRecords,
    registeredListRecords,
    registeredGetRecord,
    registeredNonJsonResult,
    registeredSizedResult,
    registeredHostileResult,
    registeredIntentCoverage,
    subqueryAttempt,
    rawPredicateAttempt,
    registeredRangeCoverage,
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
    argumentProbe,
    retainedResult,
});
const ConfiguredCdb = configureCdbRuntime({ schema: () => schema, manifest: () => manifest });
const PolicyDriftCdb = configureCdbRuntime({
    schema: () => ({ ...schema, records: policyDriftRecords }),
    manifest: () => manifest,
});
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
    const policyDigest = cdbPolicyDigest(schema, intent.tables);
    return {
        subscription,
        principalId: PrincipalId("user-1"),
        organizationId: TenantId("org-a"),
        ref,
        args,
        queryHash: stableJson({ ref, args, intent, policyDigest }),
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

function sizedResultArgs(rows: number, character: string, characterCount: number) {
    return { organizationId: "org-a", rows, character, characterCount };
}

function intentCoverageLiveRequest(subscription: LiveSubscriptionId, mode: IntentCoverageMode): CdbSubscriptionRequest {
    const args = { organizationId: "org-a", mode };
    const intent = intentCoverage(mode);
    const policyDigest = cdbPolicyDigest(schema, intent.tables);
    return {
        subscription,
        principalId: PrincipalId("user-1"),
        organizationId: TenantId("org-a"),
        ref: registeredIntentCoverage.__chardbRef,
        args,
        queryHash: stableJson({ ref: registeredIntentCoverage.__chardbRef, args, intent, policyDigest }),
        tables: intent.tables,
        intervals: [...new Set(intent.tables)].map(table => ({
            table,
            indexName: "by_id",
            intervals: [{ kind: "full" as const }],
        })),
    };
}

function rangeCoverageLiveRequest(subscription: LiveSubscriptionId, mode: RangeCoverageMode): CdbSubscriptionRequest {
    const args = { organizationId: "org-a", mode };
    const descriptor = resolveQuery(manifest, registeredRangeCoverage.__chardbRef);
    const intent = descriptor.extractIntent?.(args);
    if (!intent) throw new Error("range coverage query has no intent");
    const policyDigest = cdbPolicyDigest(schema, intent.tables);
    return {
        subscription,
        principalId: PrincipalId("user-1"),
        organizationId: TenantId("org-a"),
        ref: registeredRangeCoverage.__chardbRef,
        args,
        queryHash: stableJson({ ref: registeredRangeCoverage.__chardbRef, args, intent, policyDigest }),
        tables: intent.tables,
        intervals: intent.intervals ?? [],
    };
}

describe("Cdb registered query execution", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    async function setup(): Promise<{ readonly db: Database; readonly cdb: Cdb }> {
        registeredProbeRuns = 0;
        argumentProbeRuns = 0;
        registeredQueryPause = undefined;
        hostileResultDescriptorValue = "descriptor-value";
        hostileResultGetValue = "get-trap-value";
        hostileResultGetRuns = 0;
        hostileResultOwnKeysRuns = 0;
        hostileResultSnapshotSideEffect = undefined;
        hostileResultReadsUndeclaredTable = false;
        retainedQueryResult = undefined;
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

    test("caps direct query arguments before descriptor lookup or handler invocation", async () => {
        const { cdb } = await setup();
        await expect(
            cdb.query({
                ref: argumentProbe.__chardbRef,
                args: { value: "é".repeat(262_138) },
                auth: AUTH,
            })
        ).resolves.toEqual({ ok: true, result: [] });
        expect(argumentProbeRuns).toBe(1);

        await expect(
            cdb.query({
                ref: ChardbRef("queries.ts#missing-before-query-arg-limit"),
                args: { value: "é".repeat(262_139) },
                auth: AUTH,
            })
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_INVALID_ARGS", retryable: false } });
        expect(argumentProbeRuns).toBe(1);
    });

    test("keeps a deeply nested legacy registration invalidatable without bricking a valid sibling", async () => {
        const { db, cdb } = await setup();
        const subscription = liveIdentity({ registrationId: "registration-legacy-oversized-args" });
        const stored = liveRequest(subscription);
        await cdb.subscribe(stored);
        const sibling = liveIdentity({ registrationId: "registration-valid-sibling", subId: SubId(2) });
        await cdb.subscribe(liveRequest(sibling));
        let args: RawJson = null;
        for (let depth = 0; depth < 100; depth++) args = { value: args };
        const policyDigest = cdbPolicyDigest(schema, stored.tables);
        const payloadHash = stableHashHex({
            connectionId: subscription.connectionId,
            clientId: subscription.clientId,
            subId: subscription.subId,
            principalId: stored.principalId,
            organizationId: stored.organizationId,
            ref: stored.ref,
            args,
            policyDigest,
            queryHash: stored.queryHash,
            tables: stored.tables,
            intervals: stored.intervals,
        });
        db.run(
            `UPDATE _chardb_live_subscriptions
             SET args_json = ?, payload_hash = ?
             WHERE gateway_id = ? AND registration_id = ?`,
            [JSON.stringify(args), payloadHash, subscription.gatewayId, subscription.registrationId]
        );
        registeredProbeRuns = 0;
        const reconstructed = construct(ConfiguredCdb, db);
        await reconstructed.ready;

        await expect(reconstructed.cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVALID_ARGS", retryable: false },
        });
        expect(registeredProbeRuns).toBe(0);
        await expect(reconstructed.cdb.queryRegistered(registeredQuery(sibling))).resolves.toMatchObject({ ok: true });
        expect(
            db
                .query("SELECT state, args_json AS argsJson FROM _chardb_live_subscriptions ORDER BY registration_id")
                .all()
        ).toEqual([
            { state: "active", argsJson: JSON.stringify(args) },
            { state: "active", argsJson: JSON.stringify(stored.args) },
        ]);
        expect(
            db
                .query(
                    "SELECT registration_id AS registrationId, table_name AS tableName FROM _chardb_live_subscription_tables ORDER BY registration_id"
                )
                .all()
        ).toEqual([
            { registrationId: subscription.registrationId, tableName: "query_records" },
            { registrationId: sibling.registrationId, tableName: "query_records" },
        ]);
    });

    test("accepts empty, small, and exact query result limits", async () => {
        const { cdb } = await setup();
        const cases = [
            { registrationId: "registration-empty", args: sizedResultArgs(0, "", 0), expectedRows: 0 },
            { registrationId: "registration-small", args: sizedResultArgs(2, "x", 1), expectedRows: 2 },
            { registrationId: "registration-row-boundary", args: sizedResultArgs(4_096, "", 0), expectedRows: 4_096 },
            {
                registrationId: "registration-byte-boundary",
                args: sizedResultArgs(1, "a", 512 * 1_024 - 4),
                expectedRows: 1,
            },
        ] as const;

        for (const item of cases) {
            const subscription = liveIdentity({ registrationId: item.registrationId });
            await cdb.subscribe(liveRequest(subscription, registeredSizedResult.__chardbRef, item.args));
            const response = await cdb.queryRegistered(registeredQuery(subscription));
            expect(response).toMatchObject({ ok: true });
            if (response.ok) expect(response.result).toHaveLength(item.expectedRows);
        }
    });

    test("owns direct and registered Proxy array results without invoking property gets", async () => {
        const { cdb } = await setup();
        const args = { organizationId: "org-a" };

        await expect(cdb.query({ ref: registeredHostileResult.__chardbRef, args, auth: AUTH })).resolves.toEqual({
            ok: true,
            result: [["descriptor-value"]],
        });
        expect(hostileResultGetRuns).toBe(0);
        expect(hostileResultOwnKeysRuns).toBe(1);

        hostileResultGetRuns = 0;
        hostileResultOwnKeysRuns = 0;
        const subscription = liveIdentity({ registrationId: "registration-hostile-result" });
        await cdb.subscribe(liveRequest(subscription, registeredHostileResult.__chardbRef, args));
        const response = await cdb.queryRegistered(registeredQuery(subscription));
        expect(response).toEqual({ ok: true, result: [["descriptor-value"]] });
        expect(hostileResultGetRuns).toBe(0);
        expect(hostileResultOwnKeysRuns).toBe(1);

        hostileResultDescriptorValue = "changed-after-settlement";
        hostileResultGetValue = "changed-get-value";
        expect(response).toEqual({ ok: true, result: [["descriptor-value"]] });
    });

    test("checks reads performed by result snapshot traps against the declared intent", async () => {
        const { cdb } = await setup();
        const args = { organizationId: "org-a" };
        const subscription = liveIdentity({ registrationId: "registration-hostile-result-read" });
        await cdb.subscribe(liveRequest(subscription, registeredHostileResult.__chardbRef, args));
        hostileResultReadsUndeclaredTable = true;

        await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
            ok: false,
            error: {
                code: "CDB_INVARIANT",
                message: expect.stringContaining("read undeclared cdbTable: query_public_records"),
            },
        });
        expect(hostileResultGetRuns).toBe(0);
        expect(hostileResultOwnKeysRuns).toBe(1);
    });

    test("applies the durable generation fence after result snapshot traps", async () => {
        const { cdb, db } = await setup();
        const args = { organizationId: "org-a" };
        const subscription = liveIdentity({ registrationId: "registration-hostile-result-retired" });
        await cdb.subscribe(liveRequest(subscription, registeredHostileResult.__chardbRef, args));
        hostileResultSnapshotSideEffect = () => {
            db.query(
                `UPDATE _chardb_live_subscriptions
                 SET query_hash = query_hash || '-changed'
                 WHERE gateway_id = ? AND registration_id = ?`
            ).run(subscription.gatewayId, subscription.registrationId);
        };

        await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
            ok: false,
            error: {
                code: "CDB_INVARIANT",
                message: "registered query changed while its handler was running",
            },
        });
        expect(hostileResultGetRuns).toBe(0);
        expect(hostileResultOwnKeysRuns).toBe(1);
        expect(
            db
                .query(
                    "SELECT query_hash AS queryHash FROM _chardb_live_subscriptions WHERE gateway_id = ? AND registration_id = ?"
                )
                .get(subscription.gatewayId, subscription.registrationId)
        ).toEqual({ queryHash: expect.stringContaining("-changed") });
    });

    test("rejects a descriptor-visible query result one byte over the serialized limit", async () => {
        const { cdb } = await setup();
        hostileResultDescriptorValue = "a".repeat(CDB_RESULT_MAX_BYTES - 5);
        hostileResultGetValue = "small";
        expect(new TextEncoder().encode(JSON.stringify([[hostileResultDescriptorValue]])).byteLength).toBe(
            CDB_RESULT_MAX_BYTES + 1
        );

        await expect(
            cdb.query({
                ref: registeredHostileResult.__chardbRef,
                args: { organizationId: "org-a" },
                auth: AUTH,
            })
        ).resolves.toMatchObject({
            ok: false,
            error: {
                code: "CDB_INVARIANT",
                message: "query result exceeds the 524288-byte serialized limit",
            },
        });
        expect(hostileResultGetRuns).toBe(0);
        expect(hostileResultOwnKeysRuns).toBe(1);
    });

    test("isolates a returned query result from later source mutation", async () => {
        const { cdb } = await setup();
        const response = await cdb.query({ ref: retainedResult.__chardbRef, args: {}, auth: AUTH });
        expect(response).toEqual({ ok: true, result: [{ value: "original" }] });
        if (!retainedQueryResult) throw new Error("query handler did not retain its result");
        const retainedFirst = retainedQueryResult[0];
        if (!retainedFirst) throw new Error("query handler retained an empty result");

        retainedFirst.value = "mutated";
        retainedQueryResult.push({ value: "late" });
        expect(response).toEqual({ ok: true, result: [{ value: "original" }] });
    });

    test("rejects one row or byte over the result limits and measures multibyte UTF-8", async () => {
        const { cdb } = await setup();
        const cases = [
            {
                registrationId: "registration-row-over",
                args: sizedResultArgs(4_097, "", 0),
                message: "registered query result exceeds the 4096-row limit",
            },
            {
                registrationId: "registration-byte-over",
                args: sizedResultArgs(1, "a", 512 * 1_024 - 3),
                message: "registered query result exceeds the 524288-byte serialized limit",
            },
            {
                registrationId: "registration-multibyte-over",
                args: sizedResultArgs(1, "é", (512 * 1_024 - 4) / 2 + 1),
                message: "registered query result exceeds the 524288-byte serialized limit",
            },
        ] as const;

        for (const item of cases) {
            const subscription = liveIdentity({ registrationId: item.registrationId });
            await cdb.subscribe(liveRequest(subscription, registeredSizedResult.__chardbRef, item.args));
            await expect(cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
                ok: false,
                error: { code: "CDB_INVARIANT", message: item.message },
            });
        }

        await expect(
            cdb.query({
                ref: registeredSizedResult.__chardbRef,
                args: sizedResultArgs(4_097, "", 0),
                auth: AUTH,
            })
        ).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT", message: "query result exceeds the 4096-row limit" },
        });
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

    test("requires declared point and range intervals to contain the policy-scoped read", async () => {
        const { cdb } = await setup();
        for (const mode of ["point-ok", "open-covered"] as const) {
            await expect(
                cdb.query({
                    ref: registeredRangeCoverage.__chardbRef,
                    args: { organizationId: "org-a", mode },
                    auth: AUTH,
                })
            ).resolves.toMatchObject({ ok: true });
        }

        for (const mode of ["point-outside", "partial-range", "closed-missed", "unfiltered-narrow"] as const) {
            await expect(
                cdb.query({
                    ref: registeredRangeCoverage.__chardbRef,
                    args: { organizationId: "org-a", mode },
                    auth: AUTH,
                })
            ).resolves.toMatchObject({
                ok: false,
                error: {
                    code: "CDB_INVARIANT",
                    message: expect.stringContaining("read outside declared interval"),
                },
            });
        }
    });

    test("applies interval coverage to persisted registered queries", async () => {
        const { cdb } = await setup();
        const accepted = liveIdentity({ registrationId: "registration-range-accepted" });
        await cdb.subscribe(rangeCoverageLiveRequest(accepted, "point-ok"));
        await expect(cdb.queryRegistered(registeredQuery(accepted))).resolves.toMatchObject({ ok: true });

        const rejected = liveIdentity({ registrationId: "registration-range-rejected" });
        await cdb.subscribe(rangeCoverageLiveRequest(rejected, "point-outside"));
        await expect(cdb.queryRegistered(registeredQuery(rejected))).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT", message: expect.stringContaining("read outside declared interval") },
        });
    });

    test("retains every executed predicate when an empty outside read is discarded before a narrow result", async () => {
        const { cdb } = await setup();
        const response = await cdb.query({
            ref: registeredRangeCoverage.__chardbRef,
            args: { organizationId: "org-a", mode: "discarded-outside" },
            auth: AUTH,
        });

        expect(response).toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT", message: expect.stringContaining("read outside declared interval") },
        });
        expect(response).not.toHaveProperty("result");
    });

    test("retains a broad tenant-scoped execution followed by an allowed narrow result", async () => {
        const { cdb } = await setup();
        const response = await cdb.query({
            ref: registeredRangeCoverage.__chardbRef,
            args: { organizationId: "org-a", mode: "broad-then-narrow" },
            auth: AUTH,
        });

        expect(response).toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT", message: expect.stringContaining("read outside declared interval") },
        });
        expect(response).not.toHaveProperty("result");
    });

    test("tracks the tenant floor and keeps a hostile cross-tenant predicate empty", async () => {
        const { cdb } = await setup();
        await expect(
            cdb.query({
                ref: registeredRangeCoverage.__chardbRef,
                args: { organizationId: "org-a", mode: "tenant-floor" },
                auth: AUTH,
            })
        ).resolves.toMatchObject({ ok: true, result: [{ organizationId: "org-a" }, { organizationId: "org-a" }] });
        await expect(
            cdb.query({
                ref: registeredRangeCoverage.__chardbRef,
                args: { organizationId: "org-a", mode: "hostile-tenant" },
                auth: AUTH,
            })
        ).resolves.toEqual({ ok: true, result: [] });
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

    test("rejects a registered query after its declared table policy changes", async () => {
        const { cdb, db } = await setup();
        const subscription = liveIdentity({ registrationId: "registration-policy-drift" });
        await cdb.subscribe(liveRequest(subscription));

        const drifted = construct(PolicyDriftCdb, db);
        await drifted.ready;
        await expect(drifted.cdb.queryRegistered(registeredQuery(subscription))).resolves.toMatchObject({
            ok: false,
            error: {
                code: "CDB_INVARIANT",
                message: "registered query policy changed after registration",
            },
        });
        expect(registeredProbeRuns).toBe(0);
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
