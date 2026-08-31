import { CdbError } from "../errors.ts";
import type { TableSpec } from "../reshard/triggers.ts";
import { adminJsonError, authorizeAdmin, exactAdminObject, readAdminBody } from "./admin-http.ts";
import type { CatalogTopologyOperation } from "./do/catalog-topology-operation-store.ts";
import { packagedReshardTableSpecs } from "./do/cdb-reshard-identity-store.ts";
import { RESHARDER_PHASE } from "./do/resharder.ts";

export interface ReshardAdminEnv {
    readonly CDB_ADMIN_TOKEN?: string;
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_RESHARD?: DurableObjectNamespace;
}

interface CatalogReshardAdminRpc {
    beginDerivedTopologyOperation(args: {
        readonly migId: string;
        readonly destinationShard: string;
        readonly rangeLo: number;
        readonly rangeHi: number;
    }): Promise<CatalogTopologyOperation>;
    topologyOperation(args: { readonly migrationId: string }): Promise<CatalogTopologyOperation | null>;
    abortTopologyOperation(args: {
        readonly migId: string;
        readonly sourceShard: string;
        readonly destinationShard: string;
        readonly rangeLo: number;
        readonly rangeHi: number;
        readonly startEpoch: number;
    }): Promise<CatalogTopologyOperation>;
}

interface ResharderAdminStatus {
    readonly migId: string;
    readonly phase: number;
    readonly srcShard: string;
    readonly dstShard: string;
    readonly rangeLo: number;
    readonly rangeHi: number;
}

interface ResharderAdminRpc {
    migrationStatus(migId: string): Promise<ResharderAdminStatus | null>;
    startSplit(args: {
        readonly migId: string;
        readonly srcShard: string;
        readonly dstShard: string;
        readonly rangeLo: number;
        readonly rangeHi: number;
        readonly epochAtStart: number;
        readonly tables: readonly TableSpec[];
    }): Promise<void>;
    runSplit(migId: string): Promise<{ readonly phase: number }>;
    abort(migId: string): Promise<void>;
    recoverLegacyFileMovement(migId: string): Promise<{
        readonly action: "aborted" | "resumed";
        readonly phase: number;
    }>;
}

const RESHARD_MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESHARD_SHARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertReshardMigrationId(value: unknown): asserts value is string {
    if (typeof value !== "string" || !RESHARD_MIGRATION_ID.test(value)) {
        throw new TypeError("reshard migrationId is invalid");
    }
}

function assertReshardStartInput(input: Record<string, unknown>): asserts input is Record<string, unknown> & {
    migrationId: string;
    destinationShard: string;
    rangeLo: number;
    rangeHi: number;
} {
    assertReshardMigrationId(input.migrationId);
    if (typeof input.destinationShard !== "string" || !RESHARD_SHARD_ID.test(input.destinationShard)) {
        throw new TypeError("reshard destinationShard is invalid");
    }
    if (
        !Number.isSafeInteger(input.rangeLo) ||
        !Number.isSafeInteger(input.rangeHi) ||
        (input.rangeLo as number) < 0 ||
        (input.rangeHi as number) < (input.rangeLo as number) ||
        (input.rangeHi as number) >= 16_384
    ) {
        throw new TypeError("reshard virtual-shard range is invalid");
    }
}

function reshardPhaseName(phase: number): string {
    for (const [name, value] of Object.entries(RESHARDER_PHASE)) if (value === phase) return name;
    throw new CdbError({ code: "CDB_INVARIANT", message: "Resharder returned an invalid phase" });
}

function projectReshardStatus(status: ResharderAdminStatus): Record<string, unknown> {
    return {
        migrationId: status.migId,
        phase: status.phase,
        phaseName: reshardPhaseName(status.phase),
        terminal: status.phase === RESHARDER_PHASE.SOURCE_DRAINED || status.phase === RESHARDER_PHASE.ABORTED,
        sourceShard: status.srcShard,
        destinationShard: status.dstShard,
        rangeLo: status.rangeLo,
        rangeHi: status.rangeHi,
    };
}

function assertExactReshardStatus(
    status: ResharderAdminStatus,
    expected: {
        readonly migrationId: string;
        readonly destinationShard: string;
        readonly rangeLo: number;
        readonly rangeHi: number;
    }
): void {
    if (
        status.migId !== expected.migrationId ||
        status.dstShard !== expected.destinationShard ||
        status.rangeLo !== expected.rangeLo ||
        status.rangeHi !== expected.rangeHi
    ) {
        throw new CdbError({
            code: "CDB_RESHARD_PHASE_MISMATCH",
            message: `migrationId=${expected.migrationId} is already bound to a different split`,
        });
    }
}

function reshardError(error: unknown): Response {
    if (error instanceof TypeError || error instanceof SyntaxError) return adminJsonError(400, error.message);
    if (error instanceof CdbError) {
        const status =
            error.code === "CDB_INVALID_ARGS"
                ? 400
                : error.code === "CDB_RATE_LIMITED"
                  ? 429
                  : error.code === "CDB_STALE_EPOCH" ||
                      error.code === "CDB_RESHARD_PHASE_MISMATCH" ||
                      error.code === "CDB_UNSUPPORTED_FEATURE"
                    ? 409
                    : 500;
        return adminJsonError(status, error.message);
    }
    throw error;
}

/** Private token-protected controller. Caller supplies intent; the Worker owns every physical identity. */
export async function handleReshardAdminRequest(
    request: Request,
    env: ReshardAdminEnv,
    schema: Record<string, unknown>
): Promise<Response> {
    const denied = await authorizeAdmin(request, env);
    if (denied) return denied;
    if (!env.CDB_RESHARD) return adminJsonError(503, "CDB_RESHARD binding is unavailable");

    const url = new URL(request.url);
    const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogReshardAdminRpc;
    const resharder = env.CDB_RESHARD.get(env.CDB_RESHARD.idFromName("global")) as unknown as ResharderAdminRpc;
    try {
        if (request.method === "GET" && url.pathname === "/_chardb/shards/status") {
            const values = url.searchParams.getAll("migrationId");
            if (values.length !== 1 || [...url.searchParams.keys()].some(key => key !== "migrationId")) {
                throw new TypeError("reshard status requires exactly one migrationId");
            }
            assertReshardMigrationId(values[0]);
            const status = await resharder.migrationStatus(values[0]);
            return Response.json({ ok: true, state: status ? projectReshardStatus(status) : null });
        }
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        const body = await readAdminBody(request);
        if (url.pathname === "/_chardb/shards/start") {
            const input = exactAdminObject(body, ["migrationId", "destinationShard", "rangeLo", "rangeHi"]);
            assertReshardStartInput(input);
            const existing = await resharder.migrationStatus(input.migrationId);
            if (existing) {
                assertExactReshardStatus(existing, input);
                return Response.json({ ok: true, started: false, state: projectReshardStatus(existing) });
            }
            const tables = packagedReshardTableSpecs(schema);
            const topology = await catalog.beginDerivedTopologyOperation({
                migId: input.migrationId,
                destinationShard: input.destinationShard,
                rangeLo: input.rangeLo,
                rangeHi: input.rangeHi,
            });
            if (topology.status !== "active") {
                throw new CdbError({
                    code: "CDB_STALE_EPOCH",
                    message: `topology operation is already ${topology.status}`,
                });
            }
            if (
                topology.migrationId !== input.migrationId ||
                topology.destinationShard !== input.destinationShard ||
                topology.rangeLo !== input.rangeLo ||
                topology.rangeHi !== input.rangeHi ||
                topology.sourceShard === input.destinationShard
            ) {
                throw new CdbError({ code: "CDB_INVARIANT", message: "Catalog returned an invalid topology claim" });
            }
            await resharder.startSplit({
                migId: topology.migrationId,
                srcShard: topology.sourceShard,
                dstShard: topology.destinationShard,
                rangeLo: topology.rangeLo,
                rangeHi: topology.rangeHi,
                epochAtStart: topology.startEpoch,
                tables,
            });
            const started = await resharder.migrationStatus(input.migrationId);
            if (!started) throw new CdbError({ code: "CDB_INVARIANT", message: "Resharder start was not durable" });
            assertExactReshardStatus(started, input);
            return Response.json({ ok: true, started: true, state: projectReshardStatus(started) });
        }
        if (url.pathname === "/_chardb/shards/drive") {
            const input = exactAdminObject(body, ["migrationId"]);
            assertReshardMigrationId(input.migrationId);
            if (!(await resharder.migrationStatus(input.migrationId))) {
                return adminJsonError(404, "reshard migration was not found");
            }
            await resharder.runSplit(input.migrationId);
            const status = await resharder.migrationStatus(input.migrationId);
            if (!status) throw new CdbError({ code: "CDB_INVARIANT", message: "Resharder migration disappeared" });
            return Response.json({ ok: true, state: projectReshardStatus(status) });
        }
        if (url.pathname === "/_chardb/shards/recover") {
            const input = exactAdminObject(body, ["migrationId"]);
            assertReshardMigrationId(input.migrationId);
            if (!(await resharder.migrationStatus(input.migrationId))) {
                return adminJsonError(404, "reshard migration was not found");
            }
            const recovery = await resharder.recoverLegacyFileMovement(input.migrationId);
            const status = await resharder.migrationStatus(input.migrationId);
            if (!status) throw new CdbError({ code: "CDB_INVARIANT", message: "Resharder migration disappeared" });
            if (recovery.phase !== status.phase) {
                throw new CdbError({ code: "CDB_INVARIANT", message: "Resharder recovery returned a stale phase" });
            }
            return Response.json({ ok: true, action: recovery.action, state: projectReshardStatus(status) });
        }
        if (url.pathname === "/_chardb/shards/abort") {
            const input = exactAdminObject(body, ["migrationId"]);
            assertReshardMigrationId(input.migrationId);
            const status = await resharder.migrationStatus(input.migrationId);
            if (!status) {
                const topology = await catalog.topologyOperation({ migrationId: input.migrationId });
                if (!topology) return adminJsonError(404, "reshard migration was not found");
                if (topology.status !== "active") {
                    return adminJsonError(409, `topology operation is already ${topology.status}`);
                }
                await catalog.abortTopologyOperation({
                    migId: topology.migrationId,
                    sourceShard: topology.sourceShard,
                    destinationShard: topology.destinationShard,
                    rangeLo: topology.rangeLo,
                    rangeHi: topology.rangeHi,
                    startEpoch: topology.startEpoch,
                });
            }
            await resharder.abort(input.migrationId);
            const aborted = await resharder.migrationStatus(input.migrationId);
            return Response.json({ ok: true, state: aborted ? projectReshardStatus(aborted) : null, aborted: true });
        }
        return new Response("not found", { status: 404 });
    } catch (error) {
        return reshardError(error);
    }
}
