import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { forOrg } from "../../src/server/cdb-tenant.ts";
import { type MutationCtx, createApi } from "../../src/server/define.ts";
import { CdbReshardRuntime } from "../../src/server/do/cdb-reshard-runtime.ts";
import { CDB_VECTOR_MAX_OUTBOX_ROWS, CdbVectorOutboxStore } from "../../src/server/do/cdb-vector-outbox-store.ts";
import { type Cdb, configureCdbRuntime } from "../../src/server/do/cdb.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";
import { cdbVectorResourceId, collectSchemaResourceDescriptors } from "../../src/server/resource-descriptors.ts";
import { vector } from "../../src/vector.ts";
import { vshardOf } from "../../src/vshard.ts";

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

function construct(CdbClass: typeof Cdb, db: Database, index: object) {
    let ready: Promise<unknown> = Promise.resolve();
    let alarm: number | null = null;
    const state = {
        id: { toString: () => "vector-delivery-shard" },
        storage: {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
            setAlarm: async (deadline: number): Promise<void> => {
                alarm = deadline;
            },
            getAlarm: async (): Promise<number | null> => alarm,
        },
        blockConcurrencyWhile: (callback: () => Promise<unknown>): void => {
            ready = callback();
        },
    } as unknown as DurableObjectState;
    const env = "CDB_MESSAGES" in index ? index : { CDB_MESSAGES: index };
    return {
        cdb: new CdbClass(state, env as never),
        ready,
        alarm: () => alarm,
        consumeAlarm: () => {
            alarm = null;
        },
    };
}

type DestinationVectorOutcome = "active" | "aborting" | "aborted" | "finalized" | "cleaned" | null;

function persistDestinationVectorLifecycle(
    db: Database,
    state: {
        readonly outcome: DestinationVectorOutcome;
        readonly serving: 0 | 1;
        readonly abortStarted: 0 | 1;
        readonly drained: 0 | 1;
        readonly range?: number;
    }
): void {
    const range = state.range ?? 0;
    db.run(
        `INSERT INTO _chardb_split_identity
           (mig_id, range_lo, range_hi, role, schema_version, schema_epoch, schema_digest, tables_json, created_at)
         VALUES ('bootstrap-vector-dest', ?, ?, 'dest', 0, 1, ?, '[]', 0)`,
        [range, range, "0".repeat(64)]
    );
    db.run(
        `INSERT INTO _chardb_split_state
           (mig_id, range_lo, range_hi, role, destination_generation, destination_serving,
            abort_started, drained, updated_at)
         VALUES ('bootstrap-vector-dest', ?, ?, 'dest', 2, ?, ?, ?, 0)`,
        [range, range, state.serving, state.abortStarted, state.drained]
    );
    if (state.outcome !== null) {
        db.run(
            `INSERT INTO _chardb_vector_reshard_dest_sessions
               (mig_id, range_lo, range_hi, through_head_seq, expected_cursor_json, next_page_number,
                outcome, cleaned)
             VALUES ('bootstrap-vector-dest', ?, ?, 0, '{}', 0, ?, ?)`,
            [range, range, state.outcome, state.outcome === "cleaned" ? 1 : 0]
        );
    }
}

function vectorMutationTriggerCount(db: Database): number {
    return (
        db
            .query(
                `SELECT COUNT(*) AS count FROM sqlite_master
                 WHERE type = 'trigger' AND tbl_name = 'delivered_vector_messages'
                   AND name LIKE '_chardb_vector_%'`
            )
            .get() as { count: number }
    ).count;
}

function vectorOrganizationDeletionGuardCount(db: Database): number {
    return (
        db
            .query(
                `SELECT COUNT(*) AS count FROM sqlite_master
                 WHERE type = 'trigger' AND name IN (
                   '_chardb_vectors_reject_deleted_organization_insert',
                   '_chardb_vectors_reject_deleted_organization_write'
                 )`
            )
            .get() as { count: number }
    ).count;
}

function fixture() {
    const organization = sqliteTable("organization", { id: text("id").primaryKey() });
    const { cdbTable } = forOrg();
    const messages = cdbTable(
        "delivered_vector_messages",
        {
            id: text("id").primaryKey(),
            organizationId: text("organization_id")
                .notNull()
                .references(() => organization.id),
            body: text("body").notNull(),
            embedding: vector("embedding", { dim: 3, binding: "CDB_MESSAGES", metric: "cosine" }),
        },
        { roles: { member: { create: "*", update: "*", delete: true, read: "*" } } }
    );
    const schema = { messages };
    const api = createApi(schema);
    let escaped: MutationCtx<unknown> | undefined;
    const put = api.mutation(
        (ctx, args: { organizationId: string; id: string; body: string; values: number[] }) => {
            escaped = ctx;
            const embedding = ctx.vector.set(messages.embedding, args.id, args.values);
            ctx.db.insert(messages).values({ id: args.id, body: args.body, embedding }).run();
            return embedding.id;
        },
        {
            authority: "organization",
            ref: "test/vector#put",
            partitionKey: args => args.organizationId,
        }
    );
    const remove = api.mutation(
        (ctx, args: { organizationId: string; id: string }) => {
            ctx.vector.delete(messages.embedding, args.id);
            ctx.db.delete(messages).run();
            return args.id;
        },
        {
            authority: "organization",
            ref: "test/vector#remove",
            partitionKey: args => args.organizationId,
        }
    );
    const update = api.mutation(
        (ctx, args: { organizationId: string; id: string; values: number[] }) => {
            const embedding = ctx.vector.set(messages.embedding, args.id, args.values);
            ctx.db.update(messages).set({ embedding }).run();
            return embedding.id;
        },
        {
            authority: "organization",
            ref: "test/vector#update",
            partitionKey: args => args.organizationId,
        }
    );
    const move = api.mutation(
        (ctx, args: { organizationId: string; id: string; nextId: string }) => {
            ctx.db.update(messages).set({ id: args.nextId }).run();
            return args.nextId;
        },
        {
            authority: "organization",
            ref: "test/vector#move",
            partitionKey: args => args.organizationId,
        }
    );
    const bypass = api.mutation(
        (ctx, args: { organizationId: string; id: string }) => {
            ctx.db
                .insert(messages)
                .values({ id: args.id, body: "bypass", embedding: { id: "forged" } })
                .run();
            return args.id;
        },
        {
            authority: "organization",
            ref: "test/vector#bypass",
            partitionKey: args => args.organizationId,
        }
    );
    return { schema, messages, put, remove, update, move, bypass, escaped: () => escaped };
}

describe("private organization vector mutation delivery", () => {
    const databases: Database[] = [];
    afterEach(() => {
        for (const db of databases.splice(0)) db.close();
    });

    test("reconstructs the exact destination mutation-trigger lifecycle on bootstrap", async () => {
        const validCases = [
            { name: "prepared", outcome: null, serving: 0, abortStarted: 0, drained: 0, installed: true },
            { name: "prepared abort fence", outcome: null, serving: 0, abortStarted: 1, drained: 0, installed: true },
            {
                name: "prepared abort tombstone",
                outcome: null,
                serving: 0,
                abortStarted: 1,
                drained: 1,
                installed: true,
            },
            {
                name: "prepared serving tombstone",
                outcome: null,
                serving: 1,
                abortStarted: 0,
                drained: 1,
                installed: true,
            },
            { name: "active", outcome: "active", serving: 0, abortStarted: 0, drained: 0, installed: false },
            {
                name: "active abort fence",
                outcome: "active",
                serving: 0,
                abortStarted: 1,
                drained: 0,
                installed: false,
            },
            {
                name: "active drained abort",
                outcome: "active",
                serving: 0,
                abortStarted: 1,
                drained: 1,
                installed: false,
            },
            { name: "aborting", outcome: "aborting", serving: 0, abortStarted: 1, drained: 1, installed: false },
            {
                name: "finalized before cutover",
                outcome: "finalized",
                serving: 0,
                abortStarted: 0,
                drained: 0,
                installed: true,
            },
            {
                name: "finalized serving",
                outcome: "finalized",
                serving: 1,
                abortStarted: 0,
                drained: 0,
                installed: true,
            },
            {
                name: "finalized abort",
                outcome: "finalized",
                serving: 0,
                abortStarted: 1,
                drained: 1,
                installed: false,
            },
            { name: "aborted", outcome: "aborted", serving: 0, abortStarted: 1, drained: 1, installed: true },
            { name: "cleaned", outcome: "cleaned", serving: 1, abortStarted: 0, drained: 1, installed: true },
        ] as const;
        const f = fixture();
        const CdbClass = configureCdbRuntime({ schema: () => f.schema, manifest: () => manifestFromExports({}) });

        for (const lifecycle of validCases) {
            const db = new Database(":memory:");
            databases.push(db);
            await construct(CdbClass, db, {}).ready;
            expect(vectorMutationTriggerCount(db), lifecycle.name).toBe(5);
            expect(vectorOrganizationDeletionGuardCount(db), lifecycle.name).toBe(2);
            persistDestinationVectorLifecycle(db, lifecycle);

            const restarted = construct(CdbClass, db, {});
            await expect(restarted.ready, lifecycle.name).resolves.toBeUndefined();
            expect(vectorMutationTriggerCount(db), lifecycle.name).toBe(lifecycle.installed ? 5 : 0);
            expect(vectorOrganizationDeletionGuardCount(db), lifecycle.name).toBe(lifecycle.installed ? 2 : 0);
        }

        const invalidCases = [
            { name: "prepared drained without abort", outcome: null, serving: 0, abortStarted: 0, drained: 1 },
            { name: "active serving", outcome: "active", serving: 1, abortStarted: 0, drained: 0 },
            { name: "aborting before drain", outcome: "aborting", serving: 0, abortStarted: 1, drained: 0 },
            { name: "finalized nonserving after drain", outcome: "finalized", serving: 0, abortStarted: 0, drained: 1 },
            { name: "aborted before drain", outcome: "aborted", serving: 0, abortStarted: 1, drained: 0 },
            { name: "cleaned before drain", outcome: "cleaned", serving: 1, abortStarted: 0, drained: 0 },
        ] as const;

        for (const lifecycle of invalidCases) {
            const db = new Database(":memory:");
            databases.push(db);
            await construct(CdbClass, db, {}).ready;
            persistDestinationVectorLifecycle(db, lifecycle);

            await expect(construct(CdbClass, db, {}).ready, lifecycle.name).rejects.toMatchObject({
                code: "CDB_RESHARD_PHASE_MISMATCH",
            });
        }
    });

    test("does not deliver a finalized destination outbox until the range is serving and drained", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const calls: string[][] = [];
        const index = {
            upsert(records: readonly { id: string }[]) {
                calls.push(records.map(record => record.id));
                return { count: records.length, ids: records.map(record => record.id) };
            },
            deleteByIds: () => ({ count: 0, ids: [] }),
            getByIds: () => [],
        };
        const CdbClass = configureCdbRuntime({
            schema: () => f.schema,
            manifest: () => manifestFromExports({ put: f.put }),
        });
        const initial = construct(CdbClass, db, index);
        await initial.ready;
        expect(
            await initial.cdb.mutate({
                principalId: "user-1",
                mutId: "vector-finalized-bootstrap-1",
                ref: f.put.__chardbRef,
                args: { organizationId: "org-1", id: "message-finalized", body: "held", values: [1, 0, 0] },
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
                placement: { authority: "organization", partitionKey: "org-1" },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).toMatchObject({ ok: true, ran: true });

        const range = Number(vshardOf(["org-1"]));
        persistDestinationVectorLifecycle(db, {
            outcome: "finalized",
            serving: 0,
            abortStarted: 0,
            drained: 0,
            range,
        });
        const restarted = construct(CdbClass, db, index);
        await restarted.ready;

        expect(restarted.alarm()).toBeNull();
        await restarted.cdb.alarm();
        expect(calls).toHaveLength(0);
        expect(restarted.alarm()).toBeNull();
        expect(db.query("SELECT phase, attempts FROM _chardb_vector_outbox").get()).toEqual({
            phase: "submit",
            attempts: 0,
        });

        db.run(
            `UPDATE _chardb_split_state
             SET destination_serving = 1, drained = 1
             WHERE mig_id = 'bootstrap-vector-dest'`
        );
        await restarted.cdb.alarm();
        expect(calls).toHaveLength(1);
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vector_outbox").get()).toEqual({ count: 0 });
    });

    test("opens tombstoned vector writes only for staged destination replay and closes them before serving", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const CdbClass = configureCdbRuntime({ schema: () => f.schema, manifest: () => manifestFromExports({}) });
        await construct(CdbClass, db, {}).ready;
        const organizationId = "org-replay";
        const range = Number(vshardOf([organizationId]));
        db.run(
            `INSERT INTO _chardb_deleted_organizations (organization_id, deleted_at, placement_vshard)
             VALUES (?, 1, ?)`,
            [organizationId, range]
        );
        persistDestinationVectorLifecycle(db, {
            outcome: "active",
            serving: 0,
            abortStarted: 0,
            drained: 0,
            range,
        });
        await construct(CdbClass, db, {}).ready;
        expect(vectorOrganizationDeletionGuardCount(db)).toBe(0);
        const resource = collectSchemaResourceDescriptors(f.schema).find(item => item.kind === "vector");
        if (!resource || resource.kind !== "vector") throw new Error("vector resource fixture is missing");
        const store = new CdbVectorOutboxStore(adaptSqlStorage(sqlStorage(db) as never));
        const replayed = store.stageUpsert({
            vectorId: `vec1_${"d".repeat(64)}`,
            organizationId,
            resourceId: cdbVectorResourceId(resource),
            rowPk: "tail-row",
            dimensions: 3,
            values: [1, 0, 0],
            metadata: {},
            nowMs: 2,
        });
        expect(replayed).toMatchObject({ state: "pending" });
        db.run(
            `INSERT INTO delivered_vector_messages (id, organization_id, body, embedding)
             VALUES ('tail-row', ?, 'tail', ?)`,
            [organizationId, replayed.vectorId]
        );

        db.run(
            `UPDATE _chardb_vector_reshard_dest_sessions
             SET outcome = 'finalized' WHERE mig_id = 'bootstrap-vector-dest'`
        );
        await construct(CdbClass, db, {}).ready;
        expect(vectorOrganizationDeletionGuardCount(db)).toBe(2);
        expect(() =>
            store.stageUpsert({
                vectorId: `vec1_${"e".repeat(64)}`,
                organizationId,
                resourceId: cdbVectorResourceId(resource),
                rowPk: "late-row",
                dimensions: 3,
                values: [0, 1, 0],
                metadata: {},
                nowMs: 3,
            })
        ).toThrow(/vector organization was deleted/);
    });

    test("keeps vector mutation triggers installed for an unbound destination abort tombstone", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const configured = construct(
            configureCdbRuntime({ schema: () => f.schema, manifest: () => manifestFromExports({}) }),
            db,
            {}
        );
        await configured.ready;
        const range = Number(vshardOf(["org-1"]));
        const schema = db
            .query("SELECT active_version, active_epoch, active_digest FROM _chardb_schema_state WHERE singleton = 1")
            .get() as { active_version: number; active_epoch: number; active_digest: string };
        const args = {
            migId: "unbound-vector-dest-abort",
            rangeLo: range,
            rangeHi: range,
            destinationGeneration: 2,
        };

        expect(configured.cdb.prepareReshardDestOwnership(args)).toEqual({ prepared: true, serving: false });
        await expect(
            configured.cdb.beginReshardDestAbort({
                ...args,
                schemaVersion: schema.active_version,
                schemaEpoch: schema.active_epoch,
                schemaDigest: schema.active_digest,
                tables: [],
            })
        ).resolves.toEqual({ started: true });
        expect(vectorMutationTriggerCount(db)).toBe(5);
        expect(
            db
                .query(
                    `SELECT abort_started, drained FROM _chardb_split_state
                     WHERE mig_id = 'unbound-vector-dest-abort'`
                )
                .get()
        ).toEqual({ abort_started: 1, drained: 1 });
    });

    test("commits row, head, outbox and exact Vectorize delivery as one organization flow", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const calls: Array<{ operation: string; ids: string[] }> = [];
        const index = {
            upsert(records: readonly { id: string }[]) {
                calls.push({ operation: "upsert", ids: records.map(record => record.id) });
                return { count: records.length, ids: records.map(record => record.id) };
            },
            deleteByIds(ids: readonly string[]) {
                calls.push({ operation: "delete", ids: [...ids] });
                return { count: ids.length, ids: [...ids] };
            },
            getByIds: () => [],
        };
        const configured = construct(
            configureCdbRuntime({ schema: () => f.schema, manifest: () => manifestFromExports(f) }),
            db,
            index
        );
        await configured.ready;
        const request = {
            principalId: "user-1",
            auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
            schemaEpoch: 1,
            domainSchemaEpoch: 1,
            placement: { authority: "organization" as const, partitionKey: "org-1" },
        };
        const inserted = await configured.cdb.mutate({
            ...request,
            mutId: "vector-put-1",
            ref: f.put.__chardbRef,
            args: { organizationId: "org-1", id: "message-1", body: "hello", values: [0.25, -0.5, 1] },
        });
        expect(inserted).toMatchObject({ ok: true, ran: true });
        expect(calls).toHaveLength(0);
        expect(db.query("SELECT state, version, delivered_version FROM _chardb_vectors").get()).toEqual({
            state: "pending",
            version: 1,
            delivered_version: 0,
        });
        await configured.cdb.alarm();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.operation).toBe("upsert");
        expect(db.query("SELECT state, version, delivered_version FROM _chardb_vectors").get()).toEqual({
            state: "ready",
            version: 1,
            delivered_version: 1,
        });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vector_outbox").get()).toEqual({ count: 0 });
        expect(() => f.escaped()?.vector.set(f.messages.embedding, "message-1", [1, 1, 1])).toThrow(
            /escaped its SQLite transaction/
        );

        const resourceId = (db.query("SELECT resource_id FROM _chardb_vectors").get() as { resource_id: string })
            .resource_id;
        db.run(
            `INSERT INTO _chardb_live_subscriptions
               (gateway_id, registration_id, connection_id, client_id, sub_id, state, payload_hash,
                principal_id, organization_id, authority, schema_epoch, vshard, domain_schema_epoch,
                ref, args_json, policy_digest, query_hash, tables_json, intervals_json)
             VALUES ('gateway-vector', 'registration-vector', 'connection-vector', 'client-vector', 1, 'active',
                     'payload', 'user-1', 'org-1', 'organization', 1, ?, 1, 'vector-query', '{}',
                     'policy', 'query', '[]', '[]')`,
            [Number(vshardOf(["org-1"]))]
        );
        db.run(
            `INSERT INTO _chardb_live_subscription_vectors (gateway_id, registration_id, resource_id)
             VALUES ('gateway-vector', 'registration-vector', ?)`,
            [resourceId]
        );

        expect(
            await configured.cdb.mutate({
                ...request,
                mutId: "vector-update-1",
                ref: f.update.__chardbRef,
                args: { organizationId: "org-1", id: "message-1", values: [1, 0.5, -0.25] },
            })
        ).toMatchObject({ ok: true, ran: true });
        expect(calls.map(call => call.operation)).toEqual(["upsert"]);
        await configured.cdb.alarm();
        expect(calls.map(call => call.operation)).toEqual(["upsert", "upsert"]);
        expect(db.query("SELECT state, version, delivered_version FROM _chardb_vectors").get()).toEqual({
            state: "ready",
            version: 2,
            delivered_version: 2,
        });
        const changeSeq = (
            db.query("SELECT change_seq FROM _chardb_change_clock WHERE singleton = 1").get() as {
                change_seq: number;
            }
        ).change_seq;
        expect(changeSeq).toBeGreaterThanOrEqual(2);
        expect(
            db
                .query(
                    `SELECT registration_id, change_seq FROM _chardb_invalidation_outbox
                     WHERE gateway_id = 'gateway-vector'`
                )
                .get()
        ).toEqual({ registration_id: "registration-vector", change_seq: changeSeq });
        expect(
            await configured.cdb.mutate({
                ...request,
                mutId: "vector-move-1",
                ref: f.move.__chardbRef,
                args: { organizationId: "org-1", id: "message-1", nextId: "message-2" },
            })
        ).toMatchObject({ ok: false });
        expect(db.query("SELECT id FROM delivered_vector_messages").get()).toEqual({ id: "message-1" });
        expect(db.query("SELECT row_pk FROM _chardb_vectors").get()).toEqual({ row_pk: "message-1" });

        expect(
            await configured.cdb.mutate({
                ...request,
                mutId: "vector-delete-1",
                ref: f.remove.__chardbRef,
                args: { organizationId: "org-1", id: "message-1" },
            })
        ).toMatchObject({ ok: true, ran: true });
        expect(calls.map(call => call.operation)).toEqual(["upsert", "upsert"]);
        expect(db.query("SELECT state FROM _chardb_vectors").get()).toEqual({ state: "deleting" });
    });

    test("fences a deleted organization, removes its remote vector, and reconstructs around the retired locator", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const calls: string[] = [];
        const index = {
            upsert(records: readonly { id: string }[]) {
                calls.push("upsert");
                return { count: records.length, ids: records.map(record => record.id) };
            },
            deleteByIds(ids: readonly string[]) {
                calls.push("delete");
                return { count: ids.length, ids: [...ids] };
            },
            getByIds: () => [],
        };
        const CdbClass = configureCdbRuntime({
            schema: () => f.schema,
            manifest: () => manifestFromExports({ put: f.put }),
        });
        const configured = construct(CdbClass, db, index);
        await configured.ready;
        const request = {
            principalId: "user-delete",
            auth: {
                userId: "user-delete",
                tenantId: "org-delete",
                role: "member",
                roles: ["member"],
                claims: {},
            },
            schemaEpoch: 1,
            domainSchemaEpoch: 1,
            placement: { authority: "organization" as const, partitionKey: "org-delete" },
        };
        expect(
            await configured.cdb.mutate({
                ...request,
                mutId: "organization-delete-put",
                ref: f.put.__chardbRef,
                args: { organizationId: "org-delete", id: "retired-row", body: "retire", values: [1, 0, 0] },
            })
        ).toMatchObject({ ok: true, ran: true });
        await configured.cdb.alarm();
        expect(calls).toEqual(["upsert"]);

        db.run("UPDATE _chardb_vector_capacity SET outbox_rows = ?", [CDB_VECTOR_MAX_OUTBOX_ROWS]);
        await expect(
            configured.cdb.deleteOrganizationFiles({
                organizationId: "org-delete",
                nowMs: 99,
                domainSchemaEpoch: 1,
            })
        ).rejects.toThrow(/outbox exceeds/);
        expect(db.query("SELECT organization_id FROM _chardb_deleted_organizations").get()).toBeNull();
        expect(db.query("SELECT state, version FROM _chardb_vectors").get()).toEqual({
            state: "ready",
            version: 1,
        });
        db.run("UPDATE _chardb_vector_capacity SET outbox_rows = 0");

        await expect(
            configured.cdb.deleteOrganizationFiles({
                organizationId: "org-delete",
                nowMs: 100,
                domainSchemaEpoch: 1,
            })
        ).resolves.toEqual({ organizationId: "org-delete", accepted: true });
        expect(db.query("SELECT state, version FROM _chardb_vectors").get()).toEqual({
            state: "deleting",
            version: 2,
        });
        expect(db.query("SELECT organization_id FROM _chardb_deleted_organizations").get()).toEqual({
            organization_id: "org-delete",
        });
        expect(
            await configured.cdb.mutate({
                ...request,
                mutId: "organization-delete-late-put",
                ref: f.put.__chardbRef,
                args: { organizationId: "org-delete", id: "late-row", body: "late", values: [0, 1, 0] },
            })
        ).toMatchObject({ ok: false, error: { code: "CDB_FORBIDDEN" } });

        db.run("UPDATE _chardb_vector_attempts SET settle_after = first_sent_at");
        await configured.cdb.alarm();
        expect(calls).toEqual(["upsert", "delete"]);
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vectors").get()).toEqual({ count: 0 });
        expect(db.query("SELECT embedding FROM delivered_vector_messages").get()).toEqual({
            embedding: expect.any(String),
        });

        const restarted = construct(CdbClass, db, index);
        await expect(restarted.ready).resolves.toBeUndefined();
    });

    test("continues a 501-head organization deletion from the bounded alarm page", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const configured = construct(
            configureCdbRuntime({ schema: () => f.schema, manifest: () => manifestFromExports({}) }),
            db,
            { upsert: () => ({ count: 0, ids: [] }), deleteByIds: () => ({ count: 0, ids: [] }), getByIds: () => [] }
        );
        await configured.ready;
        const resource = collectSchemaResourceDescriptors(f.schema).find(item => item.kind === "vector");
        if (!resource || resource.kind !== "vector") throw new Error("vector resource fixture is missing");
        const store = new CdbVectorOutboxStore(adaptSqlStorage(sqlStorage(db) as never));
        const resourceId = cdbVectorResourceId(resource);
        for (let index = 1; index <= 501; index++) {
            const vectorId = `vec1_${index.toString(16).padStart(64, "0")}`;
            store.stageUpsert({
                vectorId,
                organizationId: "org-page",
                resourceId,
                rowPk: `row-${index}`,
                dimensions: 3,
                values: [1, 0, 0],
                metadata: {},
                nowMs: index,
            });
            db.run(
                `INSERT INTO delivered_vector_messages (id, organization_id, body, embedding)
                 VALUES (?, 'org-page', 'page', ?)`,
                [`row-${index}`, vectorId]
            );
        }

        await configured.cdb.deleteOrganizationFiles({
            organizationId: "org-page",
            nowMs: 1_000,
            domainSchemaEpoch: 1,
        });
        expect(
            db.query("SELECT state, COUNT(*) AS count FROM _chardb_vectors GROUP BY state ORDER BY state").all()
        ).toEqual([
            { state: "deleting", count: 500 },
            { state: "pending", count: 1 },
        ]);

        await configured.cdb.alarm();
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vectors WHERE state != 'deleting'").get()).toEqual({
            count: 0,
        });
        expect(
            db
                .query(
                    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_chardb_vector_organization_deletions'"
                )
                .get()
        ).toBeNull();
        const versionsBeforeRetry = db.query("SELECT vector_id, version FROM _chardb_vectors ORDER BY vector_id").all();
        await expect(
            configured.cdb.deleteOrganizationFiles({
                organizationId: "org-page",
                nowMs: 2_000,
                domainSchemaEpoch: 1,
            })
        ).resolves.toEqual({ organizationId: "org-page", accepted: true });
        expect(db.query("SELECT vector_id, version FROM _chardb_vectors ORDER BY vector_id").all()).toEqual(
            versionsBeforeRetry
        );
    });

    test("returns a staged mutation before held Vectorize delivery and lets the alarm finish it", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        let releaseDelivery: (() => void) | undefined;
        let markDeliveryStarted: (() => void) | undefined;
        const deliveryGate = new Promise<void>(resolve => {
            releaseDelivery = resolve;
        });
        const deliveryStarted = new Promise<void>(resolve => {
            markDeliveryStarted = resolve;
        });
        const configured = construct(
            configureCdbRuntime({ schema: () => f.schema, manifest: () => manifestFromExports({ put: f.put }) }),
            db,
            {
                async upsert(records: readonly { id: string }[]) {
                    markDeliveryStarted?.();
                    await deliveryGate;
                    return { count: records.length, ids: records.map(record => record.id) };
                },
                deleteByIds: () => ({ count: 0, ids: [] }),
                getByIds: () => [],
            }
        );
        await configured.ready;

        await expect(
            configured.cdb.mutate({
                principalId: "user-1",
                mutId: "vector-held-delivery-1",
                ref: f.put.__chardbRef,
                args: { organizationId: "org-1", id: "message-held", body: "held", values: [1, 0, 0] },
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
                placement: { authority: "organization", partitionKey: "org-1" },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).resolves.toMatchObject({ ok: true, ran: true });
        expect(db.query("SELECT state, delivered_version FROM _chardb_vectors").get()).toEqual({
            state: "pending",
            delivered_version: 0,
        });

        let alarmSettled = false;
        const alarm = configured.cdb.alarm().then(() => {
            alarmSettled = true;
        });
        await deliveryStarted;
        expect(alarmSettled).toBe(false);
        releaseDelivery?.();
        await alarm;

        expect(db.query("SELECT state, version, delivered_version FROM _chardb_vectors").get()).toEqual({
            state: "ready",
            version: 1,
            delivered_version: 1,
        });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vector_outbox").get()).toEqual({ count: 0 });
    });

    test("rearms vector work after Cloudflare consumes the alarm that started its handler", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const nowMs = 1_000;
        const ConfiguredCdb = configureCdbRuntime({
            schema: () => f.schema,
            manifest: () => manifestFromExports({ put: f.put }),
        });
        class FixedClockCdb extends ConfiguredCdb {
            protected override invalidationNowMs(): number {
                return nowMs;
            }
        }
        const configured = construct(FixedClockCdb, db, {
            upsert: () => ({ mutationId: "vector-rearm-accepted" }),
            deleteByIds: () => ({ mutationId: "unused" }),
            getByIds: () => [],
        });
        await configured.ready;

        await expect(
            configured.cdb.mutate({
                principalId: "user-1",
                mutId: "vector-rearm-1",
                ref: f.put.__chardbRef,
                args: { organizationId: "org-1", id: "message-rearm", body: "rearm", values: [1, 0, 0] },
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
                placement: { authority: "organization", partitionKey: "org-1" },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).resolves.toMatchObject({ ok: true, ran: true });
        expect(configured.alarm()).toBe(1_001);

        configured.consumeAlarm();
        await configured.cdb.alarm();

        expect(db.query("SELECT phase, next_attempt_at FROM _chardb_vector_outbox").get()).toEqual({
            phase: "verify",
            next_attempt_at: 2_000,
        });
        expect(configured.alarm()).toBe(2_000);
    });

    test("rolls back unstaged domain pointers and staged orphan heads", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const configured = construct(
            configureCdbRuntime({
                schema: () => f.schema,
                manifest: () => manifestFromExports({ bypass: f.bypass }),
            }),
            db,
            {
                upsert: () => ({ mutationId: "unused" }),
                deleteByIds: () => ({ mutationId: "unused" }),
                getByIds: () => [],
            }
        );
        await configured.ready;
        const result = await configured.cdb.mutate({
            principalId: "user-1",
            mutId: "vector-bypass-1",
            ref: f.bypass.__chardbRef,
            args: { organizationId: "org-1", id: "message-1" },
            auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
            placement: { authority: "organization", partitionKey: "org-1" },
            schemaEpoch: 1,
            domainSchemaEpoch: 1,
        });
        expect(result).toMatchObject({ ok: false });
        expect(db.query("SELECT COUNT(*) AS count FROM delivered_vector_messages").get()).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM _chardb_vectors").get()).toEqual({ count: 0 });
    });

    test("keeps claimed delivery closed after the source range fence activates", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const configured = construct(
            configureCdbRuntime({ schema: () => f.schema, manifest: () => manifestFromExports({ put: f.put }) }),
            db,
            {}
        );
        await configured.ready;
        expect(
            await configured.cdb.mutate({
                principalId: "user-1",
                mutId: "vector-fenced-1",
                ref: f.put.__chardbRef,
                args: { organizationId: "org-1", id: "message-1", body: "hello", values: [1, 2, 3] },
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
                placement: { authority: "organization", partitionKey: "org-1" },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).toMatchObject({ ok: true, ran: true });
        const vshard = Number(vshardOf(["org-1"]));
        const fence = {
            migrationId: "vector-source-fence",
            rangeLo: vshard,
            rangeHi: vshard,
            sourceGeneration: 1,
            destinationGeneration: 2,
        };
        configured.cdb.prepareRoutingFence(fence);
        await configured.cdb.activateRoutingFence(fence);
        db.run("UPDATE _chardb_vector_outbox SET next_attempt_at = 0, leased_until = NULL, lease_token = NULL");
        await expect(configured.cdb.alarm()).resolves.toBeUndefined();
        expect(db.query("SELECT state, delivered_version FROM _chardb_vectors").get()).toEqual({
            state: "pending",
            delivered_version: 0,
        });
    });

    test("keeps destination delivery admission closed until serving state is drained", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        const configured = construct(
            configureCdbRuntime({ schema: () => f.schema, manifest: () => manifestFromExports({ put: f.put }) }),
            db,
            {}
        );
        await configured.ready;
        const storage = {
            sql: sqlStorage(db),
            transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
        } as unknown as DurableObjectStorage;
        const admission = () =>
            new CdbReshardRuntime({
                storage,
                schemaMigrations: {} as never,
                schema: () => ({}),
                journal: () => ({}) as never,
                invalidationNowMs: () => 0,
                scheduleAlarmNoLaterThan: async () => {},
            });
        const vshard = Number(vshardOf(["org-1"]));
        db.run(
            `INSERT INTO _chardb_split_state
               (mig_id, range_lo, range_hi, role, destination_generation, destination_serving, updated_at)
             VALUES ('vector-destination-admission', ?, ?, 'dest', 2, 1, 1)`,
            [vshard, vshard]
        );

        expect(() => admission().assertBackgroundDeliveryAdmission(vshard)).toThrow(
            /requires one drained, serving destination owner/
        );
        db.run("UPDATE _chardb_split_state SET drained = 1 WHERE mig_id = 'vector-destination-admission'");
        expect(() => admission().assertBackgroundDeliveryAdmission(vshard)).not.toThrow();
    });

    test("rejects a Vectorize binding inherited from the environment prototype", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        const f = fixture();
        let calls = 0;
        const inherited = Object.create({
            CDB_MESSAGES: {
                upsert: () => {
                    calls++;
                    return { mutationId: "forged" };
                },
                deleteByIds: () => ({ mutationId: "forged" }),
                getByIds: () => [],
            },
        }) as object;
        const configured = construct(
            configureCdbRuntime({ schema: () => f.schema, manifest: () => manifestFromExports({ put: f.put }) }),
            db,
            inherited
        );
        await configured.ready;
        expect(
            await configured.cdb.mutate({
                principalId: "user-1",
                mutId: "vector-forged-env-1",
                ref: f.put.__chardbRef,
                args: { organizationId: "org-1", id: "message-1", body: "hello", values: [1, 2, 3] },
                auth: { userId: "user-1", tenantId: "org-1", role: "member", roles: ["member"], claims: {} },
                placement: { authority: "organization", partitionKey: "org-1" },
                schemaEpoch: 1,
                domainSchemaEpoch: 1,
            })
        ).toMatchObject({ ok: true, ran: true });
        expect(calls).toBe(0);
        expect(db.query("SELECT state, delivered_version FROM _chardb_vectors").get()).toEqual({
            state: "pending",
            delivered_version: 0,
        });
    });
});
