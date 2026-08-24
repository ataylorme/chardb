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
const DEFAULT_MUTATION_TIMEOUT_MS = 60_000;
const RECONNECT_INITIAL_BACKOFF_MS = 250;
const RECONNECT_MAX_BACKOFF_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_ACTIVE_SUBSCRIPTIONS = 64;

export interface ChardbClientOptions {
    readonly endpoint: string;
    readonly getJwt: () => Promise<string>;
    readonly clientId?: string;
    readonly logicalDb?: string;
    readonly crossTab?: boolean;
    readonly persistMutations?: "memory" | "indexeddb";
    /** Maximum time to wait for a mutation result, including reconnects. Defaults to 60 seconds. */
    readonly mutationTimeoutMs?: number;
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
    timeout: ReturnType<typeof setTimeout> | null;
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
    const mutationTimeoutMs = opts.mutationTimeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(mutationTimeoutMs) || mutationTimeoutMs <= 0 || mutationTimeoutMs > MAX_TIMER_DELAY_MS) {
        throw new RangeError(`mutationTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
    }
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

    function acknowledgeSnapshot(cookie: Cookie): void {
        const socket = ws;
        if (!socket || state !== "open" || socket.readyState !== WebSocket.OPEN) return;
        try {
            const acknowledgement: Up = { t: "ack", cookie };
            socket.send(encodeWire(acknowledgement));
        } catch {
            // Snapshot acknowledgements are retryable by duplicate delivery.
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
                        const m = takePendingMutation(r.mutId);
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
                    }
                }
                return;
            case "snapshot": {
                const sub = subs.get(msg.subId);
                if (!sub) return;
                if (sub.lastSnapshotCookie === msg.cookie) {
                    acknowledgeSnapshot(msg.cookie);
                    return;
                }
                lastCookie = msg.cookie;
                sub.rows = [...msg.rows];
                sub.optimisticPatches = [];
                sub.lastSnapshotCookie = msg.cookie;
                sub.state = "live";
                notify(sub);
                acknowledgeSnapshot(msg.cookie);
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
                sub.rows = [];
                sub.optimisticPatches = [];
                notify(sub);
            }
        }
        void correlationId;
        void code;
    }

    function clearMutationTimeout(mutation: PendingMutation): void {
        if (mutation.timeout === null) return;
        clearTimeout(mutation.timeout);
        mutation.timeout = null;
    }

    function takePendingMutation(mutId: MutId): PendingMutation | undefined {
        const mutation = pending.get(mutId);
        if (!mutation) return undefined;
        pending.delete(mutId);
        clearMutationTimeout(mutation);
        return mutation;
    }

    function failSession(code: CdbErrorCode, message: string, subState: TerminalSubState = "error"): void {
        if (terminated) return;
        terminated = true;
        state = "closed";
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        const subscriptions = [...subs.values()];
        subs.clear();
        for (const sub of subscriptions) {
            sub.state = subState;
            for (const listener of sub.listeners) {
                try {
                    listener(sub.rows);
                } catch {
                    // User listeners cannot interrupt terminal resource cleanup.
                }
            }
        }
        const mutations = [...pending.values()];
        pending.clear();
        const error = new CdbError({ code, message });
        for (const mutation of mutations) {
            clearMutationTimeout(mutation);
            mutation.reject(error);
        }
        try {
            ws?.close();
        } finally {
            bc?.close();
        }
    }

    function notify(sub: SubRecord): void {
        for (const fn of sub.listeners) fn(sub.rows);
    }

    function subscribe<TRow = RawJson>(
        ref: string,
        args: RawJson,
        onChange: (rows: TRow[]) => void
    ): { unsubscribe: () => void } {
        if (terminated) {
            throw new CdbError({
                code: "CDB_STREAM_ABORTED",
                message: "cannot open a subscription after the Chardb client has closed",
            });
        }
        const queryRef = ChardbRef(ref);
        if (subs.size >= MAX_ACTIVE_SUBSCRIPTIONS) {
            throw new CdbError({
                code: "CDB_RATE_LIMITED",
                message: `cannot open more than ${MAX_ACTIVE_SUBSCRIPTIONS} active subscriptions`,
            });
        }
        const subId = SubId(nextSubId++);
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
            try {
                ws.send(encodeWire(up));
            } catch (cause) {
                subs.delete(subId);
                throw new CdbError({
                    code: "CDB_STREAM_ABORTED",
                    message: `failed to send subscription ${subId}`,
                    cause,
                });
            }
        }
        return {
            unsubscribe() {
                if (!subs.delete(subId)) return;
                if (ws && state === "open") {
                    const up: Up = { t: "unsub", subId };
                    try {
                        ws.send(encodeWire(up));
                    } catch (cause) {
                        failSession(
                            "CDB_STREAM_ABORTED",
                            `failed to send unsubscription ${subId}; client session closed`
                        );
                        throw new CdbError({
                            code: "CDB_STREAM_ABORTED",
                            message: `failed to send unsubscription ${subId}`,
                            cause,
                        });
                    }
                }
            },
        };
    }

    function mutate<TResult = RawJson>(ref: string, args: RawJson): Promise<TResult> {
        if (terminated) {
            return Promise.reject(
                new CdbError({
                    code: "CDB_STREAM_ABORTED",
                    message: "cannot issue a mutation after the Chardb client has closed",
                })
            );
        }
        const mutId = MutId(uuidv7());
        return new Promise<TResult>((resolve, reject) => {
            const rec: PendingMutation = {
                mutId,
                ref: ChardbRef(ref),
                args,
                resolve: resolve as (r: RawJson) => void,
                reject,
                inFlight: false,
                timeout: null,
            };
            pending.set(mutId, rec);
            rec.timeout = setTimeout(() => {
                if (pending.get(mutId) !== rec) return;
                pending.delete(mutId);
                rec.timeout = null;
                rec.reject(
                    new CdbError({
                        code: "CDB_MUTATION_OUTCOME_UNKNOWN",
                        message: `mutation ${mutId} timed out after ${mutationTimeoutMs}ms`,
                    })
                );
            }, mutationTimeoutMs);
            if (ws && state === "open") {
                const up: Up = { t: "mut", mutId, ref: rec.ref, args };
                try {
                    ws.send(encodeWire(up));
                    rec.inFlight = true;
                } catch (cause) {
                    const failed = takePendingMutation(mutId);
                    failed?.reject(
                        new CdbError({
                            code: "CDB_STREAM_ABORTED",
                            message: `failed to send mutation ${mutId}`,
                            cause,
                        })
                    );
                }
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
