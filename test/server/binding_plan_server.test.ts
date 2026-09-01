import { describe, expect, test } from "bun:test";
import { integer, text } from "drizzle-orm/sqlite-core";
import type { ChardbSelectPlanV1 } from "../../src/binding-plan.ts";
import { CdbError } from "../../src/errors.ts";
import { file } from "../../src/files/index.ts";
import { executeResolvedSelectPlan } from "../../src/server/binding-plan-execution.ts";
import {
    BINDING_SELECT_PLAN_PROFILE,
    dispatchTrustedBindingPlan,
    resolveSelectPlan,
} from "../../src/server/binding-plan-server.ts";
import type { CdbBindingPlanRequest } from "../../src/server/rpc.ts";
import { PrincipalId, ShardId, TenantId } from "../../src/types.ts";
import { vshardOf } from "../../src/vshard.ts";
import { forOrg, forUser, globalScope } from "../helpers/cdb-table.ts";

const resolveBindingSelectPlan = (schema: Record<string, unknown>, value: unknown) =>
    resolveSelectPlan(schema, value, BINDING_SELECT_PLAN_PROFILE);

const { cdbTable: globalTable } = globalScope();
const globalRows = globalTable(
    "binding_plan_global_rows",
    {
        id: text("id").primaryKey(),
        scope: text("scope").notNull(),
        rank: integer("rank").notNull(),
    },
    { partitionBy: "scope", roles: { user: { read: "*" } } }
);
const compositeRows = globalTable(
    "binding_plan_composite_rows",
    { id: text("id").primaryKey(), scope: text("scope").notNull() },
    { partitionBy: ["scope", "id"], roles: { user: { read: "*" } } }
);
const replicatedRows = globalTable(
    "binding_plan_replicated_rows",
    { id: text("id").primaryKey() },
    { partitionBy: "replicated", roles: { user: { read: "*" } } }
);
const typedRows = globalTable(
    "binding_plan_typed_rows",
    {
        id: text("id").primaryKey(),
        scope: text("scope").notNull(),
        label: text("label").notNull(),
        metadata: text("metadata", { mode: "json" }).notNull(),
        count: integer("count").notNull(),
        enabled: integer("enabled", { mode: "boolean" }).notNull(),
    },
    { partitionBy: "scope", roles: { user: { read: "*" } } }
);
const timestampRows = globalTable(
    "binding_plan_timestamp_rows",
    {
        id: text("id").primaryKey(),
        scope: text("scope").notNull(),
        observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
    },
    { partitionBy: "scope", roles: { user: { read: "*" } } }
);

const { cdbTable: organizationTable } = forOrg();
const organizationRows = organizationTable(
    "binding_plan_organization_rows",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id").notNull(),
    },
    { tenantBy: "organizationId", roles: { member: { read: "*" } } }
);
const organizationFileRows = organizationTable(
    "binding_plan_organization_file_rows",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id").notNull(),
        attachment: file("attachment", { contentTypes: ["image/png"] }),
    },
    { tenantBy: "organizationId", roles: { member: { read: "*" } } }
);

const { cdbTable: userTable } = forUser();
const userRows = userTable(
    "binding_plan_user_rows",
    {
        id: text("id").primaryKey(),
        userId: text("user_id").notNull(),
    },
    { tenantBy: "userId", roles: { user: { read: "*" } } }
);

function plan(table = "binding_plan_global_rows", column = "scope", value = "shared"): ChardbSelectPlanV1 {
    return {
        version: 1,
        kind: "select",
        table,
        selection: { kind: "all" },
        where: { kind: "compare", op: "eq", column, value },
        cardinality: "many",
    };
}

function expectCdbError(operation: () => unknown, code: CdbError["code"]): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(CdbError);
        expect((error as CdbError).code).toBe(code);
        return;
    }
    throw new Error(`expected ${code}`);
}

describe("server-owned native binding select plans", () => {
    test("uses the bounded native binding profile with the canonical resolver", () => {
        const canonical = resolveSelectPlan({ globalRows }, plan(), BINDING_SELECT_PLAN_PROFILE);
        const compatible = resolveBindingSelectPlan({ globalRows }, plan());

        expect(canonical).toEqual(compatible);
        expect(canonical).toMatchObject({
            table: globalRows,
            authority: "global",
            partitionKey: "shared",
        });
        expectCdbError(
            () => resolveSelectPlan({ globalRows }, { ...plan(), limit: 2 }, { maxLimit: 1 }),
            "CDB_INVALID_ARGS"
        );
    });

    test("derives global, organization, and user placement from runtime table metadata", () => {
        expect(resolveBindingSelectPlan({ globalRows }, plan())).toMatchObject({
            table: globalRows,
            authority: "global",
            partitionKey: "shared",
        });

        expect(
            resolveBindingSelectPlan(
                { organizationRows },
                plan("binding_plan_organization_rows", "organization_id", "org-1")
            )
        ).toMatchObject({ table: organizationRows, authority: "organization", partitionKey: "org-1" });

        expect(
            resolveBindingSelectPlan({ userRows }, plan("binding_plan_user_rows", "user_id", "user-1"))
        ).toMatchObject({ table: userRows, authority: "user", partitionKey: "user-1" });
    });

    test("requires the whole predicate to imply one exact nonempty string placement", () => {
        const base = plan();
        for (const where of [
            undefined,
            { kind: "compare", op: "eq", column: "rank", value: 1 },
            { kind: "in", column: "scope", values: ["a", "b"] },
            {
                kind: "or",
                predicates: [
                    { kind: "compare", op: "eq", column: "scope", value: "a" },
                    { kind: "compare", op: "eq", column: "scope", value: "b" },
                ],
            },
            {
                kind: "or",
                predicates: [
                    { kind: "compare", op: "eq", column: "scope", value: "a" },
                    { kind: "compare", op: "eq", column: "rank", value: 1 },
                ],
            },
        ] as const) {
            const { where: _baseWhere, ...withoutWhere } = base;
            expectCdbError(
                () => resolveBindingSelectPlan({ globalRows }, where ? { ...base, where } : withoutWhere),
                "CDB_CROSS_PARTITION"
            );
        }
        expectCdbError(
            () => resolveBindingSelectPlan({ globalRows }, { ...base, where: { ...base.where, value: "" } }),
            "CDB_INVALID_ARGS"
        );
    });

    test("rejects unknown columns and unsafe global partition shapes", () => {
        expectCdbError(
            () =>
                resolveBindingSelectPlan(
                    { globalRows },
                    { ...plan(), orderBy: [{ column: "missing", direction: "asc" }] }
                ),
            "CDB_INVALID_ARGS"
        );
        expectCdbError(
            () => resolveBindingSelectPlan({ compositeRows }, plan("binding_plan_composite_rows")),
            "CDB_UNSUPPORTED_FEATURE"
        );
        expectCdbError(
            () => resolveBindingSelectPlan({ replicatedRows }, plan("binding_plan_replicated_rows", "id")),
            "CDB_UNSUPPORTED_FEATURE"
        );
    });

    test("validates every predicate scalar against the resolved runtime column mode", () => {
        const exactPlacement = { kind: "compare", op: "eq", column: "scope", value: "shared" } as const;
        expect(
            resolveBindingSelectPlan(
                { typedRows },
                {
                    ...plan("binding_plan_typed_rows"),
                    where: {
                        kind: "and",
                        predicates: [
                            exactPlacement,
                            { kind: "in", column: "label", values: ["alpha", "beta"] },
                            { kind: "between", column: "count", lower: 1, upper: 10 },
                            { kind: "compare", op: "eq", column: "enabled", value: true },
                        ],
                    },
                }
            )
        ).toMatchObject({ table: typedRows, authority: "global", partitionKey: "shared" });

        expectCdbError(
            () =>
                resolveBindingSelectPlan(
                    { typedRows },
                    {
                        ...plan("binding_plan_typed_rows"),
                        where: {
                            kind: "and",
                            predicates: [
                                exactPlacement,
                                { kind: "compare", op: "eq", column: "enabled", value: "truthy" },
                            ],
                        },
                    }
                ),
            "CDB_INVALID_ARGS"
        );
        expectCdbError(
            () =>
                resolveBindingSelectPlan(
                    { timestampRows },
                    {
                        ...plan("binding_plan_timestamp_rows"),
                        where: {
                            kind: "and",
                            predicates: [
                                exactPlacement,
                                { kind: "compare", op: "eq", column: "observed_at", value: 1_000 },
                            ],
                        },
                    }
                ),
            "CDB_INVALID_ARGS"
        );
        expectCdbError(
            () =>
                resolveBindingSelectPlan(
                    { typedRows },
                    {
                        ...plan("binding_plan_typed_rows"),
                        where: {
                            kind: "and",
                            predicates: [exactPlacement, { kind: "compare", op: "eq", column: "label", value: null }],
                        },
                    }
                ),
            "CDB_INVALID_ARGS"
        );
    });

    test("rejects non-JSON full-row output modes before execution", () => {
        expectCdbError(
            () => resolveBindingSelectPlan({ timestampRows }, plan("binding_plan_timestamp_rows", "scope", "shared")),
            "CDB_UNSUPPORTED_FEATURE"
        );
    });

    test("treats opaque file references as JSON strings in full-row output", () => {
        const resolved = resolveBindingSelectPlan(
            { organizationFileRows },
            plan("binding_plan_organization_file_rows", "organization_id", "org-1")
        );
        expect(resolved).toMatchObject({
            table: organizationFileRows,
            authority: "organization",
            partitionKey: "org-1",
        });
        expectCdbError(
            () =>
                resolveBindingSelectPlan(
                    { organizationFileRows },
                    {
                        ...plan("binding_plan_organization_file_rows", "organization_id", "org-1"),
                        where: { kind: "compare", op: "eq", column: "attachment", value: "fil_example" },
                    }
                ),
            "CDB_INVALID_ARGS"
        );
    });

    test("resolves fresh authority, derives the route, and sends no SQL or caller authority", async () => {
        let request: CdbBindingPlanRequest | undefined;
        const result = await dispatchTrustedBindingPlan(
            {
                schema: { globalRows },
                catalog: {
                    async resolveOrganizationAuthority() {
                        throw new Error("global plans do not use organization authority");
                    },
                    async resolveUserAuthority(input) {
                        expect(input).toEqual({ principalId: PrincipalId("user-1") });
                        return {
                            principalId: input.principalId,
                            role: "user",
                            roles: ["user"],
                            authEpochs: { global: 7, tenant: 0, principal: 9 },
                        };
                    },
                    async route() {
                        return { shardId: ShardId("shard-a"), schemaEpoch: 4, domainSchemaEpoch: 6 };
                    },
                },
                cdb: shardId => ({
                    async executePlan(input) {
                        expect(shardId).toBe("shard-a");
                        request = input;
                        return { ok: true, result: [{ id: "row-1", scope: "shared", rank: 1 }] };
                    },
                }),
            },
            PrincipalId("user-1"),
            plan()
        );

        expect(result).toEqual({ ok: true, result: [{ id: "row-1", scope: "shared", rank: 1 }] });
        expect(request).toMatchObject({
            placement: { authority: "global", partitionKey: "shared" },
            auth: {
                userId: "user-1",
                role: "user",
                roles: ["user"],
                authEpochs: { global: 7, tenant: 0, principal: 9 },
            },
            domainSchemaEpoch: 6,
        });
        expect(JSON.stringify(request)).not.toContain('"sql"');
        expect(JSON.stringify(request)).not.toContain('"authority":"organization"');
    });

    test("resolves organization authority and placement through one Catalog RPC", async () => {
        let combinedCalls = 0;
        const organizationPlan = plan("binding_plan_organization_rows", "organization_id", "org-1");
        const result = await dispatchTrustedBindingPlan(
            {
                schema: { organizationRows },
                catalog: {
                    async resolveOrganizationAuthority() {
                        throw new Error("legacy authority RPC must not run");
                    },
                    async route() {
                        throw new Error("legacy route RPC must not run");
                    },
                    async resolveOrganizationAuthorityRoute(input) {
                        combinedCalls += 1;
                        expect(input).toEqual({
                            principalId: PrincipalId("user-1"),
                            organizationId: TenantId("org-1"),
                            vshard: Number(vshardOf(["org-1"])),
                        });
                        return {
                            authority: {
                                principalId: PrincipalId("user-1"),
                                organizationId: TenantId("org-1"),
                                role: "member",
                                roles: ["member"],
                                authEpochs: { global: 2, tenant: 3, principal: 4 },
                            },
                            route: { shardId: ShardId("shard-a"), schemaEpoch: 5, domainSchemaEpoch: 6 },
                        };
                    },
                },
                cdb: shardId => ({
                    async executePlan(input) {
                        expect(shardId).toBe("shard-a");
                        expect(input).toMatchObject({
                            placement: { authority: "organization", partitionKey: "org-1" },
                            auth: {
                                userId: "user-1",
                                tenantId: "org-1",
                                authEpochs: { global: 2, tenant: 3, principal: 4 },
                            },
                            domainSchemaEpoch: 6,
                        });
                        return { ok: true, result: [] };
                    },
                }),
            },
            PrincipalId("user-1"),
            organizationPlan
        );

        expect(result).toEqual({ ok: true, result: [] });
        expect(combinedCalls).toBe(1);
    });

    test("projects malformed results and typed Cdb failures at the binding dispatch boundary", async () => {
        const responses = [
            { ok: true, result: new Date() },
            { ok: false, error: new CdbError({ code: "CDB_FORBIDDEN", message: "policy denied" }).toJSON() },
        ];
        const deps = {
            schema: { globalRows },
            catalog: {
                async resolveOrganizationAuthority() {
                    return null;
                },
                async resolveUserAuthority(input: { readonly principalId: PrincipalId }) {
                    return {
                        principalId: input.principalId,
                        role: "user",
                        roles: ["user"],
                        authEpochs: { global: 1, tenant: 0 as const, principal: 1 },
                    };
                },
                async route() {
                    return { shardId: ShardId("shard-a"), schemaEpoch: 1, domainSchemaEpoch: 1 };
                },
            },
            cdb: () => ({
                async executePlan() {
                    return responses.shift() as never;
                },
            }),
        };

        await expect(dispatchTrustedBindingPlan(deps, PrincipalId("user-1"), plan())).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_INVARIANT" },
        });
        await expect(dispatchTrustedBindingPlan(deps, PrincipalId("user-1"), plan())).resolves.toMatchObject({
            ok: false,
            error: { code: "CDB_FORBIDDEN", message: "policy denied" },
        });
    });

    test("refreshes and retries one structured select after a stale routing generation", async () => {
        let catalogCalls = 0;
        const attempts: Array<{ readonly shardId: string; readonly schemaEpoch: number }> = [];
        const result = await dispatchTrustedBindingPlan(
            {
                schema: { globalRows },
                catalog: {
                    async resolveOrganizationAuthority() {
                        return null;
                    },
                    async resolveUserAuthority(input) {
                        return {
                            principalId: input.principalId,
                            role: "user",
                            roles: ["user"],
                            authEpochs: { global: catalogCalls + 1, tenant: 0, principal: catalogCalls + 1 },
                        };
                    },
                    async route() {
                        catalogCalls += 1;
                        return {
                            shardId: ShardId(catalogCalls === 1 ? "source" : "destination"),
                            schemaEpoch: catalogCalls,
                            domainSchemaEpoch: 1,
                        };
                    },
                },
                cdb: shardId => ({
                    async executePlan(input) {
                        attempts.push({ shardId, schemaEpoch: input.schemaEpoch });
                        return shardId === "source"
                            ? {
                                  ok: false,
                                  error: new CdbError({
                                      code: "CDB_STALE_EPOCH",
                                      message: "source cut over",
                                  }).toJSON(),
                              }
                            : { ok: true, result: [{ id: "destination" }] };
                    },
                }),
            },
            PrincipalId("user-1"),
            plan()
        );

        expect(result).toEqual({ ok: true, result: [{ id: "destination" }] });
        expect(catalogCalls).toBe(2);
        expect(attempts).toEqual([
            { shardId: "source", schemaEpoch: 1 },
            { shardId: "destination", schemaEpoch: 2 },
        ]);
    });

    test("bounds structured select retries and never retries terminal or unavailable failures", async () => {
        const stale = new CdbError({ code: "CDB_STALE_EPOCH", message: "still stale" }).toJSON();
        const terminal = new CdbError({ code: "CDB_FORBIDDEN", message: "denied" }).toJSON();
        for (const scenario of [
            { kind: "stale", response: stale, expectedCalls: 2, expectedCode: "CDB_STALE_EPOCH" },
            { kind: "terminal", response: terminal, expectedCalls: 1, expectedCode: "CDB_FORBIDDEN" },
            { kind: "unavailable", response: null, expectedCalls: 1, expectedCode: "CDB_SHARD_UNAVAILABLE" },
        ] as const) {
            let calls = 0;
            const result = await dispatchTrustedBindingPlan(
                {
                    schema: { globalRows },
                    catalog: {
                        async resolveOrganizationAuthority() {
                            return null;
                        },
                        async resolveUserAuthority(input) {
                            return {
                                principalId: input.principalId,
                                role: "user",
                                roles: ["user"],
                                authEpochs: { global: 1, tenant: 0, principal: 1 },
                            };
                        },
                        async route() {
                            return { shardId: ShardId("shard-a"), schemaEpoch: 1, domainSchemaEpoch: 1 };
                        },
                    },
                    cdb: () => ({
                        async executePlan() {
                            calls += 1;
                            if (scenario.response === null) throw new Error("offline");
                            return { ok: false, error: scenario.response };
                        },
                    }),
                },
                PrincipalId("user-1"),
                plan()
            );
            expect(result).toMatchObject({ ok: false, error: { code: scenario.expectedCode } });
            expect(calls).toBe(scenario.expectedCalls);
        }
    });

    test("bounds omitted many limits to 100 and one-row reads to 1", async () => {
        const limits: number[] = [];
        let getCalls = 0;
        const builder = {
            from() {
                return this;
            },
            where() {
                return this;
            },
            orderBy() {
                return this;
            },
            limit(value: number) {
                limits.push(value);
                return this;
            },
            async all() {
                return [];
            },
            async get() {
                getCalls++;
                return undefined;
            },
        };
        const db = {
            select() {
                return builder;
            },
        };
        const resolved = resolveBindingSelectPlan({ globalRows }, plan());

        await expect(executeResolvedSelectPlan(db, resolved)).resolves.toEqual([]);
        await expect(
            executeResolvedSelectPlan(db, {
                ...resolved,
                plan: { ...resolved.plan, cardinality: "one" },
            })
        ).resolves.toBeNull();
        expect(limits).toEqual([100, 1]);
        expect(getCalls).toBe(1);
    });
});
