/**
 * `chardb/react` — `ChardbProvider` + hooks. All hooks accept function refs
 * from `chardb/server`; users never type a wire identifier as a string.
 */

import {
    type PropsWithChildren,
    type ReactElement,
    createContext,
    createElement,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
} from "react";
import type { ChardbClient, ChardbClientOptions } from "../client/index.ts";
import { createChardbClient } from "../client/index.ts";
import type { CdbIntent, RawJson } from "../wire.ts";

/**
 * Infer the wire-shape arguments of a `defineMutation` / `defineQuery`
 * handler. Equivalent to `Parameters<typeof handler>[1]` but
 * self-documenting at the call site:
 *
 * ```ts
 * type Args = InferArgs<typeof postMessage>; // { id, body, ... }
 * ```
 */
export type InferArgs<F> = F extends (ctx: never, args: infer A) => unknown ? A : never;

/**
 * Infer the row shape returned by a `defineQuery` handler. For
 * collection queries (`Promise<RowType[]>`) this resolves to the
 * element type; for scalar queries it resolves to the awaited result.
 *
 * ```ts
 * type MessageRow = InferRow<typeof listMessages>;
 * ```
 */
export type InferRow<F> = F extends (...args: never[]) => Promise<infer R>
    ? R extends readonly (infer Row)[]
        ? Row
        : R
    : never;

/**
 * Subset of the better-auth `authClient` API the provider relies on.
 * Typed structurally so consumers can pass any object that satisfies
 * the shape — no hard dependency on `better-auth/client` at the type
 * level (the actual `createAuthClient(...)` value satisfies this).
 */
export interface AuthClientLike {
    readonly $fetch: <T = unknown>(
        path: string,
        init?: { method?: string; body?: unknown }
    ) => Promise<{ data: T | null; error: { message?: string } | null }>;
    /**
     * Better-auth's `useSession` is a nanostores atom (not a React
     * hook): `{ get(): SessionStoreValue, subscribe(fn): () => void }`.
     * `useSession()` from this module wraps it in `useSyncExternalStore`
     * to project the current shape into React state.
     */
    readonly useSession: AuthSessionAtom;
}

/** Minimal nanostores atom surface — just enough to drive `useSyncExternalStore`. */
export interface AuthSessionAtom {
    get(): { readonly data: SessionData | null; readonly isPending: boolean };
    subscribe(listener: () => void): () => void;
}

export interface SessionData {
    readonly user?: { readonly id: string; readonly [k: string]: unknown };
    readonly session?: {
        readonly userId?: string;
        readonly activeOrganizationId?: string | null;
        readonly [k: string]: unknown;
    };
    readonly [k: string]: unknown;
}

interface ChardbContextValue {
    readonly client: ChardbClient;
    readonly auth: AuthClientLike | null;
}

const ChardbCtx = createContext<ChardbContextValue | null>(null);

export interface ChardbProviderProps extends Partial<ChardbClientOptions> {
    readonly client?: ChardbClient;
    /**
     * better-auth `createAuthClient(...)` instance. When provided,
     * `ChardbProvider` derives `getJwt` from `authClient.$fetch("/token")`
     * (the standard `jwt()` plugin endpoint) so the user doesn't write
     * their own JWT-fetch shim. `useSession()` delegates to
     * `authClient.useSession()`.
     */
    readonly auth?: AuthClientLike;
}

export function ChardbProvider(props: PropsWithChildren<ChardbProviderProps>): ReactElement {
    const client = useMemo<ChardbClient>(() => {
        if (props.client) return props.client;
        const getJwt =
            props.getJwt ??
            (props.auth
                ? async () => {
                      const r = await props.auth!.$fetch<{ token: string }>("/token");
                      if (r.error || !r.data?.token) {
                          throw new Error(`chardb: failed to fetch JWT (${r.error?.message ?? "no token"})`);
                      }
                      return r.data.token;
                  }
                : undefined);
        if (!props.endpoint || !getJwt) {
            throw new Error(
                "ChardbProvider requires {endpoint} plus either {getJwt} or {auth: createAuthClient(...)}"
            );
        }
        return createChardbClient({
            endpoint: props.endpoint,
            getJwt,
            ...(props.clientId !== undefined ? { clientId: props.clientId } : {}),
            ...(props.logicalDb !== undefined ? { logicalDb: props.logicalDb } : {}),
            ...(props.crossTab !== undefined ? { crossTab: props.crossTab } : {}),
            ...(props.persistMutations !== undefined ? { persistMutations: props.persistMutations } : {}),
        });
    }, [
        props.client,
        props.endpoint,
        props.getJwt,
        props.auth,
        props.clientId,
        props.logicalDb,
        props.crossTab,
        props.persistMutations,
    ]);

    useEffect(() => () => client.close(), [client]);

    const value = useMemo<ChardbContextValue>(
        () => ({ client, auth: props.auth ?? null }),
        [client, props.auth]
    );

    return createElement(ChardbCtx.Provider, { value }, props.children);
}

export function useChardb(): ChardbClient {
    const c = useContext(ChardbCtx);
    if (!c) throw new Error("useChardb must be used inside <ChardbProvider>");
    return c.client;
}

function useChardbAuth(): AuthClientLike | null {
    const c = useContext(ChardbCtx);
    if (!c) throw new Error("useChardbAuth must be used inside <ChardbProvider>");
    return c.auth;
}

export interface UseQueryResult<T> {
    readonly data: T[] | undefined;
    readonly state: "pending" | "live" | "error" | "refetching" | "closed";
}

/**
 * Wire-shape stamp every `defineQuery` value carries. Pulled out of
 * the server `QueryFn` type so the React side can refer to it without
 * dragging in `chardb/server`.
 */
export interface QueryHandleStamp<TArgs> {
    readonly __chardbRef: { toString(): string };
    readonly __chardbIntent?: (args: TArgs) => CdbIntent;
}

/**
 * Row inferred from a `defineQuery` handler's return type. Collection
 * queries (`Promise<readonly Row[]>` / `Promise<Row[]>`) resolve to
 * `Row`; scalar queries resolve to the awaited value.
 */
type RowOf<F> = F extends (...args: never[]) => Promise<infer R>
    ? R extends readonly (infer Row)[]
        ? Row
        : R
    : never;

type ArgsOf<F> = F extends (ctx: never, args: infer A) => unknown ? A : never;

export function useQuery<T = RawJson>(intent: CdbIntent): UseQueryResult<T>;
export function useQuery<F extends (...args: never[]) => Promise<unknown>>(
    handle: F & QueryHandleStamp<ArgsOf<F>>,
    args: ArgsOf<F>
): UseQueryResult<RowOf<F>>;
export function useQuery(
    intentOrHandle: CdbIntent | (((...args: never[]) => unknown) & QueryHandleStamp<unknown>),
    args?: unknown
): UseQueryResult<unknown> {
    const client = useChardb();
    const intent = useMemo<CdbIntent>(() => {
        if (isHandle(intentOrHandle)) {
            const extractor = intentOrHandle.__chardbIntent;
            if (!extractor) {
                throw new Error(
                    "useQuery(handle, args) requires defineQuery({ intent: (args) => CdbIntent }); " +
                        "the handle was defined without an `intent` extractor."
                );
            }
            return extractor(args);
        }
        return intentOrHandle;
    }, [intentOrHandle, args]);
    const [data, setData] = useState<unknown[] | undefined>(undefined);
    useEffect(() => {
        const sub = client.subscribe<unknown>(intent, rows => setData(rows));
        return sub.unsubscribe;
    }, [client, intent]);
    return { data, state: data === undefined ? "pending" : "live" };
}

function isHandle(v: unknown): v is ((...args: never[]) => unknown) & QueryHandleStamp<unknown> {
    return typeof v === "function" && typeof (v as { __chardbRef?: unknown }).__chardbRef !== "undefined";
}

export interface MutationFnLike {
    readonly __chardbRef: { toString(): string };
}

export function useMutation<TArgs extends RawJson = RawJson, TResult = RawJson>(
    fn: MutationFnLike
): (args: TArgs) => Promise<TResult> {
    const client = useChardb();
    return useCallback((args: TArgs) => client.mutate<TResult>(fn.__chardbRef.toString(), args), [client, fn]);
}

export interface SessionShape {
    readonly userId: string | null;
    readonly tenantId: string | null;
    readonly isPending: boolean;
    readonly raw: SessionData | null;
}

/**
 * Read the current session from the better-auth client passed to
 * `ChardbProvider auth={...}`. Projects the better-auth session into
 * the `AuthCtx`-shaped fields chardb policies care about
 * (`userId`/`tenantId`); the full session is exposed as `raw` for
 * consumers that want the rest. Returns nulls when no `auth` was
 * provided to the provider — callers can fall back to anonymous /
 * unauthenticated UI.
 */
const NULL_SESSION_SNAPSHOT: { readonly data: SessionData | null; readonly isPending: boolean } = {
    data: null,
    isPending: false,
};

export function useSession(): SessionShape {
    const auth = useChardbAuth();
    const subscribe = useCallback(
        (listener: () => void) => (auth ? auth.useSession.subscribe(listener) : () => {}),
        [auth]
    );
    const getSnapshot = useCallback(() => (auth ? auth.useSession.get() : NULL_SESSION_SNAPSHOT), [auth]);
    const session = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
    const tenantId = (session.data?.session?.activeOrganizationId as string | null | undefined) ?? null;
    return { userId, tenantId, isPending: session.isPending, raw: session.data };
}

export interface PresenceStates<T> {
    readonly states: Map<string, { state: T; ts: number }>;
    publish(state: T): void;
}

export function usePresence<T>(_key: string): PresenceStates<T> {
    return {
        states: new Map(),
        publish() {
            /* wired by chardb/server runtime */
        },
    };
}

export function useUpload(): { uploading: boolean } {
    return { uploading: false };
}

export function useStream<TChunk>(): AsyncIterable<TChunk> {
    return {
        async *[Symbol.asyncIterator]() {
            /* wired by chardb/server runtime */
        },
    };
}

export function useVectorSearch<T>(): { results: { row: T; score: number }[]; loading: boolean } {
    return { results: [], loading: false };
}
