import { describe, expect, test } from "bun:test";
import {
    assertVectorizeLocalRemoteBenchmark,
    renderVectorizeLocalRemoteWrangler,
    runVectorizeLocalRemoteBenchmark,
    startVectorizeLocalRemoteRuntime,
} from "../scripts/cloudflare-vectorize-local-remote-benchmark.mjs";

const digest = "a".repeat(64);
const VECTOR_VALUES = Object.freeze([1, ...Array(31).fill(0)]);
const index = `chardb-vx-proof-${digest.slice(0, 10)}-0123456789abcdef`;
const config = `name = "${index}"
main = "src/worker.ts"
compatibility_date = "2026-08-27"

[[vectorize]]
binding = "CDB_PROOF_VECTORS"
index_name = "${index}"

[vars]
CDB_RELEASE_SHA256 = "${digest}"
`;

describe("local Wrangler remote-Vectorize benchmark", () => {
    test("renders exactly one remote Vectorize binding without changing local Worker mode", () => {
        const withVectorRemote = (value: string) =>
            config.replace(`index_name = "${index}"`, `index_name = "${index}"\n${value}`);
        const rendered = renderVectorizeLocalRemoteWrangler(config, index);
        expect(rendered).toContain('compatibility_date = "2026-08-27"');
        expect(rendered).toContain(`index_name = "${index}"\nremote = true`);
        expect(rendered.match(/^remote = true$/gmu)).toHaveLength(1);
        expect(renderVectorizeLocalRemoteWrangler(rendered, index)).toBe(rendered);
        expect(() => renderVectorizeLocalRemoteWrangler(withVectorRemote("remote = false"), index)).toThrow(
            "incompatible remote binding mode"
        );
        expect(() =>
            renderVectorizeLocalRemoteWrangler(withVectorRemote("remote = true\nremote = true"), index)
        ).toThrow("incompatible remote binding mode");
        expect(() =>
            renderVectorizeLocalRemoteWrangler(config.replace("\n[vars]", "\n[vars]\nremote = true"), index)
        ).toThrow("incompatible remote binding mode");
        for (const malformed of ["remote=true", 'remote = "true"', "remote = true # inherited"] as const) {
            expect(() => renderVectorizeLocalRemoteWrangler(withVectorRemote(malformed), index)).toThrow(
                "incompatible remote binding mode"
            );
        }
        expect(() => renderVectorizeLocalRemoteWrangler(config, `${index}-wrong`)).toThrow("owned Vectorize index");
        expect(() => renderVectorizeLocalRemoteWrangler(config.replace("2026-08-27", "2026-08-29"), index)).toThrow(
            "compatibility_date 2026-08-27"
        );
    });

    test("starts loopback Wrangler with persistent local DOs and no global remote mode", async () => {
        const exited = Promise.withResolvers<number>();
        const child = {
            pid: 4321,
            exitCode: null as number | null,
            exited: exited.promise,
            stdout: new ReadableStream({
                start(controller) {
                    controller.close();
                },
            }),
            stderr: new ReadableStream({
                start(controller) {
                    controller.close();
                },
            }),
            kill() {},
        };
        let command: readonly string[] = [];
        let childEnvironment: Record<string, string | undefined> = {};
        let rendered = "";
        let removed = "";
        const runtime = await startVectorizeLocalRemoteRuntime(
            {
                app: "/private/proof/app",
                config: "/private/proof/app/wrangler.toml",
                secretsFile: "/private/proof/secrets.env",
                persistenceDir: "/private/proof/runtime/state",
                runtimeDir: "/private/proof/runtime",
                wrangler: "/private/proof/app/node_modules/.bin/wrangler",
                releaseSha256: digest,
                index,
                profile: "default",
                accountId: "8".repeat(32),
                baseEnvironment: {
                    CLOUDFLARE_API_TOKEN: "must-not-win",
                    CF_API_TOKEN: "must-not-win",
                    CLOUDFLARE_ACCOUNT_ID: "must-not-win",
                    CF_ACCOUNT_ID: "must-not-win",
                    CLOUDFLARE_API_KEY: "must-not-win",
                    CLOUDFLARE_EMAIL: "must-not-win",
                    XDG_CONFIG_HOME: "/real/profile/config",
                    XDG_CACHE_HOME: "/real/profile/cache",
                    XDG_STATE_HOME: "/real/profile/state",
                },
            },
            {
                reservePort: async () => 43_219,
                readFile: async () => config,
                writeConfig: async (_file: string, value: string) => {
                    rendered = value;
                },
                removeConfig: async (file: string) => {
                    removed = file;
                },
                prepareDirectory: async () => {},
                spawn: (value: readonly string[], options: { env: Record<string, string | undefined> }) => {
                    command = value;
                    childEnvironment = options.env;
                    return child;
                },
                fetch: async () => Response.json({ ok: true, releaseSha256: digest, proofConfigured: true }),
                terminate: async () => {
                    child.exitCode = 143;
                    exited.resolve(143);
                },
            }
        );
        expect(runtime.origin).toBe("http://127.0.0.1:43219");
        expect(command).toContain("127.0.0.1");
        expect(command).toContain("/private/proof/runtime/state");
        expect(command).toContain("/private/proof/secrets.env");
        expect(command).toContain("--profile");
        expect(command).not.toContain("--local");
        expect(command).not.toContain("--remote");
        for (const key of [
            "CLOUDFLARE_API_TOKEN",
            "CF_API_TOKEN",
            "CF_ACCOUNT_ID",
            "CLOUDFLARE_API_KEY",
            "CLOUDFLARE_EMAIL",
        ]) {
            expect(childEnvironment[key]).toBeUndefined();
        }
        expect(childEnvironment.CLOUDFLARE_ACCOUNT_ID).toBe("8".repeat(32));
        expect(childEnvironment.XDG_CONFIG_HOME).toBe("/real/profile/config");
        expect(childEnvironment.XDG_CACHE_HOME).toBe("/real/profile/cache");
        expect(childEnvironment.XDG_STATE_HOME).toBe("/real/profile/state");
        expect(rendered).toContain("remote = true");
        await runtime.stop();
        expect(removed).toBe("/private/proof/app/.chardb-vectorize-local-remote.toml");
    });

    test("isolates token auth from inherited profiles and legacy key credentials", async () => {
        const exited = Promise.withResolvers<number>();
        const child = {
            pid: 4322,
            exitCode: null as number | null,
            exited: exited.promise,
            stdout: new ReadableStream({
                start(controller) {
                    controller.close();
                },
            }),
            stderr: new ReadableStream({
                start(controller) {
                    controller.close();
                },
            }),
            kill() {},
        };
        let environment: Record<string, string | undefined> = {};
        const runtime = await startVectorizeLocalRemoteRuntime(
            {
                app: "/private/proof/app",
                config: "/private/proof/app/wrangler.toml",
                secretsFile: "/private/proof/secrets.env",
                persistenceDir: "/private/proof/runtime/state",
                runtimeDir: "/private/proof/runtime",
                wrangler: "/private/proof/app/node_modules/.bin/wrangler",
                releaseSha256: digest,
                index,
                apiToken: "private-cloudflare-token",
                accountId: "8".repeat(32),
                baseEnvironment: {
                    CF_API_TOKEN: "must-not-win",
                    CF_ACCOUNT_ID: "must-not-win",
                    CLOUDFLARE_API_KEY: "must-not-win",
                    CLOUDFLARE_EMAIL: "must-not-win",
                    XDG_CONFIG_HOME: "/real/profile/config",
                },
            },
            {
                reservePort: async () => 43_220,
                readFile: async () => config,
                writeConfig: async () => {},
                removeConfig: async () => {},
                prepareDirectory: async () => {},
                spawn: (_command: readonly string[], options: { env: Record<string, string | undefined> }) => {
                    environment = options.env;
                    return child;
                },
                fetch: async () => Response.json({ ok: true, releaseSha256: digest, proofConfigured: true }),
                terminate: async () => {
                    child.exitCode = 143;
                    exited.resolve(143);
                },
            }
        );
        expect(environment.CLOUDFLARE_API_TOKEN).toBe("private-cloudflare-token");
        expect(environment.CLOUDFLARE_ACCOUNT_ID).toBe("8".repeat(32));
        expect(environment.CF_API_TOKEN).toBeUndefined();
        expect(environment.CF_ACCOUNT_ID).toBeUndefined();
        expect(environment.CLOUDFLARE_API_KEY).toBeUndefined();
        expect(environment.CLOUDFLARE_EMAIL).toBeUndefined();
        expect(environment.XDG_CONFIG_HOME).toBe("/private/proof/runtime/xdg-config");
        await runtime.stop();
    });

    test("records ownership before send, measures five searches, and deletes before stopping", async () => {
        let clock = 0;
        let deleted = false;
        let stopped = false;
        const order: string[] = [];
        const checkpoints: string[] = [];
        const physicalId = `p1_${"A".repeat(43)}_1`;
        const principal = { cookie: "cookie-secret", token: "principal-token-secret", userId: "user-a" };
        const lifecycle = {
            health: async () => ({ ok: true }),
            migrateV0ToV1: async () => ({ afterVersion: 1, afterEpoch: 2 }),
            setupOrganizations: async () => ({
                owner: principal,
                member: { ...principal, userId: "user-b" },
                owningOrganizationId: "org-owning",
                isolatedOrganizationId: "org-isolated",
            }),
            vectorIntent: async ({ action }: { action: "create" | "delete" }) => ({
                vectorId: `vec1_${"b".repeat(64)}`,
                action: action === "delete" ? "delete" : "upsert",
                nextVersion: action === "delete" ? 2 : 1,
                physicalIds: [physicalId],
            }),
            mutateVector: async ({ action }: { action: "create" | "delete" }) => {
                order.push(`mutate:${action}`);
                if (action === "delete") deleted = true;
                return action === "delete"
                    ? { id: "document-a" }
                    : { id: "document-a", vectorId: `vec1_${"b".repeat(64)}` };
            },
            pollReady: async () => ({ result: { ready: true } }),
            proveNamespaceIsolation: async (input: {
                timeoutMs: number;
                intervalMs: number;
                expectedRowPk?: string;
                stabilityWindowMs?: number;
            }) => {
                expect(input).toMatchObject({
                    timeoutMs: 120_000,
                    intervalMs: 1_000,
                    stabilityWindowMs: 10_000,
                    expectedRowPk: "document-a",
                });
                return {
                    namespaceIsolation: true,
                    queryVisibilityElapsedMs: 7,
                    queryVisibilityAttempts: 2,
                    transientHttpFailureCount: 1,
                    transientHttpFailureCounts: [{ status: 503, code: "CDB_ROUTE_UNAVAILABLE", count: 1 }],
                    transientHttpFailureOverflowCount: 0,
                    hardBoundClaimed: false,
                    queryStabilityWindowMs: 10_000,
                    queryStabilityObservedMs: 11_000,
                    queryStabilityExactMatchCount: 12,
                    queryStabilityResetCount: 2,
                    queryStabilityNonExactCount: 2,
                };
            },
            search: async ({ organizationId }: { organizationId: string }) => {
                clock += 3;
                if (deleted || organizationId === "org-isolated") return [];
                return [{ rowPk: "document-a", score: 1 }];
            },
            pollDeleted: async () => ({ result: { absent: true, retainedTombstone: false } }),
        };
        const result = await runVectorizeLocalRemoteBenchmark(
            {
                prepared: {
                    candidate: { algorithm: "sha256", digest, bytes: 100 },
                    target: { worker: index, index },
                    app: "/private/proof/app",
                    config: "/private/proof/app/wrangler.toml",
                    secretsFile: "/private/proof/secrets.env",
                } as never,
                persistenceDir: "/private/proof/runtime/state",
                runtimeDir: "/private/proof/runtime",
                wrangler: "/private/proof/app/node_modules/.bin/wrangler",
                profile: "default",
                migrationId: "local-remote-migration",
                owningName: "Owning",
                owningSlug: "owning",
                isolatedName: "Isolated",
                isolatedSlug: "isolated",
                mutationRunId: "local-remote-run",
                documentId: "document-a",
                text: "benchmark vector",
                values: VECTOR_VALUES,
            },
            {
                lifecycle: lifecycle as never,
                now: () => clock,
                readSecrets: async () => ({
                    betterAuthSecret: "better-auth-secret-value",
                    adminToken: "admin-token-secret-value",
                    runId: "proof-run-secret-value",
                }),
                appendOwnedIds: async ({ action }: { action: "create" | "delete" }) => {
                    order.push(`own:${action}`);
                },
                checkpoint: async value => {
                    checkpoints.push(value);
                },
                startRuntime: async () => ({
                    origin: "http://127.0.0.1:43219",
                    port: 43_219,
                    stop: async () => {
                        stopped = true;
                    },
                }),
            }
        );
        expect(result.track).toMatchObject({
            workloadId: "ready-vector-filtered-search-v2",
            warmupExcluded: true,
            warmupCount: 1,
            exactMatchLatenciesMs: [3, 3, 3, 3, 3],
        });
        expect(result.track.samples.map(sample => sample.classification)).toEqual([
            "exact",
            "exact",
            "exact",
            "exact",
            "exact",
        ]);
        expect(result.evidence.sampling).toMatchObject({
            warmup: { sequence: -1, excluded: true, elapsedMs: 3 },
        });
        expect(result.evidence.readinessSettlement).toEqual({
            elapsedMs: 7,
            attempts: 2,
            transientHttpFailureCount: 1,
            transientHttpFailureCounts: [{ status: 503, code: "CDB_ROUTE_UNAVAILABLE", count: 1 }],
            transientHttpFailureOverflowCount: 0,
            hardBoundClaimed: false,
        });
        expect(result.evidence.queryStability).toEqual({
            queryStabilityWindowMs: 10_000,
            queryStabilityIntervalMs: 1_000,
            queryStabilityObservedMs: 11_000,
            queryStabilityExactMatchCount: 12,
            queryStabilityResetCount: 2,
            queryStabilityNonExactCount: 2,
            hardBoundClaimed: false,
        });
        expect(result.evidence.postStabilitySampling).toMatchObject({
            scheduledRequestCount: 6,
            exactResponseCount: 6,
            exactResponseRatio: 1,
            availabilityMissCount: 0,
            availabilityPassThreshold: null,
            hardBoundClaimed: false,
        });
        expect(result.evidence.correctness).toMatchObject({ runtimeStopped: true, deletedAndAbsent: true });
        expect(order).toEqual(["own:create", "mutate:create", "own:delete", "mutate:delete"]);
        expect(checkpoints).toEqual([
            "health",
            "migration",
            "organization-setup",
            "readiness-isolation",
            "query-stability",
            "timed-search-warmup",
            "timed-search-0",
            "timed-search-1",
            "timed-search-2",
            "timed-search-3",
            "timed-search-4",
            "post-timing-isolated-search",
            "delete-and-absence",
        ]);
        expect(stopped).toBe(true);
        expect(JSON.stringify(result)).not.toContain("secret-value");
        expect(assertVectorizeLocalRemoteBenchmark(result, digest)).toBe(result);
        expect(() => assertVectorizeLocalRemoteBenchmark(result, "f".repeat(64))).toThrow(
            "candidate differs from the proof candidate"
        );
    });

    test("applies the configured request timeout to lifecycle calls and still stops Wrangler", async () => {
        let stopped = false;
        await expect(
            runVectorizeLocalRemoteBenchmark(
                {
                    prepared: {
                        candidate: { algorithm: "sha256", digest, bytes: 100 },
                        target: { worker: index, index },
                        app: "/private/proof/app",
                        config: "/private/proof/app/wrangler.toml",
                        secretsFile: "/private/proof/secrets.env",
                    } as never,
                    persistenceDir: "/private/proof/runtime/state",
                    runtimeDir: "/private/proof/runtime",
                    wrangler: "/private/proof/app/node_modules/.bin/wrangler",
                    profile: "default",
                    migrationId: "local-remote-migration",
                    owningName: "Owning",
                    owningSlug: "owning",
                    isolatedName: "Isolated",
                    isolatedSlug: "isolated",
                    mutationRunId: "local-remote-run",
                    documentId: "document-a",
                    text: "benchmark vector",
                    values: VECTOR_VALUES,
                    requestTimeoutMs: 5,
                },
                {
                    fetch: (async () => new Promise<Response>(() => {})) as unknown as typeof fetch,
                    readSecrets: async () => ({
                        betterAuthSecret: "better-auth-secret-value",
                        adminToken: "admin-token-secret-value",
                        runId: "proof-run-secret-value",
                    }),
                    appendOwnedIds: async () => undefined,
                    startRuntime: async () => ({
                        origin: "http://127.0.0.1:43219",
                        port: 43_219,
                        stop: async () => {
                            stopped = true;
                        },
                    }),
                }
            )
        ).rejects.toThrow("proof Worker health timed out");
        expect(stopped).toBe(true);
    });

    test("rejects a committed create identity that differs from its prior intent", async () => {
        let stopped = false;
        const intended = `vec1_${"b".repeat(64)}`;
        const lifecycle = {
            health: async () => ({ ok: true }),
            migrateV0ToV1: async () => ({ afterVersion: 1, afterEpoch: 2 }),
            setupOrganizations: async () => ({
                owner: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
                member: { cookie: "member-cookie", token: "member-token", userId: "member" },
                owningOrganizationId: "org-owning",
                isolatedOrganizationId: "org-isolated",
            }),
            vectorIntent: async () => ({
                vectorId: intended,
                action: "upsert",
                nextVersion: 1,
                physicalIds: [`p1_${"A".repeat(43)}_1`],
            }),
            mutateVector: async () => ({ id: "document-a", vectorId: `vec1_${"c".repeat(64)}` }),
        };
        await expect(
            runVectorizeLocalRemoteBenchmark(
                {
                    prepared: {
                        candidate: { algorithm: "sha256", digest, bytes: 100 },
                        target: { worker: index, index },
                        app: "/private/proof/app",
                        config: "/private/proof/app/wrangler.toml",
                        secretsFile: "/private/proof/secrets.env",
                    } as never,
                    persistenceDir: "/private/proof/runtime/state",
                    runtimeDir: "/private/proof/runtime",
                    wrangler: "/private/proof/app/node_modules/.bin/wrangler",
                    profile: "default",
                    migrationId: "local-remote-migration",
                    owningName: "Owning",
                    owningSlug: "owning",
                    isolatedName: "Isolated",
                    isolatedSlug: "isolated",
                    mutationRunId: "local-remote-run",
                    documentId: "document-a",
                    text: "benchmark vector",
                    values: VECTOR_VALUES,
                },
                {
                    lifecycle: lifecycle as never,
                    readSecrets: async () => ({
                        betterAuthSecret: "better-auth-secret-value",
                        adminToken: "admin-token-secret-value",
                        runId: "proof-run-secret-value",
                    }),
                    appendOwnedIds: async () => undefined,
                    startRuntime: async () => ({
                        origin: "http://127.0.0.1:43219",
                        port: 43_219,
                        stop: async () => {
                            stopped = true;
                        },
                    }),
                }
            )
        ).rejects.toThrow("create identity drifted from its intent");
        expect(stopped).toBe(true);
    });
});
