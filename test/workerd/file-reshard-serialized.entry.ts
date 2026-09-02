import { FileId } from "../../src/files/index.ts";
import type { TableSpec } from "../../src/reshard/triggers.ts";
import { vshardOf } from "../../src/vshard.ts";
import baseWorker, { Catalog, Cdb, DB, Resharder } from "./file-reshard-e2e.entry.ts";

export { Catalog, Cdb, DB, Resharder };

const SOURCE = "ShardDO_0";
const TABLES = Object.freeze([
    {
        name: "file_move_documents",
        partitionColumn: "organization_id",
        columns: ["id", "organization_id", "attachment"],
    },
]) satisfies readonly TableSpec[];

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_RESHARD: DurableObjectNamespace;
    readonly CDB_FILES: R2Bucket;
}

interface Route {
    readonly shardId: string;
    readonly schemaEpoch: number;
    readonly domainSchemaEpoch: number;
    readonly recoveryGeneration: number;
}

interface CatalogRpc {
    mutateAuth(args: Record<string, unknown>, _recoveryGeneration: number): Promise<unknown>;
    route(vshard: number): Promise<Route>;
}

interface CdbRpc {
    fixtureSeedFile(input: {
        organizationId: string;
        rowId: string;
        fileId: string;
        schemaEpoch: number;
        domainSchemaEpoch: number;
        recoveryGeneration: number;
        body: string;
    }): Promise<Record<string, unknown>>;
    fixtureState(input: { organizationIds: readonly string[]; migId: string }): Promise<Record<string, unknown>>;
    resolveFileDownload(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

interface ResharderRpc {
    startSplit(args: {
        migId: string;
        srcShard: string;
        dstShard: string;
        rangeLo: number;
        rangeHi: number;
        epochAtStart: number;
        tables: readonly TableSpec[];
    }): Promise<void>;
}

function placement(organizationId: string): number {
    return Number(vshardOf([organizationId]));
}

function catalog(env: Env): CatalogRpc {
    return env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogRpc;
}

function cdb(env: Env, shardId: string): CdbRpc {
    return env.CDB_SHARD.get(env.CDB_SHARD.idFromName(shardId)) as unknown as CdbRpc;
}

function resharder(env: Env): ResharderRpc {
    return env.CDB_RESHARD.get(env.CDB_RESHARD.idFromName("global")) as unknown as ResharderRpc;
}

function fileAuth(organizationId: string) {
    return {
        userId: "serialized-e2e-user",
        tenantId: organizationId,
        role: "member",
        roles: ["member"],
        authEpochs: { global: 1, tenant: 1, principal: 1 },
        claims: {},
    };
}

function errorMessage(error: unknown): string {
    if (error && typeof error === "object" && "code" in error) {
        return `${String(error.code)}: ${error instanceof Error ? error.message : String(error)}`;
    }
    return error instanceof Error ? error.message : String(error);
}

async function prepareOrganizations(
    env: Env,
    input: { readonly organizationIds: readonly string[]; readonly label: string }
): Promise<Record<string, unknown>> {
    if (input.organizationIds.length < 1 || input.organizationIds.length > 8) {
        throw new Error("prepared organization count is out of bounds");
    }
    const targetPlacement = placement(input.organizationIds[0] ?? "");
    if (input.organizationIds.some(organizationId => placement(organizationId) !== targetPlacement)) {
        throw new Error("prepared organizations must colocate");
    }
    const cat = catalog(env);
    const route = await cat.route(targetPlacement);
    if (route.shardId !== SOURCE) throw new Error(`prepared range is owned by ${route.shardId}`);
    const seeded = [];
    for (const [index, organizationId] of input.organizationIds.entries()) {
        await cat.mutateAuth(
            {
                model: "organization",
                op: "create",
                payload: {
                    id: organizationId,
                    name: organizationId,
                    slug: organizationId,
                    createdAt: Date.now(),
                },
            },
            route.recoveryGeneration
        );
        const hex = `${targetPlacement.toString(16)}${input.label.length.toString(16)}${index.toString(16)}`
            .padEnd(64, String((index % 9) + 1))
            .slice(0, 64);
        seeded.push(
            await cdb(env, route.shardId).fixtureSeedFile({
                organizationId,
                rowId: `row-${input.label}-${index}`,
                fileId: `fil_${hex}`,
                schemaEpoch: route.schemaEpoch,
                domainSchemaEpoch: route.domainSchemaEpoch,
                recoveryGeneration: route.recoveryGeneration,
                body: `prepared-${input.label}-${index}`,
            })
        );
    }
    return { placement: targetPlacement, route, seeded };
}

async function startPreparedMove(
    env: Env,
    input: { readonly migId: string; readonly destination: string; readonly organizationId: string }
): Promise<Record<string, unknown>> {
    const range = placement(input.organizationId);
    const route = await catalog(env).route(range);
    await resharder(env).startSplit({
        migId: input.migId,
        srcShard: route.shardId,
        dstShard: input.destination,
        rangeLo: range,
        rangeHi: range,
        epochAtStart: route.schemaEpoch,
        tables: TABLES,
    });
    return { route, placement: range };
}

async function unrelatedTraffic(
    env: Env,
    input: { readonly organizationId: string; readonly sequence: number }
): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence > 1_000) {
        throw new Error("traffic sequence is invalid");
    }
    const route = await catalog(env).route(placement(input.organizationId));
    const hex = `${placement(input.organizationId).toString(16)}${input.sequence.toString(16).padStart(8, "0")}`
        .padEnd(64, "d")
        .slice(0, 64);
    const fileId = FileId(`fil_${hex}`);
    const rowId = `row-unrelated-${input.sequence}`;
    const shard = cdb(env, route.shardId);
    const seeded = await shard.fixtureSeedFile({
        organizationId: input.organizationId,
        rowId,
        fileId,
        schemaEpoch: route.schemaEpoch,
        domainSchemaEpoch: route.domainSchemaEpoch,
        recoveryGeneration: route.recoveryGeneration,
        body: `unrelated-${input.sequence}`,
    });
    const resolved = await shard.resolveFileDownload({
        organizationId: input.organizationId,
        table: "file_move_documents",
        column: "attachment",
        rowId,
        recoveryGeneration: route.recoveryGeneration,
        schemaEpoch: route.schemaEpoch,
        domainSchemaEpoch: route.domainSchemaEpoch,
        auth: fileAuth(input.organizationId),
    });
    if (!resolved || resolved.fileId !== fileId) throw new Error("unrelated file query did not read its own write");
    return { route, seeded, resolved };
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const operation = new URL(request.url).pathname.slice(1);
        if (!["prepareOrganizations", "startPreparedMove", "unrelatedTraffic", "shardState"].includes(operation)) {
            return baseWorker.fetch(request, env);
        }
        const body = (await request.json()) as Record<string, unknown>;
        try {
            if (operation === "prepareOrganizations") {
                return Response.json(
                    await prepareOrganizations(env, {
                        organizationIds: body.organizationIds as string[],
                        label: String(body.label),
                    })
                );
            }
            if (operation === "startPreparedMove") {
                return Response.json(
                    await startPreparedMove(env, {
                        migId: String(body.migId),
                        destination: String(body.destination),
                        organizationId: String(body.organizationId),
                    })
                );
            }
            if (operation === "unrelatedTraffic") {
                return Response.json(
                    await unrelatedTraffic(env, {
                        organizationId: String(body.organizationId),
                        sequence: Number(body.sequence),
                    })
                );
            }
            return Response.json(
                await cdb(env, String(body.shardId)).fixtureState({
                    organizationIds: body.organizationIds as string[],
                    migId: String(body.migId),
                })
            );
        } catch (error) {
            return Response.json({ error: errorMessage(error) }, { status: 500 });
        }
    },
};
