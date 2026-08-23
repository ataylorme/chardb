import { describe, expect, test } from "bun:test";
import { ChardbRef, ClientId, Cookie, CorrelationId, MutId, SubId } from "../src/types.ts";
import {
    DOWN_TAGS,
    type Down,
    PROTOCOL_V,
    UP_TAGS,
    type Up,
    type WireMessage,
    checkProtocolV,
    decodeWire,
    encodeWire,
} from "../src/wire.ts";

type WireCases = {
    readonly [Tag in WireMessage["t"]]: {
        readonly valid: Extract<WireMessage, { readonly t: Tag }>;
        readonly malformed: readonly Record<string, unknown>[];
    };
};

const CASES = {
    hello: {
        valid: {
            t: "hello",
            protocolV: PROTOCOL_V,
            clientId: ClientId("client-1"),
            resume: Cookie("cookie-0"),
            resumeFromCookie: Cookie("cookie-1"),
            jwt: "jwt",
        },
        malformed: [
            { t: "hello", protocolV: PROTOCOL_V, clientId: "client-1" },
            { t: "hello", protocolV: PROTOCOL_V, clientId: [], jwt: "jwt" },
        ],
    },
    sub: {
        valid: {
            t: "sub",
            subId: SubId(1),
            ref: ChardbRef("queries.ts#listMessages"),
            args: { organizationId: "org-1", channelId: "channel-1" },
            ttlMs: 1_000,
        },
        malformed: [
            { t: "sub", subId: 1.5, ref: "queries.ts#list", args: {} },
            { t: "sub", subId: 1, ref: "not-a-ref", args: {} },
        ],
    },
    unsub: {
        valid: { t: "unsub", subId: SubId(1) },
        malformed: [{ t: "unsub" }, { t: "unsub", subId: -1 }],
    },
    mut: {
        valid: { t: "mut", mutId: MutId("mut-1"), ref: ChardbRef("api.ts#create"), args: { body: "hi" } },
        malformed: [
            { t: "mut", mutId: "mut-1", ref: "not-a-ref", args: {} },
            { t: "mut", mutId: "mut-1", ref: "api.ts#create" },
        ],
    },
    updateAuth: {
        valid: { t: "updateAuth", jwt: "new-jwt" },
        malformed: [{ t: "updateAuth" }, { t: "updateAuth", jwt: {} }],
    },
    ack: {
        valid: { t: "ack", cookie: Cookie("cookie-1") },
        malformed: [{ t: "ack" }, { t: "ack", cookie: 4 }],
    },
    presencePub: {
        valid: { t: "presencePub", key: "room-1", state: { typing: true }, ttlMs: 5_000 },
        malformed: [
            { t: "presencePub", key: "room-1" },
            { t: "presencePub", key: "room-1", state: null, ttlMs: -1 },
        ],
    },
    presenceSub: {
        valid: { t: "presenceSub", key: "room-1" },
        malformed: [{ t: "presenceSub" }, { t: "presenceSub", key: [] }],
    },
    streamReq: {
        valid: {
            t: "streamReq",
            streamReqId: 1,
            ref: ChardbRef("api.ts#exportRows"),
            args: { limit: 10 },
            mutId: MutId("mut-2"),
        },
        malformed: [
            { t: "streamReq", streamReqId: -1, ref: "api.ts#exportRows", args: {}, mutId: "mut-2" },
            { t: "streamReq", streamReqId: 1, ref: "bad", args: {}, mutId: "mut-2" },
        ],
    },
    ping: {
        valid: { t: "ping" },
        malformed: [
            { t: "ping", payload: true },
            { t: "ping", payload: [] },
        ],
    },
    welcome: {
        valid: {
            t: "welcome",
            protocolV: PROTOCOL_V,
            baseCookie: Cookie("cookie-1"),
            region: "WNAM",
            colo: "SJC",
            resumedFromCookie: Cookie("cookie-0"),
        },
        malformed: [
            { t: "welcome", protocolV: PROTOCOL_V, baseCookie: "cookie-1" },
            { t: "welcome", protocolV: PROTOCOL_V, baseCookie: "cookie-1", region: "WNAM", colo: 7 },
        ],
    },
    poke: {
        valid: {
            t: "poke",
            cookie: Cookie("cookie-2"),
            patches: [{ op: "put", subId: SubId(1), rowKey: "row-1", row: { id: "row-1" } }],
            mutResults: [
                { mutId: MutId("mut-1"), ok: true, result: { id: "row-1" }, cookie: Cookie("cookie-2") },
                {
                    mutId: MutId("mut-2"),
                    ok: false,
                    error: { code: "CDB_INVALID_ARGS", retryable: false, docs: "https://chardb.dev/errors/x" },
                },
            ],
        },
        malformed: [
            { t: "poke", cookie: "cookie-2", patches: {} },
            { t: "poke", cookie: "cookie-2", patches: [], mutResults: [{ mutId: "mut-1", ok: "yes" }] },
            {
                t: "poke",
                cookie: "cookie-2",
                patches: [],
                mutResults: [
                    {
                        mutId: "mut-1",
                        ok: false,
                        error: { code: "CDB_INVALID_ARGS", retryable: true, docs: "docs" },
                    },
                ],
            },
        ],
    },
    mustRefetch: {
        valid: { t: "mustRefetch", subIds: [SubId(1), SubId(2)], reason: "schemaChanged" },
        malformed: [
            { t: "mustRefetch", subIds: [1.2], reason: "schemaChanged" },
            { t: "mustRefetch", subIds: [], reason: 7 },
        ],
    },
    presence: {
        valid: {
            t: "presence",
            key: "room-1",
            version: 1,
            states: [{ clientId: ClientId("client-1"), state: { typing: true }, ts: 1_700_000_000_000 }],
        },
        malformed: [
            { t: "presence", key: "room-1", version: 2, states: [] },
            { t: "presence", key: "room-1", version: 1, states: [{ clientId: "client-1", state: null }] },
        ],
    },
    streamChunk: {
        valid: { t: "streamChunk", streamReqId: 1, chunk: [1, 2, 3] },
        malformed: [
            { t: "streamChunk", streamReqId: -1, chunk: null },
            { t: "streamChunk", streamReqId: 1 },
        ],
    },
    streamEnd: {
        valid: {
            t: "streamEnd",
            streamReqId: 1,
            finalMutResult: {
                mutId: MutId("mut-1"),
                ok: false,
                error: { code: "CDB_SHARD_UNAVAILABLE", retryable: true, docs: "https://chardb.dev/errors/x" },
            },
        },
        malformed: [
            { t: "streamEnd", streamReqId: 1.5, finalMutResult: {} },
            { t: "streamEnd", streamReqId: 1, finalMutResult: [] },
            {
                t: "streamEnd",
                streamReqId: 1,
                finalMutResult: {
                    mutId: "mut-1",
                    ok: false,
                    error: { code: 7, retryable: false, docs: "docs" },
                },
            },
        ],
    },
    error: {
        valid: {
            t: "error",
            code: "CDB_CATALOG_UNAVAILABLE",
            subId: SubId(1),
            streamReqId: 2,
            retryable: true,
            correlationId: CorrelationId("corr-1"),
            docs: "https://chardb.dev/errors/cdb_catalog_unavailable",
        },
        malformed: [
            {
                t: "error",
                code: 7,
                retryable: false,
                correlationId: "corr-1",
                docs: "docs",
            },
            {
                t: "error",
                code: "CDB_INVARIANT",
                retryable: "no",
                correlationId: "corr-1",
                docs: "docs",
            },
            {
                t: "error",
                code: "CDB_INVARIANT",
                retryable: true,
                correlationId: "corr-1",
                docs: "docs",
            },
        ],
    },
} satisfies WireCases;

describe("wire envelope", () => {
    const everyTag = [...UP_TAGS, ...DOWN_TAGS];

    test("table covers every member of the Up/Down tagged union", () => {
        expect(Object.keys(CASES).sort()).toEqual([...everyTag].sort());
    });

    for (const tag of everyTag) {
        test(`decodeWire accepts the complete valid ${tag} shape`, () => {
            const valid = CASES[tag].valid;
            expect(decodeWire(encodeWire(valid))).toEqual(valid);
        });

        test(`decodeWire rejects several malformed ${tag} shapes`, () => {
            const entry = CASES[tag];
            const unexpected = { ...entry.valid, unexpected: true };
            for (const malformed of [...entry.malformed, unexpected]) {
                expect(() => decodeWire(JSON.stringify(malformed))).toThrow(TypeError);
            }
        });
    }

    test("Up.hello round-trips", () => {
        const up: Up = {
            t: "hello",
            protocolV: PROTOCOL_V,
            clientId: ClientId("c-1"),
            jwt: "jwt-token",
            resumeFromCookie: Cookie("c-1:42"),
        };
        const back = decodeWire(encodeWire(up)) as Up;
        expect(back.t).toBe("hello");
        expect((back as Extract<Up, { t: "hello" }>).clientId).toBe(ClientId("c-1"));
    });

    test("Up.sub round-trips with query ref and raw args", () => {
        const up: Up = {
            t: "sub",
            subId: SubId(7),
            ref: ChardbRef("queries.ts#listMessages"),
            args: { organizationId: "org-1" },
        };
        expect(decodeWire(encodeWire(up))).toEqual(up);
    });

    test("Up.sub rejects client-supplied routing intent or hash", () => {
        expect(() =>
            decodeWire(
                JSON.stringify({
                    t: "sub",
                    subId: 7,
                    ref: "queries.ts#listMessages",
                    args: { organizationId: "org-1" },
                    queryHash: "forged",
                    intent: { kind: "select", tables: ["secrets"], joinShape: "reference" },
                })
            )
        ).toThrow(/must not be present/);
    });

    test("Down.poke shape preserved", () => {
        const down: Down = {
            t: "poke",
            cookie: Cookie("c-1:42"),
            patches: [{ op: "put", subId: SubId(1), rowKey: "row-1", row: { a: 1 } }],
            mutResults: [{ mutId: MutId("m-1"), ok: true, result: { id: "row-1" }, cookie: Cookie("c-1:42") }],
        };
        expect(decodeWire(encodeWire(down))).toEqual(down);
    });

    test("Up.mut carries ChardbRef wire id", () => {
        const up: Up = {
            t: "mut",
            mutId: MutId("m-1"),
            ref: ChardbRef("src/server.ts#postMessage"),
            args: { body: "hi" },
        };
        expect(decodeWire(encodeWire(up))).toEqual(up);
    });

    test("malformed payload throws", () => {
        expect(() => decodeWire("not json")).toThrow(/invalid JSON/);
        expect(() => decodeWire(JSON.stringify({ no: "tag" }))).toThrow(/missing string tag/);
        expect(() => decodeWire(JSON.stringify(null))).toThrow(/not an object/);
        expect(() => decodeWire(JSON.stringify([]))).toThrow(/not an object/);
    });

    test("rejects numeric overflow as non-JSON data after parsing", () => {
        expect(() => decodeWire('{"t":"ping","overflow":1e400}')).toThrow(/finite number/);
    });

    test("normalizes additive mustRefetch reasons to lagged for protocol-v2 consumers", () => {
        expect(decodeWire('{"t":"mustRefetch","subIds":[1],"reason":"futureReason"}')).toEqual({
            t: "mustRefetch",
            subIds: [SubId(1)],
            reason: "lagged",
        });
    });

    test("normalizes additive error codes to a locked invariant envelope", () => {
        expect(
            decodeWire('{"t":"error","code":"CDB_FUTURE_CODE","retryable":true,"correlationId":"corr","docs":"future"}')
        ).toEqual({
            t: "error",
            code: "CDB_INVARIANT",
            retryable: false,
            correlationId: CorrelationId("corr"),
            docs: "https://chardb.dev/errors/cdb_invariant",
        });
    });

    test("decodeWire rejects unknown tags (closed at protocolV=2)", () => {
        expect(() => decodeWire(JSON.stringify({ t: "haxx" }))).toThrow(/unknown tag "haxx"/);
        expect(() => decodeWire(JSON.stringify({ t: "MUT" }))).toThrow(/unknown tag/);
    });

    test("UP_TAGS and DOWN_TAGS are exhaustive over the actual sum types", () => {
        expect(UP_TAGS.length).toBeGreaterThan(0);
        expect(DOWN_TAGS.length).toBeGreaterThan(0);
        expect(new Set(UP_TAGS).size).toBe(UP_TAGS.length);
        expect(new Set(DOWN_TAGS).size).toBe(DOWN_TAGS.length);
        // No overlap — Up and Down tag sets are disjoint.
        for (const t of UP_TAGS) expect(DOWN_TAGS as readonly string[]).not.toContain(t);
    });

    test("checkProtocolV(2) accepts; mismatched versions emit mustRefetch:protocolMismatch", () => {
        expect(checkProtocolV(2)).toBeNull();
        expect(checkProtocolV(1)).toEqual({ t: "mustRefetch", subIds: [], reason: "protocolMismatch" });
        expect(checkProtocolV("2")).toEqual({
            t: "mustRefetch",
            subIds: [],
            reason: "protocolMismatch",
        });
        expect(checkProtocolV(undefined)).toEqual({
            t: "mustRefetch",
            subIds: [],
            reason: "protocolMismatch",
        });
    });

    test("PROTOCOL_V is locked at 2", () => {
        expect(PROTOCOL_V).toBe(2);
    });
});
