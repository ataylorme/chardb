/** Convert in-process Interval values to/from the wire encoding. */

import { type Endpoint, FULL, type Interval, type IntervalKey, type IntervalScalar, IntervalSet } from "./intervals.ts";
import type { RawJson } from "./types.ts";
import type { WireEndpoint, WireInterval } from "./wire.ts";

function scalarToJson(s: IntervalScalar): RawJson {
    if (s instanceof Uint8Array) {
        let bin = "";
        for (let i = 0; i < s.length; i++) bin += String.fromCharCode(s[i] as number);
        return `\u0000bin:${btoa(bin)}`;
    }
    if (typeof s === "bigint") return `\u0000bi:${s.toString()}`;
    return s;
}

function jsonToScalar(j: RawJson): IntervalScalar {
    if (typeof j === "string") {
        if (j.startsWith("\u0000bin:")) {
            const bin = atob(j.slice(5));
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        if (j.startsWith("\u0000bi:")) return BigInt(j.slice(4));
        return j;
    }
    if (typeof j === "number") return j;
    throw new TypeError(`unsupported interval scalar in wire: ${typeof j}`);
}

function endpointToWire(ep: Endpoint): WireEndpoint {
    if (ep.kind === "neg_inf" || ep.kind === "pos_inf") return { kind: ep.kind };
    return { kind: "value", value: ep.value.map(scalarToJson), inclusive: ep.inclusive };
}

function endpointFromWire(ep: WireEndpoint): Endpoint {
    if (ep.kind === "neg_inf") return { kind: "neg_inf" };
    if (ep.kind === "pos_inf") return { kind: "pos_inf" };
    return {
        kind: "value",
        value: ep.value.map(jsonToScalar) as IntervalKey,
        inclusive: ep.inclusive,
    };
}

export function intervalToWire(iv: Interval): WireInterval {
    if (iv.lo.kind === "neg_inf" && iv.hi.kind === "pos_inf") return { kind: "full" };
    return { kind: "range", lo: endpointToWire(iv.lo), hi: endpointToWire(iv.hi) };
}

export function intervalFromWire(iv: WireInterval): Interval {
    if (iv.kind === "full") return FULL;
    return { lo: endpointFromWire(iv.lo), hi: endpointFromWire(iv.hi) };
}

export function intervalSetToWire(set: IntervalSet): WireInterval[] {
    return set.toArray().map(intervalToWire);
}

export function intervalSetFromWire(arr: readonly WireInterval[]): IntervalSet {
    const s = new IntervalSet();
    for (const iv of arr) s.add(intervalFromWire(iv));
    return s;
}
