import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { openCloudflareVectorizeProofLiveSubscription } from "../scripts/cloudflare-vectorize-proof-live.mjs";
import { createChardbClient } from "../src/client/index.ts";
import { CDB_ERROR_CODES, isRetryable } from "../src/errors.ts";

const VALUES = Object.freeze([2, 1, ...Array(30).fill(0)]);

function digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

class ProofWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: ProofWebSocket[] = [];
    static reconnectMustRefetchReason = "lagged";
    static duplicateReconnectRefetch = false;
    static reconnectRows: unknown[] = [{ rowPk: "live-document", score: 1 }];

    readyState = ProofWebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly url: string;
    readonly sent: string[] = [];
    subscriptionCount = 0;

    constructor(url: string | URL) {
        this.url = String(url);
        ProofWebSocket.instances.push(this);
        queueMicrotask(() => {
            this.readyState = ProofWebSocket.OPEN;
            this.onopen?.(new Event("open"));
        });
    }

    send(raw: string): void {
        this.sent.push(raw);
        const message = JSON.parse(raw) as Record<string, unknown>;
        if (message.t === "hello") {
            const resumed = message.resumeFromCookie;
            queueMicrotask(() =>
                this.emit({
                    t: "welcome",
                    protocolV: 3,
                    baseCookie: resumed ?? "base:0",
                    ...(resumed ? { resumedFromCookie: resumed } : {}),
                    region: "proof",
                })
            );
        } else if (message.t === "sub") {
            this.subscriptionCount++;
            if (ProofWebSocket.instances.length === 2 && this.subscriptionCount === 1) {
                queueMicrotask(() => {
                    this.emit({
                        t: "mustRefetch",
                        subIds: [1],
                        reason: ProofWebSocket.reconnectMustRefetchReason,
                    });
                    if (ProofWebSocket.duplicateReconnectRefetch) {
                        this.emit({
                            t: "mustRefetch",
                            subIds: [1],
                            reason: ProofWebSocket.reconnectMustRefetchReason,
                        });
                    }
                });
            } else {
                queueMicrotask(() =>
                    this.emit({
                        t: "snapshot",
                        subId: 1,
                        cookie: ProofWebSocket.instances.length === 1 ? "snapshot:1" : "snapshot:reconnect",
                        rows:
                            ProofWebSocket.instances.length === 1
                                ? [{ rowPk: "live-document", score: 1 }]
                                : ProofWebSocket.reconnectRows,
                    })
                );
            }
        }
    }

    close(): void {
        this.emitClose();
    }

    emitClose(code = 1000, reason = "", wasClean = true): void {
        if (this.readyState === ProofWebSocket.CLOSED) return;
        this.readyState = ProofWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code, reason, wasClean }));
    }

    emitError(): void {
        this.onerror?.(new Event("error"));
    }

    emit(message: unknown): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
}

function fakeCandidate(control?: { failSession?: () => void }) {
    return {
        CDB_ERROR_CODES: ["CDB_FORBIDDEN", "CDB_SHARD_UNAVAILABLE"],
        isRetryable(code: string) {
            return code === "CDB_SHARD_UNAVAILABLE";
        },
        createChardbClient(options: {
            readonly endpoint: string;
            readonly getJwt: () => Promise<string>;
            readonly clientId?: string;
            readonly onSessionError?: (diagnostic: { readonly code: string; readonly reason: string }) => void;
        }) {
            let socket: WebSocket | null = null;
            let callback: ((rows: unknown[], state: string) => void) | null = null;
            let closed = false;
            let lastCookie: string | undefined;
            let lastSnapshotCookie: string | undefined;
            const client = {
                state: "connecting",
                subscribe(_ref: string, _args: unknown, listener: (rows: unknown[], state: string) => void) {
                    callback = listener;
                    return { unsubscribe: () => undefined };
                },
                close() {
                    closed = true;
                    client.state = "closed";
                    socket?.close();
                },
            };
            const connect = async () => {
                const jwt = await options.getJwt();
                if (closed) return;
                const endpoint = new URL(options.endpoint);
                endpoint.searchParams.set("clientId", String(options.clientId));
                const next = new WebSocket(endpoint);
                socket = next;
                next.onopen = () => {
                    next.send(
                        JSON.stringify({
                            t: "hello",
                            protocolV: 3,
                            clientId: "live-client",
                            ...(lastCookie ? { resumeFromCookie: lastCookie } : {}),
                            jwt,
                        })
                    );
                };
                next.onmessage = event => {
                    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
                    if (message.t === "welcome") {
                        client.state = "open";
                        next.send(JSON.stringify({ t: "sub", subId: 1, ref: "proof", args: {} }));
                    } else if (message.t === "snapshot") {
                        const cookie = String(message.cookie);
                        lastCookie = cookie;
                        if (lastSnapshotCookie !== cookie) {
                            lastSnapshotCookie = cookie;
                            callback?.(message.rows as unknown[], "live");
                        }
                        next.send(JSON.stringify({ t: "ack", cookie }));
                    } else if (message.t === "mustRefetch") {
                        callback?.([], "refetching");
                        next.send(JSON.stringify({ t: "sub", subId: 1, ref: "proof", args: {} }));
                    } else if (message.t === "error") {
                        callback?.([], "error");
                    } else if (message.t === "candidateMalformed") {
                        client.state = "closed";
                        callback?.([], "error");
                    }
                };
                next.onclose = event => {
                    if (closed) return;
                    if (event.code === 4001) {
                        client.state = "closed";
                        callback?.([], "error");
                        return;
                    }
                    client.state = "reconnecting";
                    queueMicrotask(() => void connect());
                };
                next.onerror = () => {
                    if (closed) return;
                    client.state = "closed";
                    callback?.([], "error");
                };
            };
            if (control) {
                control.failSession = () => {
                    client.state = "closed";
                    options.onSessionError?.({ code: "CDB_FORBIDDEN", reason: "auth-refresh-read" });
                    callback?.([], "error");
                };
            }
            void connect();
            return client;
        },
    };
}

async function open(candidate = fakeCandidate(), getJwt?: () => Promise<string>) {
    ProofWebSocket.instances = [];
    ProofWebSocket.reconnectMustRefetchReason = "lagged";
    ProofWebSocket.duplicateReconnectRefetch = false;
    ProofWebSocket.reconnectRows = [{ rowPk: "live-document", score: 1 }];
    return openCloudflareVectorizeProofLiveSubscription(
        {
            candidateEntry: "/private/tmp/chardb-proof/dist/index.mjs",
            origin: "https://proof.example.com",
            organizationId: "org-owning",
            expectedRowPk: "live-document",
            expectedPendingFallbackRowPk: "lifecycle-document",
            values: VALUES,
            clientId: "live-client",
            jwt: "header.payload.signature",
            ...(getJwt ? { getJwt } : {}),
            timeoutMs: 2_000,
            reconnectStabilityMs: 1,
        },
        {
            WebSocket: ProofWebSocket,
            loadCandidate: async (specifier: string) => {
                expect(specifier).toBe("file:///private/tmp/chardb-proof/dist/index.mjs");
                return candidate;
            },
        }
    );
}

describe("Cloudflare Vectorize installed SDK live proof", () => {
    test("records real WebSocket resume, snapshot acknowledgements, and one replacement update", async () => {
        const session = await open();
        await session.reconnect();
        expect(
            ProofWebSocket.instances.map(socket => {
                const url = new URL(socket.url);
                return { pathname: url.pathname, query: [...url.searchParams.entries()] };
            })
        ).toEqual([
            { pathname: "/ws", query: [["clientId", "live-client"]] },
            { pathname: "/ws", query: [["clientId", "live-client"]] },
        ]);
        session.beginReplacement();
        ProofWebSocket.instances.at(-1)?.emit({
            t: "snapshot",
            subId: 1,
            cookie: "snapshot:2",
            rows: [{ rowPk: "lifecycle-document", score: 0.4 }],
        });
        await session.waitForPending();
        session.assertPending();
        const { allowCurrent } = session;
        allowCurrent();
        ProofWebSocket.instances.at(-1)?.emit({
            t: "snapshot",
            subId: 1,
            cookie: "snapshot:3",
            rows: [{ rowPk: "live-document", score: 0.8 }],
        });
        await session.waitForCurrent();
        expect(session.finish()).toEqual({
            sdk: "installed-candidate-createChardbClient",
            transport: "worker-websocket",
            auth: "better-auth-jwt",
            queryRefSha256: digest("cloudflare-vectorize-proof/api.ts#searchVectorDocuments"),
            clientIdSha256: digest("live-client"),
            connectionCount: 2,
            helloCount: 2,
            welcomeCount: 2,
            reconnectCount: 1,
            authReadCount: 2,
            snapshotCount: 4,
            acknowledgementCount: 4,
            acknowledgementEverySnapshot: true,
            resume: {
                attempted: true,
                helloResumeMatchedInitialAck: true,
                welcomeResumeMatchedInitialAck: true,
                recovery: "lagged-refetch",
                refetchReason: "lagged",
                refetchStateCount: 1,
                baselineRestoreCount: 1,
                baselineRestoredExactly: true,
                baselineRestoreAcknowledged: true,
                initialCookieSha256: digest("snapshot:1"),
                finalCookieSha256: digest("snapshot:3"),
            },
            content: {
                callbackCount: 4,
                baselineUpdateCount: 1,
                pendingFallbackUpdateCount: 1,
                prematureCurrentUpdateCount: 0,
                replacementUpdateCount: 1,
                duplicateContentUpdateCount: 0,
                baselineRowsSha256: digest(JSON.stringify([{ rowPk: "live-document", score: 1 }])),
                pendingFallbackRowPkSha256: digest("lifecycle-document"),
                pendingRowsSha256: digest(JSON.stringify([{ rowPk: "lifecycle-document", score: 0.4 }])),
                replacementRowsSha256: digest(JSON.stringify([{ rowPk: "live-document", score: 0.8 }])),
            },
        });
    });

    test("accepts refreshed Better Auth credentials issued to the installed client", async () => {
        const issued = ["initial.jwt.signature", "refreshed.jwt.signature"];
        const session = await open(fakeCandidate(), async () => issued.shift() ?? "refreshed.jwt.signature");
        await session.reconnect();

        const hellos = ProofWebSocket.instances.map(socket =>
            socket.sent.map(raw => JSON.parse(raw) as Record<string, unknown>).find(message => message.t === "hello")
        );
        expect(hellos.map(hello => hello?.jwt)).toEqual(["initial.jwt.signature", "refreshed.jwt.signature"]);
        session.abort();
    });

    test("rejects a reconnect refetch unless one targeted lagged frame caused it", async () => {
        const session = await open();
        ProofWebSocket.reconnectMustRefetchReason = "authChanged";
        await expect(session.reconnect()).rejects.toThrow(
            'live SDK emitted unexpected refetching subscription state {"source":"inbound-frame","frameType":"mustRefetch","socketIndex":2,"reason":"authChanged","targeted":true,"reconnecting":true,"priorRefetchStateCount":0}'
        );
        session.abort();
    });

    test("rejects duplicate lagged reconnect refetch transitions", async () => {
        const session = await open();
        ProofWebSocket.duplicateReconnectRefetch = true;
        await expect(session.reconnect()).rejects.toThrow(
            'live SDK emitted unexpected refetching subscription state {"source":"inbound-frame","frameType":"mustRefetch","socketIndex":2,"reason":"lagged","targeted":true,"reconnecting":true,"priorRefetchStateCount":1}'
        );
        session.abort();
    });

    test("rejects a lagged reconnect snapshot that changes the retained baseline", async () => {
        const session = await open();
        ProofWebSocket.reconnectRows = [{ rowPk: "live-document", score: 0.5 }];
        await expect(session.reconnect()).rejects.toThrow("live SDK reconnect refetch changed baseline content");
        session.abort();
    });

    test("accepts the real client URL and its targeted lagged reconnect fallback", async () => {
        const candidate = { CDB_ERROR_CODES, isRetryable, createChardbClient } as unknown as ReturnType<
            typeof fakeCandidate
        >;
        const session = await open(candidate);
        expect(ProofWebSocket.instances).toHaveLength(1);
        const url = new URL(ProofWebSocket.instances[0]?.url ?? "");
        expect(url.pathname).toBe("/ws");
        expect([...url.searchParams.entries()]).toEqual([["clientId", "live-client"]]);
        await expect(session.reconnect()).resolves.toEqual({ recovery: "lagged-refetch" });
        expect(ProofWebSocket.instances).toHaveLength(2);
        session.abort();
    });

    test.each([
        ["missing identity", (url: URL) => url, "without its exact client identity"],
        [
            "wrong identity",
            (url: URL) => {
                url.searchParams.set("clientId", "other-client");
                return url;
            },
            "without its exact client identity",
        ],
        [
            "extra query",
            (url: URL) => {
                url.searchParams.set("clientId", "live-client");
                url.searchParams.set("extra", "1");
                return url;
            },
            "without its exact client identity",
        ],
        [
            "wrong path",
            (url: URL) => {
                url.pathname = "/other";
                url.searchParams.set("clientId", "live-client");
                return url;
            },
            "unexpected WebSocket endpoint",
        ],
    ])("rejects a candidate WebSocket with %s", async (_label, rewrite, expected) => {
        const base = fakeCandidate();
        const candidate = {
            ...base,
            createChardbClient(options: { readonly endpoint: string }) {
                new WebSocket(rewrite(new URL(options.endpoint)));
                throw new Error("invalid endpoint unexpectedly opened");
            },
        };
        await expect(open(candidate)).rejects.toThrow(expected);
        expect(ProofWebSocket.instances).toHaveLength(0);
    });

    test("fails closed on a duplicate pending content update", async () => {
        const session = await open();
        await session.reconnect();
        session.beginReplacement();
        const socket = ProofWebSocket.instances.at(-1);
        const fallbackRows = [{ rowPk: "lifecycle-document", score: 0.4 }];
        socket?.emit({ t: "snapshot", subId: 1, cookie: "snapshot:2", rows: fallbackRows });
        await session.waitForPending();
        socket?.emit({ t: "snapshot", subId: 1, cookie: "snapshot:duplicate", rows: fallbackRows });
        expect(() => session.assertPending()).toThrow("repeated pending fallback content");
        session.abort();
    });

    test("rejects an untracked row while the live replacement is pending", async () => {
        const session = await open();
        await session.reconnect();
        session.beginReplacement();
        ProofWebSocket.instances.at(-1)?.emit({
            t: "snapshot",
            subId: 1,
            cookie: "snapshot:2",
            rows: [{ rowPk: "untracked-document", score: 0.5 }],
        });
        expect(() => session.assertPending()).toThrow("live pending fallback rows row identity drifted");
        session.abort();
    });

    test("rejects the live row while its replacement is pending", async () => {
        const session = await open();
        await session.reconnect();
        session.beginReplacement();
        ProofWebSocket.instances.at(-1)?.emit({
            t: "snapshot",
            subId: 1,
            cookie: "snapshot:2",
            rows: [{ rowPk: "live-document", score: 0.8 }],
        });
        expect(() => session.assertPending()).toThrow("replacement before provider readiness");
        session.abort();
    });

    test("reports a matching subscription error with redacted diagnostic fields", async () => {
        const session = await open();
        const correlationId = "correlation-secret-value";
        ProofWebSocket.instances.at(-1)?.emit({
            t: "error",
            subId: 1,
            code: "CDB_SHARD_UNAVAILABLE",
            retryable: true,
            correlationId,
            docs: "https://secret.example.com/private-docs",
            message: "private provider detail",
        });

        const expected = JSON.stringify({
            code: "CDB_SHARD_UNAVAILABLE",
            retryable: true,
            subId: 1,
            correlationIdSha256: digest(correlationId),
        });
        expect(() => session.beginReplacement()).toThrow(`live SDK emitted error subscription state ${expected}`);
        try {
            session.beginReplacement();
        } catch (error) {
            const rendered = String(error);
            expect(rendered).not.toContain(correlationId);
            expect(rendered).not.toContain("private-docs");
            expect(rendered).not.toContain("private provider detail");
            expect(rendered).not.toContain("docs");
            expect(rendered).not.toContain("message");
        } finally {
            session.abort();
        }
    });

    test("distinguishes an error callback without a matching subscription frame", async () => {
        const session = await open();
        const raw = JSON.stringify({
            t: "error",
            subId: 99,
            code: "CDB_FORBIDDEN",
            retryable: false,
            correlationId: "unrelated-secret",
            docs: "unrelated-docs-secret",
        });
        ProofWebSocket.instances.at(-1)?.emit({
            t: "error",
            subId: 99,
            code: "CDB_FORBIDDEN",
            retryable: false,
            correlationId: "unrelated-secret",
            docs: "unrelated-docs-secret",
        });

        const expected = JSON.stringify({
            source: "inbound-frame",
            socketIndex: 1,
            clientState: "open",
            frameType: "error",
            frameSha256: digest(raw),
        });
        expect(() => session.beginReplacement()).toThrow(`live SDK emitted error subscription state ${expected}`);
        try {
            session.beginReplacement();
        } catch (error) {
            expect(String(error)).not.toContain("unrelated-secret");
            expect(String(error)).not.toContain("unrelated-docs-secret");
        } finally {
            session.abort();
        }
    });

    test("attributes candidate decode or protocol termination to its hashed inbound frame", async () => {
        const session = await open();
        const raw = JSON.stringify({ t: "candidateMalformed", private: "frame-secret" });
        ProofWebSocket.instances.at(-1)?.emit({ t: "candidateMalformed", private: "frame-secret" });

        const expected = JSON.stringify({
            source: "inbound-frame",
            socketIndex: 1,
            clientState: "closed",
            frameType: "candidateMalformed",
            frameSha256: digest(raw),
        });
        expect(() => session.beginReplacement()).toThrow(`live SDK emitted error subscription state ${expected}`);
        try {
            session.beginReplacement();
        } catch (error) {
            expect(String(error)).not.toContain("frame-secret");
        } finally {
            session.abort();
        }
    });

    test("attributes close-triggered termination without retaining its reason", async () => {
        const session = await open();
        ProofWebSocket.instances.at(-1)?.emitClose(4001, "close-secret", false);

        const expected = JSON.stringify({
            source: "websocket-close",
            socketIndex: 1,
            code: 4001,
            wasClean: false,
            reasonSha256: digest("close-secret"),
            clientState: "closed",
        });
        expect(() => session.beginReplacement()).toThrow(`live SDK emitted error subscription state ${expected}`);
        try {
            session.beginReplacement();
        } catch (error) {
            expect(String(error)).not.toContain("close-secret");
        } finally {
            session.abort();
        }
    });

    test("attributes WebSocket error-triggered termination", async () => {
        const session = await open();
        ProofWebSocket.instances.at(-1)?.emitError();

        const expected = JSON.stringify({
            source: "websocket-error",
            socketIndex: 1,
            clientState: "closed",
        });
        expect(() => session.beginReplacement()).toThrow(`live SDK emitted error subscription state ${expected}`);
        session.abort();
    });

    test("attributes terminal callbacks outside a transport event to the candidate session", async () => {
        const control: { failSession?: () => void } = {};
        const session = await open(fakeCandidate(control));
        control.failSession?.();

        const expected = JSON.stringify({
            source: "client-session",
            code: "CDB_FORBIDDEN",
            reason: "auth-refresh-read",
            trigger: "session-local",
            lastSocketEvent: "inbound-frame",
            lastSocketIndex: 1,
        });
        expect(() => session.beginReplacement()).toThrow(`live SDK emitted error subscription state ${expected}`);
        session.abort();
    });

    test.each([
        [{ t: "error", subId: 0, code: "CDB_FORBIDDEN", retryable: false, correlationId: "raw-secret" }, "id"],
        [{ t: "error", subId: 1, code: "NOT_CDB", retryable: false, correlationId: "raw-secret" }, "code"],
        [{ t: "error", subId: 1, code: "CDB_FORBIDDEN", retryable: "false", correlationId: "raw-secret" }, "retryable"],
        [
            { t: "error", subId: 1, code: "CDB_SHARD_UNAVAILABLE", retryable: false, correlationId: "raw-secret" },
            "retryable polarity",
        ],
        [{ t: "error", subId: 1, code: "CDB_FORBIDDEN", retryable: false, correlationId: "" }, "correlation id"],
    ])("fails closed on malformed matching subscription error fields %#", async (message, field) => {
        const session = await open();
        ProofWebSocket.instances.at(-1)?.emit({ ...message, docs: "docs-secret", message: "message-secret" });

        try {
            session.beginReplacement();
            throw new Error("expected malformed subscription error to fail");
        } catch (error) {
            const rendered = String(error);
            expect(rendered).toContain(`live inbound subscription error ${field}`);
            expect(rendered).not.toContain("raw-secret");
            expect(rendered).not.toContain("docs-secret");
            expect(rendered).not.toContain("message-secret");
        } finally {
            session.abort();
        }
    });
});
