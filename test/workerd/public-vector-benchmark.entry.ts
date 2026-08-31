import { vshardOf } from "../../src/vshard.ts";
import { authorizeBenchmarkControlRequest } from "./public-vector-benchmark-control.ts";
import baseWorker, { Catalog as PublicVectorCatalog, Cdb, Gateway, VectorIndexProbe } from "./public-vector.entry.ts";

const BENCHMARK_USER_ID = "workerd-user";

export { Cdb, Gateway, VectorIndexProbe };

export class Catalog extends PublicVectorCatalog {
    fixtureRouteOrganization(input: { readonly organizationId: string; readonly shardId: string }): void {
        const routing = (
            this as unknown as {
                readonly routingStore: { splitRange(lo: number, hi: number, shardId: string): void };
            }
        ).routingStore;
        const vshard = Number(vshardOf([input.organizationId]));
        routing.splitRange(vshard, vshard, input.shardId);
    }
}

interface Env {
    readonly CDB_CATALOG: DurableObjectNamespace;
    readonly CDB_GATEWAY: DurableObjectNamespace;
    readonly CDB_SHARD: DurableObjectNamespace;
    readonly CDB_PROOF_VECTORS: DurableObjectNamespace;
    readonly CDB_BENCHMARK_ADMIN_TOKEN: string;
}

interface CatalogFixture {
    mutateAuth(args: {
        readonly model: string;
        readonly op: "create";
        readonly payload: Record<string, unknown>;
    }): Promise<unknown>;
    fixtureRouteOrganization(input: { readonly organizationId: string; readonly shardId: string }): Promise<void>;
    route(vshard: number): Promise<{ readonly shardId: string }>;
}

interface BenchmarkScenarioInput {
    readonly name: string;
    readonly organizations: number;
    readonly shards: number;
}

function parseScenarios(value: unknown): readonly BenchmarkScenarioInput[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
        throw new TypeError("benchmark scenarios must contain one through three entries");
    }
    return value.map((candidate, index) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            throw new TypeError(`benchmark scenario ${index} is invalid`);
        }
        const input = candidate as Record<string, unknown>;
        if (
            typeof input.name !== "string" ||
            !Number.isSafeInteger(input.organizations) ||
            Number(input.organizations) < 1 ||
            Number(input.organizations) > 256 ||
            !Number.isSafeInteger(input.shards) ||
            Number(input.shards) < 1 ||
            Number(input.shards) > Number(input.organizations)
        ) {
            throw new TypeError(`benchmark scenario ${index} has invalid cardinality`);
        }
        return {
            name: input.name,
            organizations: Number(input.organizations),
            shards: Number(input.shards),
        };
    });
}

async function seedBenchmark(request: Request, env: Env): Promise<Response> {
    const body = (await request.json()) as { readonly run?: string; readonly scenarios?: unknown };
    if (typeof body.run !== "string" || !/^[a-z0-9-]{1,40}$/.test(body.run)) {
        return new Response("invalid benchmark run", { status: 400 });
    }
    let scenarios: readonly BenchmarkScenarioInput[];
    try {
        scenarios = parseScenarios(body.scenarios);
    } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
    }
    const catalog = env.CDB_CATALOG.get(env.CDB_CATALOG.idFromName("global")) as unknown as CatalogFixture;
    const now = Date.parse("2026-08-30T00:00:00Z");
    const usedVshards = new Set<number>();
    const result = [];
    for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
        const scenario = scenarios[scenarioIndex];
        if (!scenario) throw new Error("benchmark scenario disappeared");
        const organizations = [];
        const shardIds = Array.from(
            { length: scenario.shards },
            (_, shardIndex) => `public-vector-benchmark-${body.run}-${scenarioIndex}-${shardIndex}`
        );
        for (let organizationIndex = 0; organizationIndex < scenario.organizations; organizationIndex++) {
            let suffix = organizationIndex;
            let organizationId = "";
            let vshard = -1;
            do {
                organizationId = `pvb-${body.run}-${scenarioIndex}-${suffix}`;
                vshard = Number(vshardOf([organizationId]));
                suffix += scenario.organizations;
            } while (usedVshards.has(vshard));
            usedVshards.add(vshard);
            const shardId = shardIds[organizationIndex % shardIds.length];
            if (!shardId) throw new Error("benchmark shard assignment is missing");
            await catalog.mutateAuth({
                model: "organization",
                op: "create",
                payload: {
                    id: organizationId,
                    name: `Public vector benchmark ${scenarioIndex}-${organizationIndex}`,
                    slug: organizationId,
                    createdAt: now,
                },
            });
            await catalog.mutateAuth({
                model: "member",
                op: "create",
                payload: {
                    id: `pvb-member-${body.run}-${scenarioIndex}-${organizationIndex}`,
                    organizationId,
                    userId: BENCHMARK_USER_ID,
                    role: "member",
                    createdAt: now,
                },
            });
            await catalog.fixtureRouteOrganization({ organizationId, shardId });
            const route = await catalog.route(vshard);
            if (route.shardId !== shardId) throw new Error("benchmark route did not activate");
            organizations.push({ organizationId, shardId, vshard });
        }
        result.push({ name: scenario.name, shardIds, organizations });
    }
    return Response.json({ scenarios: result });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const denied = authorizeBenchmarkControlRequest(request, env.CDB_BENCHMARK_ADMIN_TOKEN);
        if (denied) return denied;
        if (url.pathname === "/benchmark-seed" && request.method === "POST") {
            return seedBenchmark(request, env);
        }
        return baseWorker.fetch(request, env);
    },
};
