import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { text } from "drizzle-orm/sqlite-core";
import { CdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import {
    executeRegisteredVectorQueryPlan,
    resolveCdbVectorSearchMatches,
} from "../../src/server/do/cdb-vector-search.ts";
import { cdbVectorizePhysicalId } from "../../src/server/do/cdb-vectorize-wire.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { emptyManifest } from "../../src/server/manifest.ts";
import { compileRegisteredQueryPlan } from "../../src/server/registered-query-plan.ts";
import { cdbVectorResourceId, collectSchemaResourceDescriptors } from "../../src/server/resource-descriptors.ts";
import { renderVectorMutationTriggerSet } from "../../src/server/vector-triggers.ts";
import { ShardId } from "../../src/types.ts";
import { searchVector, vector } from "../../src/vector.ts";
import { forOrg } from "../helpers/cdb-table.ts";
import { withRecoveryEnv } from "../helpers/recovery.ts";

interface Cursor<T> extends Iterable<T> {
    readonly columnNames: string[];
    raw(): IterableIterator<unknown[]>;
}

function sqlStorage(db: Database, onQuery?: (query: string) => void) {
    return {
        exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Cursor<T> {
            onQuery?.(query);
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

function schema() {
    const { cdbTable } = forOrg();
    const messages = cdbTable(
        "vector_search_messages",
        {
            id: text("id").primaryKey(),
            organizationId: text("organization_id").notNull(),
            embedding: vector("embedding", { dim: 3, binding: "CDB_MESSAGES_VECTOR", metric: "cosine" }),
        },
        {
            tenantBy: "organizationId",
            partitionBy: "organizationId",
            roles: {
                member: { read: "*" },
                viewer: { read: ["id", "organizationId"] },
            },
        }
    );
    return { messages };
}

function construct(CdbClass: typeof Cdb, db: Database, onQuery?: (query: string) => void) {
    let ready: Promise<unknown> = Promise.resolve();
    const storage = {
        sql: sqlStorage(db, onQuery),
        transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        setAlarm: async (): Promise<void> => {},
    } as unknown as DurableObjectStorage;
    const state = {
        id: { toString: () => "vector-search-shard" },
        storage,
        blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
            ready = callback();
        },
    } as unknown as DurableObjectState;
    return { cdb: new CdbClass(state, withRecoveryEnv({})), storage, ready };
}

describe("Cdb vector search policy validation", () => {
    const databases: Database[] = [];

    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("returns only the current ready head when row and vector-column policy expose its logical id", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const domain = schema();
        const ConfiguredCdb = configureCdbRuntime({ schema: () => domain, manifest: () => emptyManifest() });
        const { cdb, storage, ready } = construct(ConfiguredCdb, db);
        await ready;
        const [resource] = collectSchemaResourceDescriptors(domain);
        if (!resource || resource.kind !== "vector") throw new Error("vector resource fixture is missing");
        const resourceId = cdbVectorResourceId(resource);
        const store = new CdbVectorOutboxStore(adaptSqlStorage(storage.sql));
        const vectorId = `vec1_${"a".repeat(64)}`;
        store.stageUpsert({
            vectorId,
            organizationId: "org-1",
            resourceId,
            rowPk: "message-1",
            dimensions: 3,
            values: [1, 2, 3],
            metadata: { source: "sqlite" },
            nowMs: 100,
        });
        db.run('INSERT INTO "vector_search_messages" ("id", "organization_id", "embedding") VALUES (?, ?, ?)', [
            "message-1",
            "org-1",
            vectorId,
        ]);
        const claim = store.claimNext({
            nowMs: 101,
            leaseMs: 100,
            settlementMs: 100,
            claimToken: "claim-token-0001",
        });
        if (!claim || claim.operation !== "upsert") throw new Error("vector claim fixture is missing");
        store.acknowledgeUpsert(claim, 102);
        const physicalId = cdbVectorizePhysicalId(vectorId, 1);
        const input = {
            storage,
            schema: domain,
            organizationId: "org-1",
            resource,
            matches: [
                { id: cdbVectorizePhysicalId(vectorId, 2), score: 0.99 },
                { id: physicalId, score: 0.9 },
            ],
            limit: 2,
        };
        await expect(
            resolveCdbVectorSearchMatches({
                ...input,
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
            })
        ).resolves.toEqual([
            {
                vectorId,
                rowPk: "message-1",
                score: 0.9,
                metadata: { source: "sqlite" },
            },
        ]);

        const plan = compileRegisteredQueryPlan(
            () =>
                searchVector(domain.messages.embedding, {
                    organizationId: "org-1",
                    values: [1, 2, 3],
                    limit: 1,
                }),
            {}
        );
        if (plan.kind !== "searchVector") throw new Error("vector fixture compiled a select plan");
        let observedQuery: { readonly values: readonly number[]; readonly options: unknown } | undefined;
        const executed = await executeRegisteredVectorQueryPlan({
            index: {
                query: async (values, options) => {
                    observedQuery = { values, options };
                    return { count: 1, matches: [{ id: physicalId, score: -0 }] };
                },
            },
            storage,
            schema: domain,
            auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
            plan,
        });
        expect(observedQuery).toEqual({
            values: [1, 2, 3],
            options: {
                topK: 17,
                namespace: expect.any(String),
                returnValues: false,
                returnMetadata: "none",
                filter: { cdb_resource: expect.any(String) },
            },
        });
        expect(executed).toEqual([{ rowPk: "message-1", score: 0 }]);
        expect(Object.is(executed[0]?.score, -0)).toBe(false);
        expect(JSON.stringify(executed)).toBe('[{"rowPk":"message-1","score":0}]');
        expect(Object.keys(executed[0] ?? {})).toEqual(["rowPk", "score"]);
        await expect(
            resolveCdbVectorSearchMatches({
                ...input,
                auth: { userId: "user-1", tenantId: "org-1", role: "viewer", roles: ["viewer"], claims: {} },
            })
        ).resolves.toEqual([]);

        await cdb.deleteOrganizationFiles({
            recoveryGeneration: 0,
            organizationId: "org-1",
            nowMs: 200,
            domainSchemaEpoch: 1,
        });
        await expect(
            cdb.resolveOrganizationVectorSearch({
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
                organizationId: "org-1",
                resource,
                resourceId,
                matches: [{ id: physicalId, score: 0.9 }],
                limit: 1,
                route: {
                    shardId: ShardId("ShardDO_00"),
                    schemaEpoch: 1,
                    recoveryGeneration: 0,
                    domainSchemaEpoch: 1,
                },
            })
        ).rejects.toThrow("CDB_FORBIDDEN: organization was permanently deleted");
        await expect(
            resolveCdbVectorSearchMatches({
                ...input,
                auth: { userId: "user-1", tenantId: "org-2", role: "member", roles: ["member"], claims: {} },
            })
        ).rejects.toMatchObject({ code: "CDB_FORBIDDEN" });
        for (const statement of renderVectorMutationTriggerSet(resource).uninstall) db.run(statement);
        db.run('UPDATE "vector_search_messages" SET "embedding" = ? WHERE "id" = ?', ["vec-other", "message-1"]);
        await expect(
            resolveCdbVectorSearchMatches({
                ...input,
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
            })
        ).resolves.toEqual([]);
    });

    test("validates one hundred candidates through one policy-scoped SQLite read", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const domain = schema();
        const ConfiguredCdb = configureCdbRuntime({ schema: () => domain, manifest: () => emptyManifest() });
        let domainReads = 0;
        const { storage, ready } = construct(ConfiguredCdb, db, query => {
            if (/FROM\s+"vector_search_messages"/i.test(query)) domainReads++;
        });
        await ready;
        const [resource] = collectSchemaResourceDescriptors(domain);
        if (!resource || resource.kind !== "vector") throw new Error("vector resource fixture is missing");
        const resourceId = cdbVectorResourceId(resource);
        const store = new CdbVectorOutboxStore(adaptSqlStorage(storage.sql));
        const matches: { readonly id: string; readonly score: number }[] = [];
        for (let index = 0; index < 100; index++) {
            const rowPk = `message-${index}`;
            const vectorId = `vec1_${index.toString(16).padStart(64, "0")}`;
            store.stageUpsert({
                vectorId,
                organizationId: "org-1",
                resourceId,
                rowPk,
                dimensions: 3,
                values: [1, 2, 3],
                metadata: {},
                nowMs: index * 2 + 1,
            });
            db.run('INSERT INTO "vector_search_messages" ("id", "organization_id", "embedding") VALUES (?, ?, ?)', [
                rowPk,
                "org-1",
                vectorId,
            ]);
            const claim = store.claimNext({
                nowMs: index * 2 + 2,
                leaseMs: 100,
                settlementMs: 100,
                claimToken: `candidate-claim-${index.toString().padStart(3, "0")}`,
            });
            if (!claim || claim.operation !== "upsert") throw new Error(`vector claim ${index} is missing`);
            store.acknowledgeUpsert(claim, index * 2 + 2);
            matches.push({ id: cdbVectorizePhysicalId(vectorId, 1), score: 1 - index / 1_000 });
        }

        domainReads = 0;
        const result = await resolveCdbVectorSearchMatches({
            storage,
            schema: domain,
            auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
            organizationId: "org-1",
            resource,
            matches,
            limit: 100,
        });

        expect(result).toHaveLength(100);
        expect(result.map(match => match.rowPk)).toEqual(Array.from({ length: 100 }, (_, index) => `message-${index}`));
        expect(domainReads).toBe(1);
    });
});
