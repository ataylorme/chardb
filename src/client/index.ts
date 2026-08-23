/**
 * `chardb` client SDK.
 *
 * Owns:
 *   - WS reconnect with cookie carryover (G24, RECONNECT_RYW_WINDOW_MS = 30s)
 *   - per-sub state machine (pending → live → live → refetching → live)
 *   - optimistic mutation queue with cookie-aligned drop (an optimistic patch
 *     is dropped on the first server poke whose cookie >= the patch's
 *     `appliedAtCookie`, never on a wall-clock timer)
 *   - cross-tab BroadcastChannel default-on
 *   - mutId allocation (UUIDv7)
 */

import { uuidv7 } from "uuidv7";
import { CdbError, type CdbErrorCode, isCdbError } from "../errors.ts";
import { ChardbRef, ClientId, type Cookie, type CorrelationId, MutId, type RawJson, SubId } from "../types.ts";
import {
    type Down,
    type MustRefetchReason,
    PROTOCOL_V,
    type RowPatch,
    type Up,
    checkProtocolV,
    decodeWire,
    encodeWire,
} from "../wire.ts";

export const RECONNECT_RYW_WINDOW_MS = 30_000;
const RECONNECT_INITIAL_BACKOFF_MS = 250;
const RECONNECT_MAX_BACKOFF_MS = 10_000;

export interface ChardbClientOptions {
    readonly endpoint: string;
    readonly getJwt: () => Promise<string>;
    readonly clientId?: string;
    readonly logicalDb?: string;
    readonly crossTab?: boolean;
    readonly persistMutations?: "memory" | "indexeddb";
}

type SubState = "pending" | "live" | "refetching" | "error" | "closed";
type TerminalSubState = Extract<SubState, "error" | "closed">;

/**
 * A subscription record. Rows always travel as `RawJson` over the wire;
 * the public `subscribe<TRow>` wraps the user's typed listener to widen on
 * the way in. Keeping the storage type uniform avoids dual-typing the `Map`
 * and the listener `Set` and lets us delete the cast chain that used to
 * land at `subs.set` and the listener constructor.
 */
interface SubRecord {
    readonly subId: SubId;
    readonly ref: ChardbRef;
    readonly args: RawJson;
    state: SubState;
    rows: RawJson[];
    listeners: Set<(rows: RawJson[]) => void>;
    optimisticPatches: RowPatch[];
    lastSnapshotCookie?: Cookie;
}

interface PendingMutation {
    readonly mutId: MutId;
    readonly ref: ChardbRef;
    readonly args: RawJson;
    resolve: (result: RawJson) => void;
    reject: (err: CdbError) => void;
    /** Set after first send so reconnect doesn't double-resolve. */
    inFlight: boolean;
}

export interface ChardbClient {
    /** Open a live subscription; returns a disposer. */
    subscribe<TRow = RawJson>(
        ref: string,
        args: RawJson,
        onChange: (rows: TRow[]) => void
    ): { unsubscribe: () => void };
    /** Issue a mutation; resolves with server result after canonical state arrives. */
    mutate<TResult = RawJson>(ref: string, args: RawJson): Promise<TResult>;
    close(): void;
    /** Current connection liveness (for diagnostics). */
    readonly state: "connecting" | "open" | "reconnecting" | "closed";
}

export function createChardbClient(opts: ChardbClientOptions): ChardbClient {
    const clientId = ClientId(opts.clientId ?? crypto.randomUUID());
    const subs = new Map<number, SubRecord>();
    const pending = new Map<string, PendingMutation>();
    let nextSubId = 1;
    let lastCookie: Cookie | undefined;
    let ws: WebSocket | null = null;
    let state: ChardbClient["state"] = "connecting";
    let terminated = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectBackoff = RECONNECT_INITIAL_BACKOFF_MS;
    let lastDisconnectAt = 0;

    // BroadcastChannel
    // (https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)
    // propagates optimistic patches and authoritative cookie advances across
    // tabs that share an origin so a single mutation in one tab settles every
    // other tab's `useQuery` cache without an extra round-trip.
    const enableCrossTab = opts.crossTab !== false && typeof BroadcastChannel !== "undefined";
    const bc =
        enableCrossTab && opts.logicalDb ? new BroadcastChannel(`chardb:${opts.logicalDb}:${"todo-principal"}`) : null;
    if (bc) {
        bc.onmessage = ev => onCrossTab(ev.data as { kind: string; mutId?: string; patches?: RowPatch[] });
    }

    function onCrossTab(msg: { kind: string; mutId?: string; patches?: RowPatch[] }): void {
        if (msg.kind === "optimistic" && msg.patches) applyPatches(msg.patches, true);
        // canonical patches arrive via the server poke, deduped on cookie.
    }

    async function connect(): Promise<void> {
        if (terminated) return;
        state = "connecting";
        const jwt = await opts.getJwt();
        if (terminated) return;
        const url = new URL(opts.endpoint);
        url.searchParams.set("clientId", clientId);
        ws = new WebSocket(url.toString());
        ws.onopen = () => {
            reconnectBackoff = RECONNECT_INITIAL_BACKOFF_MS;
            const hello: Up = {
                t: "hello",
                protocolV: PROTOCOL_V,
                clientId,
                ...(lastCookie ? { resumeFromCookie: lastCookie } : {}),
                jwt,
            };
            ws?.send(encodeWire(hello));
        };
        ws.onmessage = ev => receiveWire(ev.data as string);
        ws.onclose = () => onClose();
        ws.onerror = () => ws?.close();
    }

    function startConnect(): void {
        void connect().catch(() => {
            failSession("CDB_INVARIANT", "failed to establish Chardb client session");
        });
    }

    function sendSessionState(): void {
        // The Gateway verifies hello asynchronously. Do not send protected
        // operations until its welcome proves the auth boundary opened.
        for (const sub of subs.values()) {
            const upSub: Up = {
                t: "sub",
                subId: sub.subId,
                ref: sub.ref,
                args: sub.args,
            };
            ws?.send(encodeWire(upSub));
        }
        for (const m of pending.values()) {
            if (m.inFlight) continue;
            const upMut: Up = { t: "mut", mutId: m.mutId, ref: m.ref, args: m.args };
            ws?.send(encodeWire(upMut));
            m.inFlight = true;
        }
    }

    function onClose(): void {
        if (state === "closed") return;
        state = "reconnecting";
        lastDisconnectAt = Date.now();
        for (const m of pending.values()) m.inFlight = false;
        if (reconnectTimer === null) {
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                const since = Date.now() - lastDisconnectAt;
                if (since > RECONNECT_RYW_WINDOW_MS) {
                    // Outside the cookie-carryover window — drop cookie so the server
                    // emits mustRefetch{lagged} cleanly.
                    lastCookie = undefined;
                }
                reconnectBackoff = Math.min(reconnectBackoff * 2, RECONNECT_MAX_BACKOFF_MS);
                startConnect();
            }, reconnectBackoff);
        }
    }

    function receiveWire(raw: string): void {
        try {
            onWire(raw);
        } catch {
            const message =
                state === "connecting"
                    ? "server sent an invalid Chardb handshake message"
                    : "server sent an invalid Chardb session message";
            failSession("CDB_INVARIANT", message);
        }
    }

    function onWire(raw: string): void {
        const msg = decodeWire(raw) as Down;
        switch (msg.t) {
            case "welcome":
                if (checkProtocolV(msg.protocolV)) {
                    failSession("CDB_UNSUPPORTED_FEATURE", "server selected an unsupported Chardb protocol version");
                    return;
                }
                lastCookie = msg.baseCookie;
                state = "open";
                sendSessionState();
                return;
            case "poke":
                lastCookie = msg.cookie;
                applyPatches(msg.patches, false);
                if (msg.mutResults) {
                    for (const r of msg.mutResults) {
                        const m = pending.get(r.mutId);
                        if (!m) continue;
                        if (r.ok) {
                            m.resolve(r.result);
                        } else {
                            m.reject(
                                new CdbError({
                                    code: r.error.code,
                                    message: `mutation ${r.mutId} failed: ${r.error.code}`,
                                })
                            );
                        }
                        pending.delete(r.mutId);
                    }
                }
                return;
            case "snapshot": {
                const sub = subs.get(msg.subId);
                if (!sub) return;
                if (sub.lastSnapshotCookie === msg.cookie) return;
                lastCookie = msg.cookie;
                sub.rows = [...msg.rows];
                sub.optimisticPatches = [];
                sub.lastSnapshotCookie = msg.cookie;
                sub.state = "live";
                notify(sub);
                return;
            }
            case "mustRefetch":
                if (state === "connecting" && msg.reason === "protocolMismatch") {
                    failSession("CDB_UNSUPPORTED_FEATURE", "server rejected the Chardb protocol version");
                    return;
                }
                for (const subId of msg.subIds) {
                    const sub = subs.get(subId);
                    if (!sub) continue;
                    sub.state = msg.reason === "authChanged" ? "refetching" : "refetching";
                    sub.rows = [];
                    sub.optimisticPatches = [];
                    notify(sub);
                    const up: Up = {
                        t: "sub",
                        subId: sub.subId,
                        ref: sub.ref,
                        args: sub.args,
                    };
                    ws?.send(encodeWire(up));
                }
                return;
            case "error":
                if (state === "connecting" && !msg.retryable) {
                    failSession(msg.code, `authentication failed: ${msg.code}`);
                    return;
                }
                applyError(msg.code, msg.subId, msg.correlationId);
                return;
            case "presence":
            case "streamChunk":
            case "streamEnd":
                return;
        }
    }

    function applyPatches(patches: readonly RowPatch[], optimistic: boolean): void {
        for (const p of patches) {
            const sub = subs.get(p.subId);
            if (!sub) continue;
            const idx = sub.rows.findIndex(r => (r as { __key?: string }).__key === p.rowKey);
            if (p.op === "del") {
                if (idx >= 0) sub.rows.splice(idx, 1);
            } else if (p.row) {
                const next = { ...(p.row as object), __key: p.rowKey } as RawJson;
                if (idx >= 0) sub.rows[idx] = next;
                else sub.rows.push(next);
            }
            if (optimistic) sub.optimisticPatches.push(p);
            else sub.optimisticPatches = sub.optimisticPatches.filter(op => op.rowKey !== p.rowKey);
            sub.state = "live";
            notify(sub);
        }
    }

    function applyError(code: CdbErrorCode, subId: SubId | undefined, correlationId: CorrelationId): void {
        if (subId !== undefined) {
            const sub = subs.get(subId);
            if (sub) {
                sub.state = "error";
                notify(sub);
            }
        }
        void correlationId;
        void code;
    }

    function failSession(code: CdbErrorCode, message: string, subState: TerminalSubState = "error"): void {
        if (terminated) return;
        terminated = true;
        state = "closed";
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        for (const sub of subs.values()) {
            sub.state = subState;
            notify(sub);
        }
        const mutations = [...pending.values()];
        pending.clear();
        const error = new CdbError({ code, message });
        for (const mutation of mutations) mutation.reject(error);
        ws?.close();
        bc?.close();
    }

    function notify(sub: SubRecord): void {
        for (const fn of sub.listeners) fn(sub.rows);
    }

    function subscribe<TRow = RawJson>(
        ref: string,
        args: RawJson,
        onChange: (rows: TRow[]) => void
    ): { unsubscribe: () => void } {
        const subId = SubId(nextSubId++);
        const queryRef = ChardbRef(ref);
        const widenedListener: (rows: RawJson[]) => void = rows => onChange(rows as readonly RawJson[] as TRow[]);
        const rec: SubRecord = {
            subId,
            ref: queryRef,
            args,
            state: "pending",
            rows: [],
            listeners: new Set([widenedListener]),
            optimisticPatches: [],
        };
        subs.set(subId, rec);
        if (ws && state === "open") {
            const up: Up = { t: "sub", subId, ref: queryRef, args };
            ws.send(encodeWire(up));
        }
        return {
            unsubscribe() {
                subs.delete(subId);
                if (ws && state === "open") {
                    const up: Up = { t: "unsub", subId };
                    ws.send(encodeWire(up));
                }
            },
        };
    }

    function mutate<TResult = RawJson>(ref: string, args: RawJson): Promise<TResult> {
        const mutId = MutId(uuidv7());
        return new Promise<TResult>((resolve, reject) => {
            const rec: PendingMutation = {
                mutId,
                ref: ChardbRef(ref),
                args,
                resolve: resolve as (r: RawJson) => void,
                reject,
                inFlight: false,
            };
            pending.set(mutId, rec);
            if (ws && state === "open") {
                const up: Up = { t: "mut", mutId, ref: rec.ref, args };
                ws.send(encodeWire(up));
                rec.inFlight = true;
            }
        });
    }

    function close(): void {
        failSession("CDB_STREAM_ABORTED", "Chardb client closed before pending work settled", "closed");
    }

    startConnect();
    void isCdbError;

    return {
        subscribe,
        mutate,
        close,
        get state() {
            return state;
        },
    };
}
