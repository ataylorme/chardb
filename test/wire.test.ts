import { describe, expect, test } from "bun:test";
import { ChardbRef, ClientId, Cookie, MutId, SubId } from "../src/types.ts";
import {
    DOWN_TAGS,
    type Down,
    PROTOCOL_V,
    UP_TAGS,
    type Up,
    checkProtocolV,
    decodeWire,
    encodeWire,
} from "../src/wire.ts";

describe("wire envelope", () => {
    test("Up.hello round-trips", () => {
        const up: Up = {
            t: "hello",
            clientId: ClientId("c-1"),
            jwt: "jwt-token",
            resumeFromCookie: Cookie("c-1:42"),
        };
        const back = decodeWire(encodeWire(up)) as Up;
        expect(back.t).toBe("hello");
        expect((back as Extract<Up, { t: "hello" }>).clientId).toBe(ClientId("c-1"));
    });

    test("Up.sub round-trips with intent", () => {
        const up: Up = {
            t: "sub",
            subId: SubId(7),
            queryHash: "abc",
            intent: { kind: "select", tables: ["messages"] },
        };
        expect(decodeWire(encodeWire(up))).toEqual(up);
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

    test("decodeWire rejects unknown tags (closed at protocolV=1)", () => {
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

    test("checkProtocolV(1) accepts; mismatched versions emit mustRefetch:protocolMismatch", () => {
        expect(checkProtocolV(1)).toBeNull();
        expect(checkProtocolV(2)).toEqual({ t: "mustRefetch", subIds: [], reason: "protocolMismatch" });
        expect(checkProtocolV("1")).toEqual({
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

    test("PROTOCOL_V is locked at 1", () => {
        expect(PROTOCOL_V).toBe(1);
    });
});
