import { describe, expect, test } from "bun:test";
import {
    CloudflareVectorizeProofHttpError,
    CloudflareVectorizeProofSettlementError,
    type VectorProofState,
    assertSecretFreeVectorEvidence,
    collectResponseLossRetryEvidence,
    createCloudflareVectorizeProofLifecycle,
    isCloudflareVectorizeProofRetryableStateRead,
    vectorProofMutationIds,
} from "../scripts/cloudflare-vectorize-proof-lifecycle.mjs";

const ORIGIN = "https://proof.example.com";
const ADMIN = Object.freeze({ token: "admin-secret-value", runId: "proof-run-01" });
const LIVE_OWNER = Object.freeze({ cookie: "owner-cookie", token: "owner-token", userId: "owner-user" });
const VECTOR_ID = `vec1_${"a".repeat(64)}`;
const WIRE_VECTOR_DIGEST = Buffer.from("a".repeat(64), "hex").toString("base64url");
const PHYSICAL_ID = `p1_${WIRE_VECTOR_DIGEST}_1`;
const PHYSICAL_ID_2 = `p1_${WIRE_VECTOR_DIGEST}_2`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const VECTOR_VALUES = Object.freeze([1, ...Array(31).fill(0)]);
const REPLACEMENT_VALUES = Object.freeze([0, 1, ...Array(30).fill(0)]);

function response(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
    });
}

function requestBody(init?: RequestInit): Record<string, unknown> {
    return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function header(init: RequestInit | undefined, name: string): string | null {
    return new Headers(init?.headers).get(name);
}

function requestUrl(input: RequestInfo | URL): URL {
    return new URL(input instanceof Request ? input.url : input);
}

function vectorState(input: {
    phase?: "submit" | "verify";
    state?: "pending" | "ready" | "deleting";
    version?: number;
    deliveredVersion?: number;
    leased?: boolean;
    absent?: boolean;
    ambiguous?: boolean;
    terminalFailure?: boolean;
    fault?: VectorProofState["fault"];
}): VectorProofState {
    return {
        vectorId: VECTOR_ID,
        observedAt: 100,
        scheduledAlarmAt: null,
        head: input.absent
            ? null
            : {
                  organizationId: "org-owning",
                  resourceId: `vr1_${"b".repeat(64)}`,
                  rowPk: "document-1",
                  version: input.version ?? 1,
                  deliveredVersion: input.deliveredVersion ?? 0,
                  state: input.state ?? "pending",
              },
        outbox:
            input.absent || !input.phase
                ? null
                : {
                      targetVersion: input.version ?? 1,
                      operation: input.state === "deleting" ? ("delete" as const) : ("upsert" as const),
                      phase: input.phase,
                      mutationIdSha256: input.phase === "verify" ? HASH_A : null,
                      acceptedAt: input.phase === "verify" ? 10 : null,
                      attempts: 1,
                      nextAttemptAt: 10,
                      leased: input.leased ?? false,
                      claimTokenSha256: input.leased ? HASH_B : null,
                      leasedUntil: input.leased ? 10_000 : null,
                      terminalFailure: input.terminalFailure ?? false,
                      lastErrorClassification: input.terminalFailure ? "delete_absence_unproven" : null,
                      lastErrorSha256: input.terminalFailure ? HASH_B : null,
                  },
        attempts: input.ambiguous
            ? [
                  {
                      physicalVersion: 1,
                      firstSentAt: 1,
                      settleAfter: 2,
                      visibilityConfirmed: false,
                      responseAmbiguous: true,
                      deleteConfirmed: false,
                  },
              ]
            : [],
        acceptances: [],
        fault: input.fault ?? null,
    };
}

describe("Cloudflare Vectorize proof HTTP lifecycle", () => {
    test("rejects malformed, oversized, failed, redirected, and timed-out HTTP responses", async () => {
        let malformedCalls = 0;
        const malformed = createCloudflareVectorizeProofLifecycle({
            fetch: async () => {
                malformedCalls++;
                return new Response("not-json-admin-secret-value");
            },
            sleep: async () => {
                throw new Error("malformed successful responses must not retry");
            },
            requestTimeoutMs: 50,
        });
        const malformedError = await malformed.requestJson({ origin: ORIGIN, path: "/health" }).catch(error => error);
        expect(malformedError).toBeInstanceOf(CloudflareVectorizeProofHttpError);
        expect(malformedError).toMatchObject({
            message: "GET /health returned invalid JSON",
            status: null,
            code: null,
            kind: "protocol",
            protocolReason: "invalid_json",
        });
        expect(String(malformedError)).not.toContain("admin-secret-value");
        expect(malformedCalls).toBe(1);

        const oversized = createCloudflareVectorizeProofLifecycle({
            fetch: async () => new Response(JSON.stringify({ value: "too large" })),
            maxResponseBytes: 4,
            requestTimeoutMs: 50,
        });
        await expect(oversized.requestJson({ origin: ORIGIN, path: "/health" })).rejects.toMatchObject({
            status: null,
            code: null,
            kind: "protocol",
            protocolReason: "body_too_large",
        });

        const invalidResponse = createCloudflareVectorizeProofLifecycle({
            fetch: async () => ({}) as Response,
            requestTimeoutMs: 50,
        });
        await expect(invalidResponse.requestJson({ origin: ORIGIN, path: "/health" })).rejects.toMatchObject({
            status: null,
            code: null,
            kind: "protocol",
            protocolReason: "invalid_response",
        });

        const invalidContentLength = createCloudflareVectorizeProofLifecycle({
            fetch: async () => new Response("{}", { headers: { "content-length": "invalid" } }),
            requestTimeoutMs: 50,
        });
        await expect(invalidContentLength.requestJson({ origin: ORIGIN, path: "/health" })).rejects.toMatchObject({
            kind: "protocol",
            protocolReason: "invalid_content_length",
        });

        const emptyBody = createCloudflareVectorizeProofLifecycle({
            fetch: async () => new Response(null),
            requestTimeoutMs: 50,
        });
        await expect(emptyBody.requestJson({ origin: ORIGIN, path: "/health" })).rejects.toMatchObject({
            kind: "protocol",
            protocolReason: "empty_body",
        });

        const invalidUtf8 = createCloudflareVectorizeProofLifecycle({
            fetch: async () => new Response(Uint8Array.of(0xff)),
            requestTimeoutMs: 50,
        });
        await expect(invalidUtf8.requestJson({ origin: ORIGIN, path: "/health" })).rejects.toMatchObject({
            kind: "protocol",
            protocolReason: "invalid_utf8",
        });

        const failed = createCloudflareVectorizeProofLifecycle({
            fetch: async () =>
                response(
                    { error: { code: "AUTH_DENIED", message: "do not echo admin-secret-value" } },
                    { status: 401 }
                ),
            requestTimeoutMs: 50,
        });
        const authError = await failed.requestJson({ origin: ORIGIN, path: "/private" }).catch(error => error);
        expect(authError).toBeInstanceOf(CloudflareVectorizeProofHttpError);
        expect(authError).toMatchObject({
            status: 401,
            code: "AUTH_DENIED",
            kind: "http",
            protocolReason: null,
        });
        expect(String(authError)).not.toContain("admin-secret-value");

        const nonJsonClientError = createCloudflareVectorizeProofLifecycle({
            fetch: async () => new Response("not-json-admin-secret-value", { status: 400 }),
            requestTimeoutMs: 50,
        });
        const clientError = await nonJsonClientError
            .requestJson({ origin: ORIGIN, path: "/private" })
            .catch(error => error);
        expect(clientError).toMatchObject({
            message: "GET /private returned HTTP 400",
            status: 400,
            code: null,
            kind: "http",
            protocolReason: "invalid_json",
        });
        expect(String(clientError)).not.toContain("admin-secret-value");

        let search503Calls = 0;
        const singleAttemptSearch = createCloudflareVectorizeProofLifecycle({
            fetch: async () => {
                search503Calls++;
                return response({ code: "CDB_ROUTE_UNAVAILABLE" }, { status: 503 });
            },
            sleep: async () => {
                throw new Error("ordinary search must not retry");
            },
            requestTimeoutMs: 50,
        });
        await expect(
            singleAttemptSearch.search({
                origin: ORIGIN,
                principal: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
                organizationId: "org-owning",
                values: VECTOR_VALUES,
            })
        ).rejects.toMatchObject({ status: 503, code: "CDB_ROUTE_UNAVAILABLE" });
        expect(search503Calls).toBe(1);

        let mutation503Calls = 0;
        const singleAttemptMutation = createCloudflareVectorizeProofLifecycle({
            fetch: async () => {
                mutation503Calls++;
                return new Response("not-json-admin-secret-value", { status: 503 });
            },
            sleep: async () => {
                throw new Error("mutations must not retry");
            },
            requestTimeoutMs: 50,
        });
        const mutationError = await singleAttemptMutation
            .mutateVector({
                origin: ORIGIN,
                principal: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
                action: "create",
                id: "document-1",
                organizationId: "org-owning",
                mutId: "mutation-one",
                text: "hello",
                values: VECTOR_VALUES,
            })
            .catch(error => error);
        expect(mutationError).toMatchObject({
            message: "vector create returned HTTP 503",
            status: 503,
            code: null,
            kind: "http",
            protocolReason: "invalid_json",
        });
        expect(String(mutationError)).not.toContain("admin-secret-value");
        expect(mutation503Calls).toBe(1);

        const redirected = createCloudflareVectorizeProofLifecycle({
            fetch: async () => {
                const result = response({ ok: true });
                Object.defineProperty(result, "redirected", { value: true });
                return result;
            },
            requestTimeoutMs: 50,
        });
        await expect(redirected.requestJson({ origin: ORIGIN, path: "/health" })).rejects.toMatchObject({
            message: "GET /health redirected unexpectedly",
            status: 200,
            code: null,
            kind: "protocol",
            protocolReason: "unexpected_redirect",
        });

        const network = createCloudflareVectorizeProofLifecycle({
            fetch: async () => {
                throw new TypeError("socket closed");
            },
            requestTimeoutMs: 50,
        });
        await expect(network.requestJson({ origin: ORIGIN, path: "/health" })).rejects.toMatchObject({
            message: "GET /health request failed: socket closed",
            status: null,
            code: null,
            kind: "network",
            protocolReason: null,
        });

        let timedOutSignal: AbortSignal | undefined;
        const timedOut = createCloudflareVectorizeProofLifecycle({
            fetch: (_request, init) => {
                timedOutSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
                return new Promise<Response>(() => undefined);
            },
            setTimeout: callback => {
                queueMicrotask(() => callback());
                return 1;
            },
            clearTimeout: () => undefined,
            requestTimeoutMs: 1,
        });
        await expect(timedOut.requestJson({ origin: ORIGIN, path: "/slow" })).rejects.toMatchObject({
            message: "GET /slow timed out",
            status: null,
            code: null,
            kind: "timeout",
            protocolReason: null,
        });
        expect(timedOutSignal?.aborted).toBe(true);

        let stalledBodyCanceled = false;
        let stalledBodySignal: AbortSignal | undefined;
        const stalledBody = createCloudflareVectorizeProofLifecycle({
            fetch: async (_request, init) => {
                stalledBodySignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
                return new Response(
                    new ReadableStream({
                        cancel() {
                            stalledBodyCanceled = true;
                        },
                    })
                );
            },
            setTimeout: callback => {
                queueMicrotask(() => callback());
                return 1;
            },
            clearTimeout: () => undefined,
            requestTimeoutMs: 1,
        });
        await expect(stalledBody.requestJson({ origin: ORIGIN, path: "/slow-body" })).rejects.toMatchObject({
            message: "GET /slow-body timed out",
            status: null,
            code: null,
            kind: "timeout",
            protocolReason: null,
        });
        await Promise.resolve();
        expect(stalledBodySignal?.aborted).toBe(true);
        expect(stalledBodyCanceled).toBe(true);

        expect(
            () =>
                new CloudflareVectorizeProofHttpError(
                    "invalid protocol reason",
                    null,
                    null,
                    "protocol",
                    "admin-secret-value" as never
                )
        ).toThrow("Cloudflare Vectorize proof HTTP protocol reason is invalid");
        expect(
            () =>
                new CloudflareVectorizeProofHttpError(
                    "inconsistent protocol reason",
                    null,
                    null,
                    "network",
                    "invalid_json"
                )
        ).toThrow("Cloudflare Vectorize proof HTTP protocol reason is inconsistent");

        const invalidIntent = createCloudflareVectorizeProofLifecycle({
            fetch: async () =>
                response({
                    vectorId: VECTOR_ID,
                    action: "upsert",
                    nextVersion: 1,
                    physicalIds: [`p1_${"B".repeat(43)}_1`],
                }),
            requestTimeoutMs: 50,
        });
        await expect(
            invalidIntent.vectorIntent({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                id: "document-1",
                action: "create",
            })
        ).rejects.toThrow("physical id 0 is invalid");
    });

    test("accepts only the public mutation handler result and rejects internal envelopes or result drift", async () => {
        const secret = "mutation-result-secret";
        const cases = [
            {
                action: "create" as const,
                body: { ok: true, ran: true, rowsAffected: 1, result: { id: "document-1", vectorId: VECTOR_ID } },
            },
            {
                action: "create" as const,
                body: { id: "document-1", vectorId: VECTOR_ID, token: secret },
            },
            { action: "create" as const, body: { id: "different-document", vectorId: VECTOR_ID } },
            { action: "create" as const, body: { id: "document-1", vectorId: "not-a-vector-id" } },
            { action: "delete" as const, body: { id: "document-1", vectorId: VECTOR_ID } },
        ];
        for (const item of cases) {
            const lifecycle = createCloudflareVectorizeProofLifecycle({
                fetch: async () => response(item.body),
                requestTimeoutMs: 50,
            });
            const failure = await lifecycle
                .mutateVector({
                    origin: ORIGIN,
                    principal: { cookie: "owner-cookie-secret", token: "owner-token-secret", userId: "owner-user" },
                    action: item.action,
                    id: "document-1",
                    organizationId: "org-owning",
                    mutId: `strict-${item.action}`,
                    ...(item.action === "delete" ? {} : { text: "private mutation text", values: VECTOR_VALUES }),
                })
                .catch(error => error);
            expect(failure).toBeInstanceOf(Error);
            const publicFailure = [String(failure), JSON.stringify(failure), failure.stack ?? ""].join("\n");
            for (const privateValue of [secret, "owner-token-secret", "private mutation text"]) {
                expect(publicFailure).not.toContain(privateValue);
            }
        }
    });

    test("accepts only rowPk and score from the public search lifecycle", async () => {
        const valid = createCloudflareVectorizeProofLifecycle({
            fetch: async () => response([{ rowPk: "document-1", score: 0.99 }]),
            requestTimeoutMs: 50,
        });
        await expect(
            valid.search({
                origin: ORIGIN,
                principal: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
                organizationId: "org-owning",
                values: VECTOR_VALUES,
            })
        ).resolves.toEqual([{ rowPk: "document-1", score: 0.99 }]);

        for (const match of [
            { vectorId: VECTOR_ID, rowPk: "document-1", score: 0.99 },
            { rowPk: "document-1", score: 0.99, metadata: { body: "private" } },
        ]) {
            const internal = createCloudflareVectorizeProofLifecycle({
                fetch: async () => response([match]),
                requestTimeoutMs: 50,
            });
            await expect(
                internal.search({
                    origin: ORIGIN,
                    principal: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
                    organizationId: "org-owning",
                    values: VECTOR_VALUES,
                })
            ).rejects.toThrow("vector search match fields are invalid");
        }
    });

    test("accepts only exact stale-adversary mutation and raw-query evidence", async () => {
        const mutationResponse = {
            action: "apply" as const,
            vectorId: VECTOR_ID,
            stalePhysicalId: PHYSICAL_ID,
            currentPhysicalId: PHYSICAL_ID_2,
            upsertMutationIdSha256: HASH_A,
            deleteMutationIdSha256: HASH_B,
        };
        const queryResponse = {
            action: "inspect" as const,
            vectorId: VECTOR_ID,
            stalePhysicalId: PHYSICAL_ID,
            currentPhysicalId: PHYSICAL_ID_2,
            upsertMutationIdSha256: null,
            deleteMutationIdSha256: null,
            matches: [{ physicalId: PHYSICAL_ID, score: 0.99 }],
        };
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            fetch: async request => {
                const url = requestUrl(request);
                return response(url.pathname.endsWith("/query") ? queryResponse : mutationResponse);
            },
            requestTimeoutMs: 50,
        });
        await expect(
            lifecycle.mutateVectorAdversary({
                origin: ORIGIN,
                admin: ADMIN,
                action: "apply",
                organizationId: "org-owning",
                id: "document-1",
                staleValues: VECTOR_VALUES,
                currentValues: REPLACEMENT_VALUES,
            })
        ).resolves.toEqual(mutationResponse);
        await expect(
            lifecycle.queryVectorAdversary({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                id: "document-1",
                values: VECTOR_VALUES,
            })
        ).resolves.toEqual(queryResponse);

        for (const body of [
            { ...mutationResponse, rawValues: VECTOR_VALUES },
            { ...mutationResponse, upsertMutationIdSha256: "raw-mutation-id" },
            { ...mutationResponse, currentPhysicalId: PHYSICAL_ID },
        ]) {
            const malformed = createCloudflareVectorizeProofLifecycle({
                fetch: async () => response(body),
                requestTimeoutMs: 50,
            });
            await expect(
                malformed.mutateVectorAdversary({
                    origin: ORIGIN,
                    admin: ADMIN,
                    action: "apply",
                    organizationId: "org-owning",
                    id: "document-1",
                    staleValues: VECTOR_VALUES,
                    currentValues: REPLACEMENT_VALUES,
                })
            ).rejects.toThrow();
        }
        for (const body of [
            { ...queryResponse, rawMetadata: {} },
            { ...queryResponse, matches: [{ physicalId: PHYSICAL_ID, score: 1, values: VECTOR_VALUES }] },
            { ...queryResponse, matches: [{ physicalId: "not-owned", score: 1 }] },
            { ...queryResponse, upsertMutationIdSha256: HASH_A },
        ]) {
            const malformed = createCloudflareVectorizeProofLifecycle({
                fetch: async () => response(body),
                requestTimeoutMs: 50,
            });
            await expect(
                malformed.queryVectorAdversary({
                    origin: ORIGIN,
                    admin: ADMIN,
                    organizationId: "org-owning",
                    id: "document-1",
                    values: VECTOR_VALUES,
                })
            ).rejects.toThrow();
        }
    });

    test("accepts only bounded hashed exact-call public search audit evidence", async () => {
        const cursor = {
            sequence: 7,
            querySha256: null,
            candidateSetSha256: null,
            candidateCount: 0,
            stalePresent: false,
            currentPresent: false,
            otherCandidateCount: 0,
        };
        const observation = {
            sequence: 8,
            querySha256: HASH_A,
            candidateSetSha256: HASH_B,
            candidateCount: 1,
            stalePresent: true,
            currentPresent: false,
            otherCandidateCount: 0,
        };
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            fetch: async (request, init) => {
                const body = (await new Request(request, init).json()) as { readonly action?: unknown };
                return response(body.action === "cursor" ? cursor : observation);
            },
            requestTimeoutMs: 50,
        });
        const base = {
            origin: ORIGIN,
            admin: ADMIN,
            organizationId: "org-owning",
            id: "document-1",
            values: VECTOR_VALUES,
        };
        await expect(lifecycle.vectorSearchAudit({ ...base, action: "cursor" })).resolves.toEqual(cursor);
        await expect(lifecycle.vectorSearchAudit({ ...base, action: "observe", afterSequence: 7 })).resolves.toEqual(
            observation
        );

        for (const malformedBody of [
            { ...observation, sequence: 9 },
            { ...observation, querySha256: "raw-query" },
            { ...observation, candidateCount: 2 },
            { ...observation, physicalIds: [PHYSICAL_ID] },
        ]) {
            const malformed = createCloudflareVectorizeProofLifecycle({
                fetch: async () => response(malformedBody),
                requestTimeoutMs: 50,
            });
            await expect(
                malformed.vectorSearchAudit({ ...base, action: "observe", afterSequence: 7 })
            ).rejects.toThrow();
        }
    });

    test("opens the live SDK proof only through an exact Better Auth principal and bounded query", async () => {
        const refreshingOwner = Object.freeze({ ...LIVE_OWNER, cookie: "session=owner-cookie" });
        const session = {
            reconnect: async () => ({ recovery: "lagged-refetch" as const }),
            beginReplacement: () => undefined,
            waitForPending: async () => ({ elapsedMs: 1 }),
            assertPending: () => undefined,
            allowCurrent: () => undefined,
            waitForCurrent: async () => ({ elapsedMs: 1 }),
            finish: () => ({}) as never,
            abort: () => undefined,
        };
        let received: Record<string, unknown> | undefined;
        const refreshRequests: string[] = [];
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            fetch: async (input, init) => {
                const url = requestUrl(input);
                refreshRequests.push(`${url.pathname}:${header(init, "cookie")}`);
                if (url.pathname === "/api/auth/get-session") {
                    return response({ user: { id: LIVE_OWNER.userId } });
                }
                if (url.pathname === "/api/auth/token") return response({ token: "refreshed-owner-token" });
                return response({ error: "unexpected route" }, { status: 404 });
            },
            openLiveVectorSubscription: async input => {
                received = input;
                return session;
            },
        });
        await expect(
            lifecycle.openLiveVectorSubscription({
                origin: ORIGIN,
                principal: refreshingOwner,
                organizationId: "org-owning",
                expectedRowPk: "live-document",
                expectedPendingFallbackRowPk: "lifecycle-document",
                values: VECTOR_VALUES,
                clientId: "live-client",
                timeoutMs: 1_000,
            })
        ).resolves.toBe(session);
        expect(received).toEqual({
            origin: "https://proof.example.com/",
            organizationId: "org-owning",
            expectedRowPk: "live-document",
            expectedPendingFallbackRowPk: "lifecycle-document",
            values: VECTOR_VALUES,
            clientId: "live-client",
            jwt: LIVE_OWNER.token,
            getJwt: expect.any(Function),
            timeoutMs: 1_000,
        });
        const getJwt = received?.getJwt;
        expect(typeof getJwt).toBe("function");
        await expect((getJwt as () => Promise<string>)()).resolves.toBe(LIVE_OWNER.token);
        await expect((getJwt as () => Promise<string>)()).resolves.toBe("refreshed-owner-token");
        expect(refreshRequests).toEqual([
            "/api/auth/get-session:session=owner-cookie",
            "/api/auth/token:session=owner-cookie",
        ]);

        const missing = createCloudflareVectorizeProofLifecycle();
        await expect(
            missing.openLiveVectorSubscription({
                origin: ORIGIN,
                principal: LIVE_OWNER,
                organizationId: "org-owning",
                expectedRowPk: "live-document",
                expectedPendingFallbackRowPk: "lifecycle-document",
                values: VECTOR_VALUES,
                clientId: "live-client",
                timeoutMs: 1_000,
            })
        ).rejects.toThrow("dependency is required");
        await expect(
            lifecycle.openLiveVectorSubscription({
                origin: ORIGIN,
                principal: LIVE_OWNER,
                organizationId: "org-owning",
                expectedRowPk: "live-document",
                expectedPendingFallbackRowPk: "lifecycle-document",
                values: [1, 0],
                clientId: "live-client",
                timeoutMs: 1_000,
            })
        ).rejects.toThrow("32 finite numbers");
    });

    test("sets up Better Auth organizations and runs version zero to one migration exactly", async () => {
        let anonymous = 0;
        let organizations = 0;
        let migration: "initial" | "migrating" | "active" = "initial";
        let memberships = 0;
        const activatedShards: string[] = [];
        const calls: string[] = [];
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            fetch: async (request, init) => {
                const url = requestUrl(request);
                calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
                if (url.pathname === "/api/auth/sign-in/anonymous") {
                    anonymous++;
                    return response(
                        { ok: true },
                        { headers: { "set-cookie": `session=s${anonymous}; Path=/; HttpOnly` } }
                    );
                }
                if (url.pathname === "/api/auth/get-session") {
                    const session = header(init, "cookie")?.match(/session=(s\d)/)?.[1];
                    if (!session) return response({ error: "unauthenticated" }, { status: 401 });
                    return response({ user: { id: `user-${session}` } });
                }
                if (url.pathname === "/api/auth/token") {
                    const session = header(init, "cookie")?.match(/session=(s\d)/)?.[1];
                    if (!session) return response({ error: "unauthenticated" }, { status: 401 });
                    return response({ token: `jwt-${session}` });
                }
                if (url.pathname === "/api/auth/organization/create") {
                    organizations++;
                    expect(header(init, "origin")).toBe(ORIGIN);
                    expect(requestBody(init)).toMatchObject({ keepCurrentActiveOrganization: true });
                    return response({ id: organizations === 1 ? "org-owning" : "org-isolated" });
                }
                if (url.pathname === "/api/auth/organization/set-active") {
                    expect(["org-owning", "org-isolated"]).toContain(String(requestBody(init).organizationId));
                    return response({ session: {} });
                }
                if (url.pathname === "/proof/add-member") {
                    expect(header(init, "authorization")).toBe(`Bearer ${ADMIN.token}`);
                    expect(header(init, "x-chardb-proof-run-id")).toBe(ADMIN.runId);
                    memberships++;
                    const organizationId = memberships === 1 ? "org-owning" : "org-isolated";
                    expect(requestBody(init)).toEqual({ organizationId, userId: "user-s2" });
                    return response({
                        id: `member-${memberships}`,
                        organizationId,
                        userId: "user-s2",
                        role: "member",
                    });
                }
                if (url.pathname === "/_chardb/migrations/state") {
                    return response({
                        state:
                            migration === "active"
                                ? {
                                      activeVersion: 1,
                                      activeEpoch: 2,
                                      status: "active",
                                      migrationId: null,
                                      targetVersion: null,
                                  }
                                : {
                                      activeVersion: 0,
                                      activeEpoch: 1,
                                      status: "active",
                                      migrationId: null,
                                      targetVersion: null,
                                  },
                    });
                }
                if (url.pathname === "/_chardb/migrations/begin") {
                    expect(requestBody(init)).toEqual({ migrationId: "proof-migration-1", targetVersion: 1 });
                    migration = "migrating";
                    return response({
                        state: {
                            activeVersion: 0,
                            activeEpoch: 1,
                            status: "migrating",
                            migrationId: "proof-migration-1",
                            targetVersion: 1,
                        },
                    });
                }
                if (url.pathname === "/_chardb/migrations/shards") {
                    expect(url.searchParams.get("migrationId")).toBe("proof-migration-1");
                    return response({
                        shards: [
                            { shardId: "shard-a", status: "pending" },
                            { shardId: "shard-b", status: "active" },
                        ],
                    });
                }
                if (url.pathname === "/_chardb/migrations/shard") {
                    const shardId = String(requestBody(init).shardId);
                    activatedShards.push(shardId);
                    return response({ shard: { shardId, status: "active" } });
                }
                if (url.pathname === "/_chardb/migrations/catalog") {
                    expect(requestBody(init)).toEqual({ migrationId: "proof-migration-1", version: 1 });
                    return response({
                        state: {
                            activeVersion: 0,
                            activeEpoch: 1,
                            status: "migrating",
                            migrationId: "proof-migration-1",
                            targetVersion: 1,
                        },
                    });
                }
                if (url.pathname === "/_chardb/migrations/complete") {
                    migration = "active";
                    return response({
                        state: {
                            activeVersion: 1,
                            activeEpoch: 2,
                            status: "active",
                            migrationId: null,
                            targetVersion: null,
                        },
                    });
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });

        const setup = await lifecycle.setupOrganizations({
            origin: ORIGIN,
            admin: ADMIN,
            owningName: "Owning organization",
            owningSlug: "owning-organization",
            isolatedName: "Isolated organization",
            isolatedSlug: "isolated-organization",
        });
        expect(setup).toEqual({
            owner: { cookie: "session=s1", token: "jwt-s1", userId: "user-s1" },
            member: { cookie: "session=s2", token: "jwt-s2", userId: "user-s2" },
            owningMember: { cookie: "session=s2", token: "jwt-s2", userId: "user-s2" },
            owningOrganizationId: "org-owning",
            isolatedOrganizationId: "org-isolated",
        });

        expect(
            await lifecycle.migrateV0ToV1({
                origin: ORIGIN,
                adminToken: ADMIN.token,
                migrationId: "proof-migration-1",
            })
        ).toEqual({
            beforeVersion: 0,
            beforeEpoch: 1,
            targetVersion: 1,
            afterVersion: 1,
            afterEpoch: 2,
            idempotentRetry: false,
        });
        expect(activatedShards).toEqual(["shard-a"]);
        expect(
            await lifecycle.migrateV0ToV1({
                origin: ORIGIN,
                adminToken: ADMIN.token,
                migrationId: "proof-migration-1",
            })
        ).toMatchObject({ afterVersion: 1, afterEpoch: 2, idempotentRetry: true });
        expect(calls.filter(call => call.includes("/migrations/begin"))).toHaveLength(1);
    });

    test("retries a transient migration 500 within the shared deadline", async () => {
        let clock = 0;
        let completeAttempts = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async (request, init) => {
                const url = requestUrl(request);
                if (url.pathname === "/_chardb/migrations/state") {
                    return response({
                        state: {
                            activeVersion: 0,
                            activeEpoch: 1,
                            status: "active",
                            migrationId: null,
                            targetVersion: null,
                        },
                    });
                }
                if (url.pathname === "/_chardb/migrations/begin") {
                    return response({
                        state: {
                            activeVersion: 0,
                            activeEpoch: 1,
                            status: "migrating",
                            migrationId: "proof-migration-retry",
                            targetVersion: 1,
                        },
                    });
                }
                if (url.pathname === "/_chardb/migrations/shards") {
                    return response({ shards: [{ shardId: "shard-a", status: "active" }] });
                }
                if (url.pathname === "/_chardb/migrations/catalog") {
                    return response({
                        state: {
                            activeVersion: 0,
                            activeEpoch: 1,
                            status: "migrating",
                            migrationId: "proof-migration-retry",
                            targetVersion: 1,
                        },
                    });
                }
                if (url.pathname === "/_chardb/migrations/complete") {
                    expect(requestBody(init)).toEqual({ migrationId: "proof-migration-retry" });
                    completeAttempts++;
                    if (completeAttempts === 1) return response({}, { status: 500 });
                    return response({
                        state: {
                            activeVersion: 1,
                            activeEpoch: 2,
                            status: "active",
                            migrationId: null,
                            targetVersion: null,
                        },
                    });
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });

        await expect(
            lifecycle.migrateV0ToV1({
                origin: ORIGIN,
                adminToken: ADMIN.token,
                migrationId: "proof-migration-retry",
                timeoutMs: 25,
                intervalMs: 10,
            })
        ).resolves.toMatchObject({ afterVersion: 1, afterEpoch: 2, idempotentRetry: false });
        expect(completeAttempts).toBe(2);
        expect(clock).toBe(10);
    });

    test("bounds persistent migration 500 retries and preserves the last HTTP evidence", async () => {
        let clock = 0;
        let attempts = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async () => {
                attempts++;
                return response({}, { status: 500 });
            },
            requestTimeoutMs: 100,
        });

        const failure = await lifecycle
            .migrateV0ToV1({
                origin: ORIGIN,
                adminToken: ADMIN.token,
                migrationId: "proof-migration-persistent",
                timeoutMs: 25,
                intervalMs: 10,
            })
            .catch(error => error);
        expect(failure).toBeInstanceOf(CloudflareVectorizeProofHttpError);
        expect(failure).toMatchObject({
            message: "migration state returned HTTP 500",
            status: 500,
            code: null,
        });
        expect(attempts).toBe(3);
        expect(clock).toBe(25);
    });

    test("proves phases, namespace isolation, retry identity, redeploy, and secret-free benchmark evidence", async () => {
        let clock = 0;
        let stateSequence = [
            vectorState({ phase: "submit" }),
            vectorState({ phase: "verify" }),
            vectorState({ state: "ready", version: 1, deliveredVersion: 1 }),
        ];
        const mutationBodies: Record<string, unknown>[] = [];
        const owner = { cookie: "owner-cookie-secret", token: "owner-token-secret", userId: "owner-user" };
        const member = { cookie: "member-cookie-secret", token: "member-token-secret", userId: "member-user" };
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async (request, init) => {
                const url = requestUrl(request);
                if (url.pathname === "/health") {
                    return response({
                        ok: true,
                        schemaVersion: 1,
                        releaseSha256: HASH_A,
                        vectorResources: 1,
                        proofConfigured: true,
                    });
                }
                if (url.pathname === "/proof/vector-state")
                    return response(stateSequence.shift() ?? stateSequence.at(-1));
                if (url.pathname === "/proof/vector-intent") {
                    expect(url.searchParams.get("organizationId")).toBe("org-owning");
                    expect(url.searchParams.get("id")).toBe("document-1");
                    expect(url.searchParams.get("action")).toBe("create");
                    return response({
                        vectorId: VECTOR_ID,
                        action: "upsert",
                        nextVersion: 1,
                        physicalIds: [PHYSICAL_ID],
                    });
                }
                if (url.pathname === "/proof/vector-fault/arm") {
                    expect(header(init, "authorization")).toBe(`Bearer ${ADMIN.token}`);
                    const body = requestBody(init);
                    expect(body.vectorId).toBe(VECTOR_ID);
                    return response({ armed: true, mode: body.mode, vectorId: body.vectorId });
                }
                if (url.pathname === "/api/vector-documents" && init?.method === "POST") {
                    expect(header(init, "authorization")).toBe(`Bearer ${owner.token}`);
                    const body = requestBody(init);
                    mutationBodies.push(body);
                    return response(body.action === "delete" ? { id: body.id } : { id: body.id, vectorId: VECTOR_ID });
                }
                if (url.pathname === "/api/vector-documents") {
                    expect(url.searchParams.get("organizationId")).toBe("org-owning");
                    expect(url.searchParams.get("limit")).toBe("10");
                    return response([{ id: "document-1", body: "replacement" }]);
                }
                if (url.pathname === "/api/vector-search") {
                    expect(header(init, "authorization")).toMatch(/^Bearer (?:owner|member)-token-secret$/);
                    const body = requestBody(init);
                    return response(body.organizationId === "org-owning" ? [{ rowPk: "document-1", score: 0.99 }] : []);
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });

        expect(await lifecycle.health({ origin: ORIGIN, releaseSha256: HASH_A })).toEqual({
            ok: true,
            schemaVersion: 1,
            releaseSha256: HASH_A,
            vectorResources: 1,
            proofConfigured: true,
        });
        expect(
            await lifecycle.vectorIntent({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                id: "document-1",
                action: "create",
            })
        ).toEqual({ vectorId: VECTOR_ID, action: "upsert", nextVersion: 1, physicalIds: [PHYSICAL_ID] });
        const mutationIds = vectorProofMutationIds("stable-run");
        expect(
            await lifecycle.mutateVector({
                origin: ORIGIN,
                principal: owner,
                action: "create",
                id: "document-1",
                organizationId: "org-owning",
                mutId: mutationIds.create,
                text: "initial",
                values: VECTOR_VALUES,
            })
        ).toEqual({ id: "document-1", vectorId: VECTOR_ID });
        expect(
            await lifecycle.mutateVector({
                origin: ORIGIN,
                principal: owner,
                action: "replace",
                id: "document-1",
                organizationId: "org-owning",
                mutId: mutationIds.replace,
                text: "replacement",
                values: REPLACEMENT_VALUES,
            })
        ).toEqual({ id: "document-1", vectorId: VECTOR_ID });
        expect(
            await lifecycle.mutateVector({
                origin: ORIGIN,
                principal: owner,
                action: "delete",
                id: "document-1",
                organizationId: "org-owning",
                mutId: mutationIds.delete,
            })
        ).toEqual({ id: "document-1" });
        expect(mutationBodies.map(body => body.mutId)).toEqual([
            "vector-create:stable-run",
            "vector-replace:stable-run",
            "vector-delete:stable-run",
        ]);
        expect(mutationBodies[2]).not.toHaveProperty("text");
        expect(mutationBodies[2]).not.toHaveProperty("values");
        expect(
            await lifecycle.listVectorDocuments({
                origin: ORIGIN,
                principal: owner,
                organizationId: "org-owning",
                limit: 10,
            })
        ).toEqual([{ id: "document-1", body: "replacement" }]);
        expect(
            await lifecycle.armFault({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                mode: "upsert_accept_then_throw",
            })
        ).toEqual({ armed: true, mode: "upsert_accept_then_throw", vectorId: VECTOR_ID });
        const driftedArm = createCloudflareVectorizeProofLifecycle({
            fetch: async () =>
                response({
                    armed: true,
                    mode: "upsert_accept_then_throw",
                    vectorId: `vec1_${"c".repeat(64)}`,
                }),
            requestTimeoutMs: 100,
        });
        await expect(
            driftedArm.armFault({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                mode: "upsert_accept_then_throw",
            })
        ).rejects.toThrow("vector fault armed a different logical vector");

        const ready = await lifecycle.pollReady({
            origin: ORIGIN,
            admin: ADMIN,
            organizationId: "org-owning",
            vectorId: VECTOR_ID,
            version: 1,
            timeoutMs: 100,
            intervalMs: 10,
        });
        expect(ready.phases).toEqual(["submit", "verify"]);
        expect(ready.result).toEqual({ ready: true });

        const isolation = await lifecycle.proveNamespaceIsolation({
            origin: ORIGIN,
            owner,
            member,
            owningOrganizationId: "org-owning",
            isolatedOrganizationId: "org-isolated",
            vectorId: VECTOR_ID,
            expectedRowPk: "document-1",
            values: VECTOR_VALUES,
            timeoutMs: 100,
            intervalMs: 10,
        });
        expect(isolation).toMatchObject({
            namespaceIsolation: true,
            owningMatches: 1,
            isolatedMatches: 0,
            queryVisibilityElapsedMs: 0,
            queryVisibilityAttempts: 1,
            hardBoundClaimed: false,
        });
        expect(JSON.stringify(isolation)).not.toContain("secret");

        stateSequence = [
            vectorState({ phase: "submit", state: "deleting", ambiguous: true }),
            vectorState({ phase: "verify", state: "deleting", ambiguous: true }),
            vectorState({ phase: "submit", state: "deleting", ambiguous: true }),
        ];
        const deleted = await lifecycle.pollDeleted({
            origin: ORIGIN,
            admin: ADMIN,
            organizationId: "org-owning",
            vectorId: VECTOR_ID,
            timeoutMs: 100,
            intervalMs: 10,
        });
        expect(deleted.phases).toEqual(["submit", "verify", "submit"]);
        expect(deleted.result).toEqual({ absent: true, retainedTombstone: true });

        const upsertFault: NonNullable<VectorProofState["fault"]> = {
            mode: "upsert_accept_then_throw",
            armed: false,
            inFlight: false,
            fired: true,
            firstPhysicalIds: [PHYSICAL_ID],
            firstPayloadSha256: HASH_A,
            returnedMutationIdSha256: HASH_B,
            acceptedBeforeThrow: true,
            retryCount: 1,
            retryIdsMatched: true,
            retryPayloadMatched: true,
            retryComplete: true,
            gateOpen: false,
            gateDeadline: null,
            updatedAt: 10,
        };
        const deleteFault: NonNullable<VectorProofState["fault"]> = {
            ...upsertFault,
            mode: "delete_accept_then_throw",
            firstPhysicalIds: [PHYSICAL_ID, `p1_${WIRE_VECTOR_DIGEST}_2`],
            firstPayloadSha256: null,
            returnedMutationIdSha256: HASH_A,
        };
        const retryEvidence = collectResponseLossRetryEvidence({
            upsertState: vectorState({ fault: upsertFault }),
            deleteState: vectorState({ fault: deleteFault }),
            secrets: [ADMIN.token, owner.cookie, owner.token],
        });
        expect(retryEvidence.upsert).toMatchObject({
            physicalId: PHYSICAL_ID,
            retryPhysicalId: PHYSICAL_ID,
            payloadSha256: HASH_A,
            retryPayloadSha256: HASH_A,
        });
        expect(retryEvidence.delete.physicalIds).toEqual(retryEvidence.delete.retryPhysicalIds);
        expect(JSON.stringify(retryEvidence)).not.toContain("secret");
        expect(() =>
            collectResponseLossRetryEvidence({
                upsertState: vectorState({ fault: { ...upsertFault, retryIdsMatched: false } }),
                deleteState: vectorState({ fault: deleteFault }),
            })
        ).toThrow("physical ids changed");
        expect(mutationIds).toEqual({
            create: "vector-create:stable-run",
            replace: "vector-replace:stable-run",
            delete: "vector-delete:stable-run",
            liveCreate: "vector-live-create:stable-run",
            liveReplace: "vector-live-replace:stable-run",
            liveDelete: "vector-live-delete:stable-run",
        });

        const benchmark = await lifecycle.measure({
            origin: ORIGIN,
            label: "deployed-vectorize",
            operation: async sample => {
                expect(sample.excluded).toBe(sample.sequence === -1);
                clock += 3;
                return true;
            },
            secrets: [ADMIN.token],
        });
        expect(benchmark.warmup).toMatchObject({
            requestOrdinal: 0,
            sequence: -1,
            excluded: true,
            classification: "exact",
            elapsedMs: 3,
        });
        expect(benchmark.samples).toHaveLength(5);
        expect(benchmark.samples.map(sample => sample.sequence)).toEqual([0, 1, 2, 3, 4]);

        expect(() => assertSecretFreeVectorEvidence({ token: "leak" })).toThrow("secret field");
    });

    test("keeps the fixed one-shot stream and records misses without replacing latency samples", async () => {
        let clock = 0;
        const scheduledOutcomes = [
            true,
            true,
            false,
            true,
            { classification: "http-5xx", status: 503, code: "EDGE" },
            false,
        ];
        let scheduledCalls = 0;
        let recoveryCalls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
        });
        const benchmark = await lifecycle.measure({
            origin: ORIGIN,
            label: "fixed-stream",
            timeoutMs: 100,
            intervalMs: 10,
            operation: async sample => {
                clock += 2;
                if (sample.phase === "scheduled") return scheduledOutcomes[scheduledCalls++] as never;
                recoveryCalls++;
                return recoveryCalls === 1 ? { classification: "timeout" as const } : true;
            },
        });
        expect(scheduledCalls).toBe(6);
        expect(recoveryCalls).toBe(2);
        expect(benchmark.samples.map(sample => sample.classification)).toEqual([
            "exact",
            "empty",
            "exact",
            "http-5xx",
            "empty",
        ]);
        expect(benchmark.exactMatchLatenciesMs).toEqual([2, 2]);
        expect(benchmark.postStabilitySampling).toMatchObject({
            scheduledRequestCount: 6,
            exactResponseCount: 3,
            exactResponseRatio: 0.5,
            availabilityMissCount: 3,
            emptyResponseCount: 2,
            http5xxResponseCount: 1,
            timeoutResponseCount: 0,
            reacquisitionCount: 2,
            availabilityPassThreshold: null,
            hardBoundClaimed: false,
        });
        expect(benchmark.postStabilitySampling.reacquisitionObservations.map(item => item.classification)).toEqual([
            "timeout",
            "exact",
        ]);
    });

    test("polls an empty owning search until the exact vector becomes query-visible", async () => {
        let clock = 0;
        let owningSearches = 0;
        let isolatedSearches = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async (_request, init) => {
                const body = requestBody(init);
                if (body.organizationId === "org-owning") {
                    owningSearches++;
                    return response(owningSearches === 1 ? [] : [{ rowPk: "document-1", score: 1 }]);
                }
                isolatedSearches++;
                return response([]);
            },
            requestTimeoutMs: 50,
        });
        const result = await lifecycle.proveNamespaceIsolation({
            origin: ORIGIN,
            owner: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
            member: { cookie: "member-cookie", token: "member-token", userId: "member" },
            owningOrganizationId: "org-owning",
            isolatedOrganizationId: "org-isolated",
            vectorId: VECTOR_ID,
            expectedRowPk: "document-1",
            values: VECTOR_VALUES,
            limit: 1,
            timeoutMs: 100,
            intervalMs: 10,
        });
        expect(result).toMatchObject({
            namespaceIsolation: true,
            owningMatches: 1,
            isolatedMatches: 0,
            queryVisibilityElapsedMs: 10,
            queryVisibilityAttempts: 2,
            transientHttpFailureCount: 0,
            transientHttpFailureCounts: [],
            transientHttpFailureOverflowCount: 0,
            hardBoundClaimed: false,
        });
        expect(owningSearches).toBe(2);
        expect(isolatedSearches).toBe(1);
    });

    test("recovers a transient owning-search 503 inside the settlement deadline and records its safe code", async () => {
        let clock = 0;
        let owningSearches = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async (_request, init) => {
                const body = requestBody(init);
                if (body.organizationId === "org-isolated") return response([]);
                owningSearches++;
                if (owningSearches === 2) {
                    return response(
                        { error: { code: "CDB_ROUTE_UNAVAILABLE", message: "private detail" } },
                        { status: 503 }
                    );
                }
                return response([{ rowPk: "document-1", score: 1 }]);
            },
            requestTimeoutMs: 50,
        });
        const result = await lifecycle.proveNamespaceIsolation({
            origin: ORIGIN,
            owner: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
            member: { cookie: "member-cookie", token: "member-token", userId: "member" },
            owningOrganizationId: "org-owning",
            isolatedOrganizationId: "org-isolated",
            vectorId: VECTOR_ID,
            expectedRowPk: "document-1",
            values: VECTOR_VALUES,
            timeoutMs: 200,
            intervalMs: 10,
            stabilityWindowMs: 20,
        });
        expect(result).toMatchObject({
            queryVisibilityElapsedMs: 40,
            queryVisibilityAttempts: 5,
            queryStabilityWindowMs: 20,
            queryStabilityObservedMs: 20,
            queryStabilityExactMatchCount: 3,
            queryStabilityResetCount: 1,
            queryStabilityNonExactCount: 0,
            transientHttpFailureCount: 1,
            transientHttpFailureCounts: [{ status: 503, code: "CDB_ROUTE_UNAVAILABLE", count: 1 }],
            transientHttpFailureOverflowCount: 0,
            hardBoundClaimed: false,
        });
        expect(JSON.stringify(result)).not.toContain("private detail");
    });

    test("resets the stability window after an empty owning result and requires a fresh boundary match", async () => {
        let clock = 0;
        let owningSearches = 0;
        let isolatedSearches = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async (_request, init) => {
                const request = requestBody(init);
                if (request.organizationId === "org-isolated") {
                    isolatedSearches++;
                    return response([]);
                }
                owningSearches++;
                if (owningSearches === 2) return response([]);
                return response([{ rowPk: "document-1", score: 1 }]);
            },
            requestTimeoutMs: 50,
        });
        const result = await lifecycle.proveNamespaceIsolation({
            origin: ORIGIN,
            owner: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
            member: { cookie: "member-cookie", token: "member-token", userId: "member" },
            owningOrganizationId: "org-owning",
            isolatedOrganizationId: "org-isolated",
            vectorId: VECTOR_ID,
            expectedRowPk: "document-1",
            values: VECTOR_VALUES,
            timeoutMs: 200,
            intervalMs: 10,
            stabilityWindowMs: 20,
        });
        expect(result).toMatchObject({
            queryVisibilityElapsedMs: 40,
            queryVisibilityAttempts: 5,
            queryStabilityWindowMs: 20,
            queryStabilityObservedMs: 20,
            queryStabilityExactMatchCount: 3,
            queryStabilityResetCount: 1,
            queryStabilityNonExactCount: 1,
        });
        expect(owningSearches).toBe(5);
        expect(isolatedSearches).toBe(1);
    });

    test("bounds repeated owning-search 5xx recovery by the existing settlement deadline", async () => {
        let clock = 0;
        let calls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async (_request, init) => {
                calls++;
                const signal = init?.signal;
                expect(signal).toBeInstanceOf(AbortSignal);
                return response({ code: "EDGE_UNAVAILABLE" }, { status: 503 });
            },
            requestTimeoutMs: 50,
        });
        const error = await lifecycle
            .proveNamespaceIsolation({
                origin: ORIGIN,
                owner: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
                member: { cookie: "member-cookie", token: "member-token", userId: "member" },
                owningOrganizationId: "org-owning",
                isolatedOrganizationId: "org-isolated",
                vectorId: VECTOR_ID,
                expectedRowPk: "document-1",
                values: VECTOR_VALUES,
                timeoutMs: 25,
                intervalMs: 10,
            })
            .catch(cause => cause);
        expect(error).toBeInstanceOf(CloudflareVectorizeProofSettlementError);
        expect(error).toMatchObject({
            evidence: {
                checkpoint: "owning-filtered-search",
                timeoutMs: 25,
                elapsedMs: 25,
                queryVisibilityAttempts: 3,
                transientHttpFailureCount: 3,
                transientHttpFailureCounts: [{ status: 503, code: "EDGE_UNAVAILABLE", count: 3 }],
                transientHttpFailureOverflowCount: 0,
                hardBoundClaimed: false,
            },
        });
        expect(calls).toBe(3);
    });

    test("times out when an owning filtered search never becomes query-visible", async () => {
        let clock = 0;
        let isolatedSearches = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async (_request, init) => {
                if (requestBody(init).organizationId === "org-isolated") isolatedSearches++;
                return response([]);
            },
            requestTimeoutMs: 50,
        });
        await expect(
            lifecycle.proveNamespaceIsolation({
                origin: ORIGIN,
                owner: { cookie: "owner-cookie", token: "owner-token", userId: "owner" },
                member: { cookie: "member-cookie", token: "member-token", userId: "member" },
                owningOrganizationId: "org-owning",
                isolatedOrganizationId: "org-isolated",
                vectorId: VECTOR_ID,
                expectedRowPk: "document-1",
                values: VECTOR_VALUES,
                timeoutMs: 25,
                intervalMs: 10,
            })
        ).rejects.toThrow("owning organization search visibility timed out after 25ms");
        expect(isolatedSearches).toBe(0);
    });

    test("validates bounded proof observation and stored alarm timestamps", async () => {
        for (const [field, value, message] of [
            ["observedAt", -1, "vector observation time is invalid"],
            ["observedAt", 1.5, "vector observation time is invalid"],
            ["observedAt", "100", "vector observation time is invalid"],
            ["scheduledAlarmAt", -1, "vector scheduled alarm time is invalid"],
            ["scheduledAlarmAt", 1.5, "vector scheduled alarm time is invalid"],
            ["scheduledAlarmAt", "1250", "vector scheduled alarm time is invalid"],
        ] as const) {
            const malformed = { ...vectorState({ phase: "submit" }), [field]: value };
            const lifecycle = createCloudflareVectorizeProofLifecycle({
                fetch: async () => response(malformed),
                requestTimeoutMs: 100,
            });
            await expect(
                lifecycle.vectorState({
                    origin: ORIGIN,
                    admin: ADMIN,
                    organizationId: "org-owning",
                    vectorId: VECTOR_ID,
                })
            ).rejects.toThrow(message);
        }

        const scheduled = { ...vectorState({ phase: "submit" }), observedAt: 1_000, scheduledAlarmAt: 1_250 };
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            fetch: async () => response(scheduled),
            requestTimeoutMs: 100,
        });
        await expect(
            lifecycle.vectorState({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
            })
        ).resolves.toMatchObject({ observedAt: 1_000, scheduledAlarmAt: 1_250 });
    });

    test("times out a vector poll using only the injected fetch, clock, and sleep", async () => {
        let clock = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") return response(vectorState({ phase: "submit" }));
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });
        const error = await lifecycle
            .pollReady({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                version: 1,
                timeoutMs: 25,
                intervalMs: 10,
            })
            .catch(cause => cause);
        expect(error).toBeInstanceOf(CloudflareVectorizeProofSettlementError);
        expect(error).toMatchObject({
            message: "vector readiness timed out after 25ms",
            evidence: {
                checkpoint: "vector-ready",
                outcome: "timed_out",
                timeoutMs: 25,
                elapsedMs: 25,
                pollAttempts: 4,
                phaseProgression: ["submit"],
                phaseProgressionOverflowCount: 0,
                latestState: {
                    vectorId: VECTOR_ID,
                    outbox: {
                        phase: "submit",
                        terminalFailure: false,
                        lastErrorClassification: null,
                        lastErrorSha256: null,
                    },
                },
                hardBoundClaimed: false,
            },
        });
        expect(assertSecretFreeVectorEvidence(error.evidence, [ADMIN.token])).toBe(error.evidence);
        expect(clock).toBe(25);
    });

    test("recovers a non-JSON vector-state 503 with passive polling", async () => {
        let clock = 0;
        let stateCalls = 0;
        let maintainCalls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") {
                    stateCalls++;
                    if (stateCalls === 1) {
                        return new Response("upstream unavailable", { status: 503 });
                    }
                    return response(
                        stateCalls === 2
                            ? vectorState({ phase: "submit" })
                            : vectorState({ phase: "verify", state: "ready", deliveredVersion: 1 })
                    );
                }
                if (url.pathname === "/proof/vector-maintain") {
                    maintainCalls++;
                    return response({ invoked: true });
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });
        const result = await lifecycle.pollReady({
            origin: ORIGIN,
            admin: ADMIN,
            organizationId: "org-owning",
            vectorId: VECTOR_ID,
            version: 1,
            timeoutMs: 100,
            intervalMs: 10,
        });
        expect(result).toMatchObject({
            phases: ["submit", "verify"],
            pollAttempts: 3,
            transientHttpFailureCount: 1,
            transientHttpFailureCounts: [{ status: 503, code: null, count: 1 }],
            transientHttpFailureOverflowCount: 0,
            result: { ready: true },
        });
        expect(stateCalls).toBe(3);
        expect(maintainCalls).toBe(0);
        expect(clock).toBe(20);
    });

    test("retries bounded route, RPC, and ordinary 5xx state reads without maintenance", async () => {
        const transientFailures = [
            { status: 500, code: "CDB_PROOF_VECTOR_STATE_ROUTE_FAILED" },
            { status: 500, code: "CDB_PROOF_VECTOR_STATE_RPC_FAILED" },
            { status: 503, code: null },
        ];
        let clock = 0;
        let stateCalls = 0;
        let maintainCalls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") {
                    stateCalls++;
                    const failure = transientFailures[stateCalls - 1];
                    if (failure) {
                        return response(
                            failure.code === null ? { ok: false } : { ok: false, error: { code: failure.code } },
                            { status: failure.status }
                        );
                    }
                    return response(
                        stateCalls === 4
                            ? vectorState({ phase: "submit" })
                            : vectorState({ phase: "verify", state: "ready", deliveredVersion: 1 })
                    );
                }
                if (url.pathname === "/proof/vector-maintain") {
                    maintainCalls++;
                    return response({ invoked: true });
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });
        const result = await lifecycle.pollReady({
            origin: ORIGIN,
            admin: ADMIN,
            organizationId: "org-owning",
            vectorId: VECTOR_ID,
            version: 1,
            timeoutMs: 100,
            intervalMs: 10,
        });
        expect(result).toMatchObject({
            phases: ["submit", "verify"],
            pollAttempts: 5,
            transientHttpFailureCount: 3,
            transientHttpFailureCounts: transientFailures.map(item => ({ ...item, count: 1 })),
            transientHttpFailureOverflowCount: 0,
            result: { ready: true },
        });
        expect(stateCalls).toBe(5);
        expect(maintainCalls).toBe(0);
        expect(clock).toBe(40);
    });

    test("bounds a persistent read-only RPC failure by the existing settlement deadline", async () => {
        let clock = 0;
        let stateCalls = 0;
        let maintainCalls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") {
                    stateCalls++;
                    return response(
                        { ok: false, error: { code: "CDB_PROOF_VECTOR_STATE_RPC_FAILED" } },
                        { status: 500 }
                    );
                }
                if (url.pathname === "/proof/vector-maintain") {
                    maintainCalls++;
                    return response({ invoked: true });
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });
        const error = await lifecycle
            .pollReady({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                version: 1,
                timeoutMs: 25,
                intervalMs: 10,
            })
            .catch(cause => cause);
        expect(error).toBeInstanceOf(CloudflareVectorizeProofSettlementError);
        expect(error).toMatchObject({
            evidence: {
                checkpoint: "vector-ready",
                outcome: "timed_out",
                elapsedMs: 25,
                pollAttempts: 4,
                transientHttpFailureCount: 4,
                transientHttpFailureCounts: [{ status: 500, code: "CDB_PROOF_VECTOR_STATE_RPC_FAILED", count: 4 }],
            },
        });
        expect(stateCalls).toBe(4);
        expect(maintainCalls).toBe(0);
        expect(clock).toBe(25);
    });

    test("fails deterministic proof-state diagnostics without sleeping or maintenance", async () => {
        for (const code of [
            "CDB_PROOF_VECTOR_STATE_OUTBOX_READ_FAILED",
            "CDB_PROOF_VECTOR_STATE_RESPONSE_JSON_FAILED",
            "CDB_PROOF_VECTOR_STATE_ALARM_READ_FAILED",
            "CDB_PROOF_VECTOR_STATE_ALARM_TIMESTAMP_INVALID",
        ]) {
            let stateCalls = 0;
            let maintainCalls = 0;
            let sleepCalls = 0;
            const lifecycle = createCloudflareVectorizeProofLifecycle({
                sleep: async () => {
                    sleepCalls++;
                },
                fetch: async request => {
                    const url = requestUrl(request);
                    if (url.pathname === "/proof/vector-state") {
                        stateCalls++;
                        return response({ ok: false, error: { code } }, { status: 500 });
                    }
                    if (url.pathname === "/proof/vector-maintain") {
                        maintainCalls++;
                        return response({ invoked: true });
                    }
                    throw new Error(`unexpected route ${url.pathname}`);
                },
                requestTimeoutMs: 100,
            });
            const error = await lifecycle
                .pollReady({
                    origin: ORIGIN,
                    admin: ADMIN,
                    organizationId: "org-owning",
                    vectorId: VECTOR_ID,
                    version: 1,
                    timeoutMs: 100,
                    intervalMs: 10,
                })
                .catch(cause => cause);
            expect(error).toBeInstanceOf(CloudflareVectorizeProofHttpError);
            expect(error).toMatchObject({ status: 500, code, kind: "http" });
            expect(stateCalls).toBe(1);
            expect(maintainCalls).toBe(0);
            expect(sleepCalls).toBe(0);
            expect(isCloudflareVectorizeProofRetryableStateRead(error)).toBe(false);
        }
        for (const code of ["CDB_PROOF_VECTOR_STATE_ROUTE_FAILED", "CDB_PROOF_VECTOR_STATE_RPC_FAILED"]) {
            expect(
                isCloudflareVectorizeProofRetryableStateRead(
                    new CloudflareVectorizeProofHttpError("bounded", 500, code, "http")
                )
            ).toBe(true);
        }
    });

    test("fails each proof hash diagnostic on its first state read without sleeping or maintenance", async () => {
        for (const code of [
            "CDB_PROOF_VECTOR_STATE_MUTATION_ID_HASH_FAILED",
            "CDB_PROOF_VECTOR_STATE_CLAIM_TOKEN_HASH_FAILED",
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_FAILED",
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_INPUT_INVALID",
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_DIGEST_FAILED",
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_OUTPUT_INVALID",
            "CDB_PROOF_VECTOR_STATE_LAST_ERROR_HASH_HEX_INVALID",
        ]) {
            let stateCalls = 0;
            let maintainCalls = 0;
            let sleepCalls = 0;
            const lifecycle = createCloudflareVectorizeProofLifecycle({
                sleep: async () => {
                    sleepCalls++;
                },
                fetch: async request => {
                    const url = requestUrl(request);
                    if (url.pathname === "/proof/vector-state") {
                        stateCalls++;
                        return response({ ok: false, error: { code } }, { status: 500 });
                    }
                    if (url.pathname === "/proof/vector-maintain") {
                        maintainCalls++;
                        return response({ invoked: true });
                    }
                    throw new Error(`unexpected route ${url.pathname}`);
                },
                requestTimeoutMs: 100,
            });

            const error = await lifecycle
                .pollReady({
                    origin: ORIGIN,
                    admin: ADMIN,
                    organizationId: "org-owning",
                    vectorId: VECTOR_ID,
                    version: 1,
                    timeoutMs: 100,
                    intervalMs: 10,
                })
                .catch(cause => cause);
            expect(error).toBeInstanceOf(CloudflareVectorizeProofHttpError);
            expect(error).toMatchObject({ status: 500, code, kind: "http" });
            expect(isCloudflareVectorizeProofRetryableStateRead(error)).toBe(false);
            expect(stateCalls).toBe(1);
            expect(maintainCalls).toBe(0);
            expect(sleepCalls).toBe(0);
        }
    });

    test("exhausts repeated vector-state timeouts at the existing deadline with counted evidence", async () => {
        let clock = 0;
        let stateCalls = 0;
        let maintainCalls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") {
                    stateCalls++;
                    return new Promise<Response>(() => undefined);
                }
                if (url.pathname === "/proof/vector-maintain") {
                    maintainCalls++;
                    return Promise.resolve(response({ invoked: true }));
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            setTimeout: callback => {
                queueMicrotask(callback);
                return 1;
            },
            clearTimeout: () => undefined,
            requestTimeoutMs: 1,
        });
        const error = await lifecycle
            .pollDeleted({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                timeoutMs: 25,
                intervalMs: 10,
            })
            .catch(cause => cause);
        expect(error).toBeInstanceOf(CloudflareVectorizeProofSettlementError);
        expect(error).toMatchObject({
            evidence: {
                checkpoint: "vector-deleted",
                outcome: "timed_out",
                timeoutMs: 25,
                elapsedMs: 25,
                pollAttempts: 4,
                phaseProgression: [],
                latestState: null,
                transientHttpFailureCount: 4,
                transientHttpFailureCounts: [{ status: null, code: null, count: 4 }],
                transientHttpFailureOverflowCount: 0,
                hardBoundClaimed: false,
            },
        });
        expect(stateCalls).toBe(4);
        expect(maintainCalls).toBe(0);
    });

    test("does not retry after a non-JSON vector-state 4xx", async () => {
        let stateCalls = 0;
        let maintainCalls = 0;
        let sleepCalls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            sleep: async () => {
                sleepCalls++;
            },
            fetch: async request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") {
                    stateCalls++;
                    return new Response("not-json-admin-secret-value", { status: 403 });
                }
                if (url.pathname === "/proof/vector-maintain") {
                    maintainCalls++;
                    return response({ invoked: true });
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });
        const error = await lifecycle
            .pollReady({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                version: 1,
                timeoutMs: 100,
                intervalMs: 10,
            })
            .catch(cause => cause);
        expect(error).toMatchObject({
            status: 403,
            code: null,
            kind: "http",
            protocolReason: "invalid_json",
        });
        expect(String(error)).not.toContain("admin-secret-value");
        expect(stateCalls).toBe(1);
        expect(maintainCalls).toBe(0);
        expect(sleepCalls).toBe(0);
    });

    test("does not retry after a malformed successful vector-state response", async () => {
        let stateCalls = 0;
        let maintainCalls = 0;
        let sleepCalls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            sleep: async () => {
                sleepCalls++;
            },
            fetch: async request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") {
                    stateCalls++;
                    return new Response("not-json-admin-secret-value");
                }
                if (url.pathname === "/proof/vector-maintain") {
                    maintainCalls++;
                    return response({ invoked: true });
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });
        const error = await lifecycle
            .pollReady({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                version: 1,
                timeoutMs: 100,
                intervalMs: 10,
            })
            .catch(cause => cause);
        expect(error).toMatchObject({
            status: null,
            code: null,
            kind: "protocol",
            protocolReason: "invalid_json",
        });
        expect(String(error)).not.toContain("admin-secret-value");
        expect(stateCalls).toBe(1);
        expect(maintainCalls).toBe(0);
        expect(sleepCalls).toBe(0);
    });

    test("fails deletion immediately with structured evidence when absence becomes terminally unproven", async () => {
        let maintainCalls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            fetch: async request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") {
                    return response(
                        vectorState({ phase: "verify", state: "deleting", version: 3, terminalFailure: true })
                    );
                }
                if (url.pathname === "/proof/vector-maintain") {
                    maintainCalls++;
                    return response({ invoked: true });
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });
        const error = await lifecycle
            .pollDeleted({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                timeoutMs: 600_000,
                intervalMs: 250,
            })
            .catch(cause => cause);
        expect(error).toBeInstanceOf(CloudflareVectorizeProofSettlementError);
        expect(error).toMatchObject({
            message: "vector deletion failed because external absence could not be proven",
            evidence: {
                checkpoint: "vector-deleted",
                outcome: "failed_unproven",
                timeoutMs: 600_000,
                pollAttempts: 1,
                phaseProgression: ["verify"],
                phaseProgressionOverflowCount: 0,
                latestState: {
                    vectorId: VECTOR_ID,
                    head: { state: "deleting", version: 3 },
                    outbox: {
                        operation: "delete",
                        phase: "verify",
                        attempts: 1,
                        terminalFailure: true,
                        lastErrorClassification: "delete_absence_unproven",
                        lastErrorSha256: HASH_B,
                    },
                },
                hardBoundClaimed: false,
            },
        });
        expect(maintainCalls).toBe(0);
        expect(assertSecretFreeVectorEvidence(error.evidence, [ADMIN.token])).toBe(error.evidence);
    });

    test("accepts durable response-loss settlement when alarms finish deletion before the first phase sample", async () => {
        let maintainCalls = 0;
        const settledFault: NonNullable<VectorProofState["fault"]> = {
            mode: "delete_accept_then_throw",
            armed: false,
            inFlight: false,
            fired: true,
            firstPhysicalIds: [PHYSICAL_ID, `p1_${WIRE_VECTOR_DIGEST}_2`],
            firstPayloadSha256: null,
            returnedMutationIdSha256: HASH_A,
            acceptedBeforeThrow: true,
            retryCount: 1,
            retryIdsMatched: true,
            retryPayloadMatched: true,
            retryComplete: true,
            gateOpen: false,
            gateDeadline: null,
            updatedAt: 10,
        };
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            fetch: async request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") {
                    return response(vectorState({ absent: true, fault: settledFault }));
                }
                if (url.pathname === "/proof/vector-maintain") {
                    maintainCalls++;
                    throw new Error("settled deletion must not run maintenance");
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });

        await expect(
            lifecycle.pollDeleted({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                requiredPhases: ["submit", "verify"],
                timeoutMs: 600_000,
                intervalMs: 250,
            })
        ).resolves.toMatchObject({
            phases: [],
            result: { absent: true, retainedTombstone: false },
            state: { head: null, outbox: null, fault: settledFault },
        });
        expect(maintainCalls).toBe(0);
    });

    test("does not accept bare durable absence when required delete phases were never sampled", async () => {
        let clock = 0;
        let maintainCalls = 0;
        const lifecycle = createCloudflareVectorizeProofLifecycle({
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            },
            fetch: async request => {
                const url = requestUrl(request);
                if (url.pathname === "/proof/vector-state") return response(vectorState({ absent: true }));
                if (url.pathname === "/proof/vector-maintain") {
                    maintainCalls++;
                    return response({ invoked: true });
                }
                throw new Error(`unexpected route ${url.pathname}`);
            },
            requestTimeoutMs: 100,
        });

        const error = await lifecycle
            .pollDeleted({
                origin: ORIGIN,
                admin: ADMIN,
                organizationId: "org-owning",
                vectorId: VECTOR_ID,
                requiredPhases: ["submit", "verify"],
                timeoutMs: 25,
                intervalMs: 10,
            })
            .catch(cause => cause);
        expect(error).toBeInstanceOf(CloudflareVectorizeProofSettlementError);
        expect(error).toMatchObject({
            message: "vector deletion timed out after 25ms",
            evidence: {
                checkpoint: "vector-deleted",
                outcome: "timed_out",
                timeoutMs: 25,
                elapsedMs: 25,
                pollAttempts: 4,
                phaseProgression: [],
                latestState: { head: null, outbox: null, fault: null },
            },
        });
        expect(maintainCalls).toBe(0);
        expect(clock).toBe(25);
    });
});
