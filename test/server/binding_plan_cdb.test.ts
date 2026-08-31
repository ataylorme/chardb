import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, gte } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { file } from "../../src/files/index.ts";
import { cdbPolicyDigest } from "../../src/server/cdb-policy.ts";
import { forOrg, forUser, globalScope } from "../../src/server/cdb-tenant.ts";
import { createApi } from "../../src/server/define.ts";
import { CdbFileStore, initializeFileStore } from "../../src/server/do/cdb-file-store.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { emptyManifest, manifestFromExports, routeValidatedQuery } from "../../src/server/manifest.ts";
import type { CdbBindingPlanRequest } from "../../src/server/rpc.ts";
import { ClientId, PrincipalId, SubId, TenantId } from "../../src/types.ts";
import { vshardOf } from "../../src/vshard.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database, afterExec: (query: string) => void) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            const statement = db.prepare(query);
            const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
            const columnNames = [...statement.columnNames];
            const rawRows = rows.map(row => columnNames.map(column => row[column]));
            afterExec(query);
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

function construct(
    CdbClass: typeof Cdb,
    db: Database,
    afterExec: (query: string) => void = () => undefined
): { readonly cdb: Cdb; readonly ready: Promise<unknown> } {
    let ready: Promise<unknown> = Promise.resolve();
    const state = {
        id: { toString: () => "binding-plan-shard" },
        storage: {
            sql: sqlStorage(db, afterExec),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        },
        blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
            ready = callback();
        },
    } as unknown as DurableObjectState;
    return { cdb: new CdbClass(state, {}), ready };
}

const { cdbTable: globalTable } = globalScope();
const rows = globalTable(
    "binding_plan_cdb_rows",
    {
        id: text("id").primaryKey(),
        scope: text("scope").notNull(),
        rank: integer("rank").notNull(),
    },
    { partitionBy: "scope", roles: { user: { read: "*" } } }
);
const privateRows = globalTable(
    "binding_plan_cdb_private_rows",
    { id: text("id").primaryKey(), scope: text("scope").notNull() },
    { partitionBy: "scope", roles: { admin: { read: "*" } } }
);
const { cdbTable: userTable } = forUser();
const userRows = userTable(
    "binding_plan_cdb_user_rows",
    { id: text("id").primaryKey(), userId: text("user_id").notNull() },
    { tenantBy: "userId", roles: { user: { read: "*" } } }
);
const organization = sqliteTable("organization", { id: text("id").primaryKey() });
const { cdbTable: organizationTable } = forOrg();
const fileRows = organizationTable(
    "binding_plan_cdb_file_rows",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organization.id),
        attachment: file("attachment", { maxSize: 64, contentTypes: ["image/png"] }),
    },
    {
        roles: {
            member: { read: "*" },
            viewer: { read: ["id", "organizationId"] },
        },
    }
);
const schema = { rows, privateRows, userRows, fileRows };
const ConfiguredCdb = configureCdbRuntime({ schema: () => schema, manifest: emptyManifest });
let plannedCompileRuns = 0;
const plannedRowsQuery = createApi(schema).query({
    ref: "binding-plan-cdb.ts#plannedRows",
    query: (db, args: { scope: string; minimumRank: number }) => {
        plannedCompileRuns++;
        return db
            .select()
            .from(rows)
            .where(and(eq(rows.scope, args.scope), gte(rows.rank, args.minimumRank)))
            .orderBy(rows.id)
            .limit(2);
    },
});
const plannedManifest = manifestFromExports({ plannedRowsQuery });
const PlannedConfiguredCdb = configureCdbRuntime({
    schema: () => schema,
    manifest: () => plannedManifest,
});

const AUTH: CdbBindingPlanRequest["auth"] = {
    userId: "user-1",
    role: "user",
    roles: ["user"],
    authEpochs: { global: 1, tenant: 0, principal: 1 },
    claims: {},
};

function request(overrides: Partial<CdbBindingPlanRequest> = {}): CdbBindingPlanRequest {
    return {
        plan: {
            version: 1,
            kind: "select",
            table: "binding_plan_cdb_rows",
            selection: { kind: "all" },
            where: { kind: "compare", op: "eq", column: "scope", value: "shared" },
            orderBy: [{ column: "rank", direction: "desc" }],
            limit: 2,
            cardinality: "many",
        },
        placement: { authority: "global", partitionKey: "shared" },
        auth: AUTH,
        schemaEpoch: 1,
        domainSchemaEpoch: 1,
        ...overrides,
    };
}

describe("Cdb native binding select execution", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    async function setup(
        afterExec?: (query: string) => void,
        CdbClass: typeof Cdb = ConfiguredCdb
    ): Promise<{ readonly db: Database; readonly cdb: Cdb }> {
        const db = new Database(":memory:");
        databases.push(db);
        const configured = construct(CdbClass, db, afterExec);
        await configured.ready;
        db.run(
            "INSERT INTO binding_plan_cdb_rows (id, scope, rank) VALUES ('a', 'shared', 1), ('b', 'shared', 3), ('c', 'shared', 2), ('other', 'elsewhere', 9)"
        );
        db.run("INSERT INTO binding_plan_cdb_private_rows (id, scope) VALUES ('private', 'shared')");
        db.run("INSERT INTO binding_plan_cdb_user_rows (id, user_id) VALUES ('mine', 'user-1'), ('other', 'user-2')");
        return { db, cdb: configured.cdb };
    }

    test("revalidates placement and executes an ordered bounded full-row plan through policy", async () => {
        const { cdb } = await setup();
        await expect(cdb.executePlan(request())).resolves.toEqual({
            ok: true,
            result: [
                { id: "b", scope: "shared", rank: 3 },
                { id: "c", scope: "shared", rank: 2 },
            ],
        });
        await expect(
            cdb.executePlan(request({ placement: { authority: "global", partitionKey: "forged" } }))
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_INVARIANT" } });
    });

    test("recompiles a registered plan once and executes it through the shared select runner", async () => {
        plannedCompileRuns = 0;
        const { cdb } = await setup(undefined, PlannedConfiguredCdb);
        await expect(
            cdb.query({
                ref: plannedRowsQuery.__chardbRef,
                args: { scope: "shared", minimumRank: 2 },
                placement: { authority: "global", partitionKey: "shared" },
                auth: AUTH,
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).resolves.toEqual({
            ok: true,
            result: [
                { id: "b", scope: "shared", rank: 3 },
                { id: "c", scope: "shared", rank: 2 },
            ],
        });
        expect(plannedCompileRuns).toBe(1);
    });

    test("recompiles a persisted planned query once and executes it through the shared select runner", async () => {
        const { cdb } = await setup(undefined, PlannedConfiguredCdb);
        const args = { scope: "shared", minimumRank: 2 };
        const routed = routeValidatedQuery(plannedManifest, { ref: plannedRowsQuery.__chardbRef, args }, tables =>
            cdbPolicyDigest(schema, tables)
        );
        const subscription = {
            gatewayId: "binding-plan-gateway",
            registrationId: "binding-plan-registration",
            connectionId: "binding-plan-connection",
            clientId: ClientId("binding-plan-client"),
            subId: SubId(1),
        };
        const placement = { authority: "global" as const, partitionKey: "shared" };
        await expect(
            cdb.subscribe({
                subscription,
                principalId: PrincipalId("user-1"),
                organizationId: TenantId("shared"),
                placement,
                schemaEpoch: 1,
                vshard: Number(vshardOf(["shared"])),
                domainSchemaEpoch: 1,
                ref: plannedRowsQuery.__chardbRef,
                args,
                queryHash: routed.queryHash,
                tables: routed.intent.tables,
                intervals: routed.intent.intervals ?? [],
            })
        ).resolves.toMatchObject({ ok: true });

        plannedCompileRuns = 0;
        await expect(
            cdb.queryRegistered({
                subscription,
                placement,
                auth: AUTH,
                schemaEpoch: 1,
                vshard: Number(vshardOf(["shared"])),
                domainSchemaEpoch: 1,
            })
        ).resolves.toEqual({
            ok: true,
            result: [
                { id: "b", scope: "shared", rank: 3 },
                { id: "c", scope: "shared", rank: 2 },
            ],
        });
        expect(plannedCompileRuns).toBe(1);
    });

    test("default-denies rows that fresh policy roles cannot read", async () => {
        const { cdb } = await setup();
        const { orderBy: _orderBy, ...privatePlan } = request().plan;
        await expect(
            cdb.executePlan(
                request({
                    plan: {
                        ...privatePlan,
                        table: "binding_plan_cdb_private_rows",
                        where: { kind: "compare", op: "eq", column: "scope", value: "shared" },
                    },
                })
            )
        ).resolves.toEqual({ ok: true, result: [] });
    });

    test("rejects stale epochs before execution and detects an epoch change after the read", async () => {
        let armPostFence = false;
        let advanced = false;
        const { db, cdb } = await setup(query => {
            if (armPostFence && !advanced && /from\s+["`]binding_plan_cdb_rows["`]/i.test(query)) {
                advanced = true;
                db.run("UPDATE _chardb_schema_state SET active_epoch = 2 WHERE singleton = 1");
            }
        });

        await expect(cdb.executePlan(request({ domainSchemaEpoch: 2 }))).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_STALE_EPOCH" },
        });
        armPostFence = true;
        await expect(cdb.executePlan(request())).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_STALE_EPOCH" },
        });
        expect(advanced).toBe(true);
    });

    test("rederives user placement and refuses an auth snapshot for another user", async () => {
        const { cdb } = await setup();
        const userPlan: CdbBindingPlanRequest["plan"] = {
            version: 1,
            kind: "select",
            table: "binding_plan_cdb_user_rows",
            selection: { kind: "all" },
            where: { kind: "compare", op: "eq", column: "user_id", value: "user-1" },
            cardinality: "many",
        };
        await expect(
            cdb.executePlan(
                request({
                    plan: userPlan,
                    placement: { authority: "user", partitionKey: "user-1" },
                    auth: { ...AUTH, userId: "user-2" },
                })
            )
        ).resolves.toMatchObject({ ok: false, error: { code: "CDB_FORBIDDEN" } });
    });

    test("resolves an attached file only through the owning row and column policy", async () => {
        const { db, cdb } = await setup();
        const sql = adaptSqlStorage(sqlStorage(db, () => undefined));
        initializeFileStore(sql);
        const store = new CdbFileStore(sql);
        store.reserve({
            fileId: "file_policy",
            organizationId: "org-1",
            table: "binding_plan_cdb_file_rows",
            column: "attachment",
            contentType: "image/png",
            size: 4,
            nowMs: 100,
        });
        store.markReady("file_policy", "a".repeat(64), 4, 101);
        store.attach("file_policy", "org-1", "binding_plan_cdb_file_rows", "attachment", "row-1", 102);
        db.run(
            "INSERT INTO binding_plan_cdb_file_rows (id, organization_id, attachment) VALUES ('row-1', 'org-1', 'file_policy')"
        );

        const fileRequest = {
            organizationId: "org-1",
            table: "binding_plan_cdb_file_rows",
            column: "attachment",
            rowId: "row-1",
            domainSchemaEpoch: 1,
            schemaEpoch: 1,
            auth: {
                ...AUTH,
                tenantId: "org-1",
                role: "member",
                roles: ["member"],
                authEpochs: { global: 1, tenant: 1, principal: 1 },
            },
        };
        await expect(cdb.resolveFileDownload(fileRequest)).resolves.toMatchObject({
            fileId: "file_policy",
            objectKey: "v1/org-1/file_policy",
            status: "attached",
            rowId: "row-1",
        });
        await expect(
            cdb.resolveFileDownload({
                ...fileRequest,
                auth: { ...fileRequest.auth, role: "viewer", roles: ["viewer"] },
            })
        ).resolves.toBeNull();
        await expect(
            cdb.resolveFileDownload({
                ...fileRequest,
                auth: { ...fileRequest.auth, role: "outsider", roles: ["outsider"] },
            })
        ).resolves.toBeNull();
        await expect(cdb.resolveFileDownload({ ...fileRequest, rowId: "missing" })).resolves.toBeNull();
        await expect(cdb.resolveFileDownload({ ...fileRequest, domainSchemaEpoch: 2 })).rejects.toThrow(
            "CDB_STALE_EPOCH: Cdb domain schema epoch 1 does not match request epoch 2"
        );
    });
});
