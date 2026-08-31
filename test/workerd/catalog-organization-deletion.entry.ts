import { DurableObject } from "cloudflare:workers";
import { organization } from "better-auth/plugins/organization";
import { text } from "drizzle-orm/sqlite-core";
import { bindAuthRuntime } from "../../src/auth/runtime.ts";
import { defineAuth, synthesizeAuthSchema } from "../../src/auth/synthesize.ts";
import { file } from "../../src/files/index.ts";
import { forOrg } from "../../src/server/cdb-tenant.ts";
import { CatalogOrganizationDeletionBarrierStore } from "../../src/server/do/catalog-organization-deletion-barrier-store.ts";
import { CatalogOrganizationDeletionStore } from "../../src/server/do/catalog-organization-deletion-store.ts";
import { configureCatalogRuntime } from "../../src/server/do/catalog.ts";
import { adaptSqlStorage } from "../../src/server/do/sql_adapter.ts";
import { defineMigrations, defineSchemaBaseline } from "../../src/server/schema-migrations.ts";
import { vector } from "../../src/vector.ts";
import { vshardOf } from "../../src/vshard.ts";

const auth = defineAuth({ appName: "catalog-organization-deletion-workerd", plugins: [organization()] });
bindAuthRuntime({
    schema: synthesizeAuthSchema(auth.options as never) as never,
    options: auth.options as { readonly [key: string]: unknown },
});

const { cdbTable } = forOrg();
const documents = cdbTable(
    "deletion_documents",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        attachment: file("attachment", { maxSize: 8, contentTypes: ["image/png"] }),
    },
    { roles: { member: { read: "*" } } }
);
const journal = defineMigrations([
    defineSchemaBaseline({
        version: 1,
        name: "organization_deletion_files",
        domainSchema: { documents },
        authOptions: auth.options,
    }),
]);
const ConfiguredCatalog = configureCatalogRuntime({ migrations: () => journal });

const vectorDocuments = cdbTable(
    "deletion_vector_documents",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => auth.organization.id),
        embedding: vector("embedding", { dim: 3, binding: "CDB_VECTOR", metric: "cosine" }),
    },
    { roles: { member: { read: "*" } } }
);
const vectorJournal = defineMigrations([
    defineSchemaBaseline({
        version: 1,
        name: "organization_deletion_vectors",
        domainSchema: { vectorDocuments },
        authOptions: auth.options,
    }),
]);
const ConfiguredVectorCatalog = configureCatalogRuntime({ migrations: () => vectorJournal });

interface Env {
    readonly CATALOG: DurableObjectNamespace;
    readonly VECTOR_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
}

export class CdbProbe extends DurableObject<Record<string, never>> {
    constructor(state: DurableObjectState, env: Record<string, never>) {
        super(state, env);
        state.blockConcurrencyWhile(async () => {
            this.ctx.storage.sql.exec(
                "CREATE TABLE IF NOT EXISTS probe_state (singleton INTEGER PRIMARY KEY, failing INTEGER NOT NULL, calls INTEGER NOT NULL, failed_calls INTEGER NOT NULL, successful_calls INTEGER NOT NULL, auth_calls INTEGER NOT NULL)"
            );
            this.ctx.storage.sql.exec(
                "INSERT OR IGNORE INTO probe_state (singleton, failing, calls, failed_calls, successful_calls, auth_calls) VALUES (1, 0, 0, 0, 0, 0)"
            );
        });
    }

    async prepareSchemaMigration(): Promise<{ readonly ok: true }> {
        return { ok: true };
    }

    async applySchemaMigration(): Promise<{ readonly ok: true }> {
        return { ok: true };
    }

    async activateSchemaMigration(): Promise<{ readonly ok: true }> {
        return { ok: true };
    }

    async deleteOrganizationFiles(input: {
        readonly organizationId: string;
    }): Promise<{ readonly organizationId: string; readonly accepted: true }> {
        this.ctx.storage.sql.exec("UPDATE probe_state SET calls = calls + 1 WHERE singleton = 1");
        const state = adaptSqlStorage(this.ctx.storage.sql).one<{ failing: number; calls: number }>(
            "SELECT failing, calls FROM probe_state WHERE singleton = 1"
        );
        if (state?.failing === 1) {
            this.ctx.storage.sql.exec("UPDATE probe_state SET failed_calls = failed_calls + 1 WHERE singleton = 1");
            throw new Error("injected native shard outage");
        }
        this.ctx.storage.sql.exec("UPDATE probe_state SET successful_calls = successful_calls + 1 WHERE singleton = 1");
        return { organizationId: input.organizationId, accepted: true };
    }

    invalidateAuthScope(input: {
        readonly scope: "global" | "tenant" | "principal";
        readonly scopeId: string;
        readonly epoch: number;
    }): Record<string, unknown> {
        this.ctx.storage.sql.exec("UPDATE probe_state SET auth_calls = auth_calls + 1 WHERE singleton = 1");
        return { ...input, accepted: true, registrations: 0, changeSeq: 0 };
    }

    fixtureSetFailure(input: { readonly failing: boolean }): void {
        this.ctx.storage.sql.exec("UPDATE probe_state SET failing = ? WHERE singleton = 1", input.failing ? 1 : 0);
    }

    fixtureState(): Record<string, unknown> {
        return (
            adaptSqlStorage(this.ctx.storage.sql).one<{
                failing: number;
                calls: number;
                failed_calls: number;
                successful_calls: number;
                auth_calls: number;
            }>(
                "SELECT failing, calls, failed_calls, successful_calls, auth_calls FROM probe_state WHERE singleton = 1"
            ) ?? {}
        );
    }
}

export class Catalog extends ConfiguredCatalog {
    private readonly fixtureId = crypto.randomUUID();

    fixtureConfigureShards(input: { readonly count: number }): void {
        if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 64) throw new Error("invalid count");
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        this.ctx.storage.transactionSync(() => {
            sql.exec("DELETE FROM catalog_ranges");
            for (let index = 0; index < input.count; index++) {
                sql.exec(
                    "INSERT INTO catalog_ranges (lo, hi, shard_id) VALUES (?, ?, ?)",
                    index,
                    index === input.count - 1 ? 16_383 : index,
                    `ShardDO_${String(index).padStart(2, "0")}`
                );
            }
        });
    }

    async fixtureActivate(): Promise<unknown> {
        const migrationId = "organization-deletion-v1";
        this.beginSchemaMigration({ migrationId, targetVersion: 1 });
        for (const shardId of await this.listShardIds()) {
            await this.migrateSchemaShard({ migrationId, shardId });
        }
        this.applyCatalogSchemaMigration({ migrationId, version: 1 });
        return this.completeSchemaMigration({ migrationId });
    }

    fixtureBeginDeletionBarrier(input: { readonly migrationId: string; readonly organizationId: string }): void {
        const vshard = Number(vshardOf([input.organizationId]));
        this.ctx.storage.transactionSync(() => {
            new CatalogOrganizationDeletionBarrierStore(adaptSqlStorage(this.ctx.storage.sql)).begin(
                { migrationId: input.migrationId, rangeLo: vshard, rangeHi: vshard },
                Date.now()
            );
        });
    }

    fixtureAbortDeletionBarrier(input: { readonly migrationId: string; readonly organizationId: string }): void {
        const vshard = Number(vshardOf([input.organizationId]));
        this.ctx.storage.transactionSync(() => {
            new CatalogOrganizationDeletionBarrierStore(adaptSqlStorage(this.ctx.storage.sql)).abort(
                { migrationId: input.migrationId, rangeLo: vshard, rangeHi: vshard },
                Date.now()
            );
        });
    }

    fixtureMakeShardDue(input: { readonly organizationId: string; readonly shardId: string }): void {
        adaptSqlStorage(this.ctx.storage.sql).exec(
            `UPDATE catalog_organization_deletion_shards
             SET next_attempt_at = 0
             WHERE organization_id = ? AND shard_id = ? AND status = 'pending'`,
            input.organizationId,
            input.shardId
        );
    }

    fixtureRunAlarm(): Promise<void> {
        return super.alarm();
    }

    async fixtureClearAlarm(): Promise<void> {
        await this.ctx.storage.deleteAlarm();
    }

    async fixtureState(input: { readonly organizationId: string }): Promise<Record<string, unknown>> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const store = new CatalogOrganizationDeletionStore(sql);
        return {
            instanceId: this.fixtureId,
            organizationPresent:
                sql.one<{ present: number }>(
                    "SELECT 1 AS present FROM organization WHERE id = ?",
                    input.organizationId
                ) !== null,
            deletion: store.read(input.organizationId),
            shards: store.shards(input.organizationId),
            alarm: await this.ctx.storage.getAlarm(),
        };
    }
}

export class VectorCatalog extends ConfiguredVectorCatalog {
    async fixtureActivate(): Promise<unknown> {
        const migrationId = "organization-deletion-vector-v1";
        this.beginSchemaMigration({ migrationId, targetVersion: 1 });
        for (const shardId of await this.listShardIds()) {
            await this.migrateSchemaShard({ migrationId, shardId });
        }
        this.applyCatalogSchemaMigration({ migrationId, version: 1 });
        return this.completeSchemaMigration({ migrationId });
    }

    fixtureRunAlarm(): Promise<void> {
        return super.alarm();
    }

    async fixtureState(input: { readonly organizationId: string }): Promise<Record<string, unknown>> {
        const sql = adaptSqlStorage(this.ctx.storage.sql);
        const store = new CatalogOrganizationDeletionStore(sql);
        return {
            organizationPresent:
                sql.one<{ present: number }>(
                    "SELECT 1 AS present FROM organization WHERE id = ?",
                    input.organizationId
                ) !== null,
            deletion: store.read(input.organizationId),
            shards: store.shards(input.organizationId),
            alarm: await this.ctx.storage.getAlarm(),
        };
    }
}

type Operation =
    | "fixtureConfigureShards"
    | "fixtureActivate"
    | "fixtureBeginDeletionBarrier"
    | "fixtureAbortDeletionBarrier"
    | "fixtureMakeShardDue"
    | "fixtureClearAlarm"
    | "fixtureRunAlarm"
    | "fixtureState"
    | "mutateAuth"
    | "probeFailure"
    | "probeState";

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const requestedOperation = new URL(request.url).pathname.slice(1);
        const vectorRequest = requestedOperation.startsWith("vector/");
        const operation = (
            vectorRequest ? requestedOperation.slice("vector/".length) : requestedOperation
        ) as Operation;
        const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
        if (operation === "probeFailure" || operation === "probeState") {
            const shardId = String(body.shardId);
            const probe = env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as {
                fixtureSetFailure(input: unknown): Promise<void>;
                fixtureState(): Promise<unknown>;
            };
            const result =
                operation === "probeFailure"
                    ? await probe.fixtureSetFailure({ failing: body.failing === true })
                    : await probe.fixtureState();
            return Response.json(result ?? { ok: true });
        }
        const namespace = vectorRequest ? env.VECTOR_CATALOG : env.CATALOG;
        const stub = namespace.get(namespace.idFromName("global")) as unknown as Record<
            Operation,
            (input?: unknown) => Promise<unknown>
        >;
        if (typeof stub[operation] !== "function") return new Response("not found", { status: 404 });
        try {
            return Response.json((await stub[operation](body)) ?? { ok: true });
        } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
    },
};
