/**
 * `@chardb/core/react` — `ChardbProvider` + hooks. All hooks accept function refs
 * from `@chardb/core/server`; users never type a wire identifier as a string.
 */

import type { Column } from "drizzle-orm";
import {
    type PropsWithChildren,
    type ReactElement,
    createContext,
    createElement,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import type { ChardbClient, ChardbClientOptions } from "../client/index.ts";
import { createDeferredChardbClientController } from "../client/index.ts";
import { snapshotSubscriptionArguments } from "../client/serialized-json.ts";
import { type ChardbFileClient, type FileRef, createFileClient } from "../files/index.ts";
import { stableJson } from "../util/canonical.ts";
import type { RawJson } from "../wire.ts";

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
 * Subset of the Better Auth client API the provider relies on. Both the
 * framework-neutral client and the React client expose the same session atom,
 * although the React client keeps it under `$store.atoms.session` and exposes
 * `useSession` as a hook.
 */
export interface AuthClientLike {
    readonly $fetch: <T = unknown>(
        path: string,
        init?: { method?: string; body?: unknown }
    ) => Promise<{ data: T | null; error: { message?: string } | null }>;
    readonly useSession?: AuthSessionAtom | (() => unknown);
    readonly $store?: {
        readonly atoms: { readonly session?: AuthSessionAtom; readonly [key: string]: unknown };
    };
}

/** Minimal nanostores atom surface — just enough to drive `useSyncExternalStore`. */
export interface AuthSessionAtom {
    get(): { readonly data: SessionData | null; readonly isPending: boolean };
    subscribe(listener: () => void): () => void;
}

export interface SessionData {
    readonly user?: { readonly id: string; readonly [k: string]: unknown };
    readonly session?: {
        readonly id?: string;
        readonly userId?: string;
        readonly activeOrganizationId?: string | null;
        readonly [k: string]: unknown;
    };
    readonly [k: string]: unknown;
}

interface ChardbContextValue {
    readonly client: ChardbClient;
}

type ProviderClientResource =
    | { readonly client: ChardbClient; readonly owned: false }
    | { readonly client: ChardbClient; readonly owned: true; readonly start: () => void };

interface PendingClientClose {
    cancelled: boolean;
}

const ChardbCtx = createContext<ChardbContextValue | null>(null);

function authSessionAtom(auth: AuthClientLike | null): AuthSessionAtom | null {
    const direct = auth?.useSession;
    if (
        typeof direct === "object" &&
        direct !== null &&
        typeof direct.get === "function" &&
        typeof direct.subscribe === "function"
    ) {
        return direct;
    }
    const stored = auth?.$store?.atoms.session;
    return stored && typeof stored.get === "function" && typeof stored.subscribe === "function" ? stored : null;
}

function sessionIdentity(atom: AuthSessionAtom | null): string | null {
    const data = atom?.get().data;
    const userId = data?.user?.id ?? data?.session?.userId;
    if (!userId) return null;
    return JSON.stringify([userId, data?.session?.id ?? null]);
}

function useAuthSessionIdentity(atom: AuthSessionAtom | null): string | null {
    const subscribe = useCallback((listener: () => void) => (atom ? atom.subscribe(listener) : () => {}), [atom]);
    const getSnapshot = useCallback(() => sessionIdentity(atom), [atom]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface ChardbProviderProps extends Partial<ChardbClientOptions> {
    readonly client?: ChardbClient;
    /**
     * better-auth `createAuthClient(...)` instance. When provided,
     * `ChardbProvider` gets a token from the standard Better Auth `jwt()`
     * plugin through `$fetch("/token")`. Better Auth clients use a dynamic
     * action proxy, so property-presence checks cannot discover optional
     * actions safely. Accepts clients created by `better-auth/react` and
     * `better-auth/client`.
     */
    readonly auth?: AuthClientLike;
}

export function ChardbProvider(props: PropsWithChildren<ChardbProviderProps>): ReactElement {
    const jwtAuth = props.getJwt === undefined ? props.auth : undefined;
    const sessionAtom = authSessionAtom(props.auth ?? null);
    const authSessionIdentity = useAuthSessionIdentity(sessionAtom);
    const jwtSessionIdentity = jwtAuth === undefined ? null : authSessionIdentity;
    const resource = useMemo<ProviderClientResource>(() => {
        if (props.client !== undefined) return { client: props.client, owned: false };
        const getJwt =
            props.getJwt ??
            (jwtAuth
                ? async () => {
                      if (jwtSessionIdentity === null) {
                          throw new Error("chardb: cannot fetch a JWT without an authenticated Better Auth session");
                      }
                      const r = await jwtAuth.$fetch<{ token: string }>("/token");
                      if (r.error || !r.data?.token) {
                          throw new Error(`chardb: failed to fetch JWT (${r.error?.message ?? "no token"})`);
                      }
                      return r.data.token;
                  }
                : undefined);
        if (!props.endpoint || !getJwt) {
            throw new Error("ChardbProvider requires {endpoint} plus either {getJwt} or {auth: createAuthClient(...)}");
        }
        const controller = createDeferredChardbClientController(
            {
                endpoint: props.endpoint,
                getJwt,
                ...(props.clientId !== undefined ? { clientId: props.clientId } : {}),
                ...(props.mutationTimeoutMs !== undefined ? { mutationTimeoutMs: props.mutationTimeoutMs } : {}),
            },
            { autoStartOnOperation: false }
        );
        return { client: controller.client, owned: true, start: controller.start };
    }, [
        props.client,
        props.endpoint,
        props.getJwt,
        jwtAuth,
        jwtSessionIdentity,
        props.clientId,
        props.mutationTimeoutMs,
    ]);
    const pendingCloses = useRef(new WeakMap<ChardbClient, Set<PendingClientClose>>());

    useEffect(() => {
        const pendingForClient = pendingCloses.current.get(resource.client);
        if (pendingForClient) {
            for (const pending of pendingForClient) pending.cancelled = true;
            pendingCloses.current.delete(resource.client);
        }
        if (resource.owned && (jwtAuth === undefined || jwtSessionIdentity !== null)) resource.start();
        return () => {
            if (!resource.owned) return;
            const pending: PendingClientClose = { cancelled: false };
            let clientClosures = pendingCloses.current.get(resource.client);
            if (!clientClosures) {
                clientClosures = new Set();
                pendingCloses.current.set(resource.client, clientClosures);
            }
            clientClosures.add(pending);
            queueMicrotask(() => {
                clientClosures?.delete(pending);
                if (clientClosures?.size === 0) pendingCloses.current.delete(resource.client);
                if (!pending.cancelled) resource.client.close();
            });
        };
    }, [resource, jwtAuth, jwtSessionIdentity]);

    const value = useMemo<ChardbContextValue>(() => ({ client: resource.client }), [resource.client]);

    return createElement(ChardbCtx.Provider, { value }, props.children);
}

export function useChardb(): ChardbClient {
    const c = useContext(ChardbCtx);
    if (!c) throw new Error("useChardb must be used inside <ChardbProvider>");
    return c.client;
}

export interface UseQueryResult<T> {
    readonly data: T[] | undefined;
    readonly state: "pending" | "live" | "error" | "refetching" | "closed";
}

/**
 * Wire-shape stamp every `defineQuery` value carries. Pulled out of
 * the server `QueryFn` type so the React side can refer to it without
 * dragging in `@chardb/core/server`.
 */
export interface QueryHandleStamp<TArgs> {
    readonly __chardbRef: { toString(): string };
    /** Type-only anchor for the handle's argument shape. */
    readonly __chardbArgs?: TArgs;
}

/**
 * Row inferred from a `defineQuery` handler's return type. Collection
 * queries (`Promise<readonly Row[]>` / `Promise<Row[]>`) resolve to
 * `Row`; scalar queries resolve to the awaited value.
 */
type RowOf<F> = F extends (...args: never[]) => Promise<infer R> ? (R extends readonly (infer Row)[] ? Row : R) : never;

type ArgsOf<F> = F extends (ctx: never, args: infer A) => unknown ? A : never;

export function useQuery<F extends (...args: never[]) => Promise<unknown>>(
    handle: F & QueryHandleStamp<ArgsOf<F>>,
    args: ArgsOf<F>
): UseQueryResult<RowOf<F>> {
    const client = useChardb();
    if (!isHandle(handle)) throw new TypeError("useQuery requires a defineQuery handle and raw JSON args");
    const ref = handle.__chardbRef.toString();
    const ownedArgs = snapshotSubscriptionArguments(args as RawJson);
    const argsIdentity = stableJson(ownedArgs);
    const argsCache = useRef<{ readonly identity: string; readonly args: RawJson }>();
    if (argsCache.current?.identity !== argsIdentity) {
        argsCache.current = { identity: argsIdentity, args: ownedArgs };
    }
    const stableArgs = argsCache.current.args;
    const identity = useMemo(() => ({ client, ref, argsIdentity }), [client, ref, argsIdentity]);
    const [snapshot, setSnapshot] = useState<{
        readonly identity: typeof identity;
        readonly data: RowOf<F>[];
        readonly state: UseQueryResult<RowOf<F>>["state"];
    }>();
    useEffect(() => {
        let active = true;
        setSnapshot(current => (current?.identity === identity ? current : undefined));
        const sub = client.subscribe<RowOf<F>>(ref, stableArgs, (rows, state) => {
            if (active) setSnapshot({ identity, data: rows, state: state ?? "live" });
        });
        return () => {
            active = false;
            sub.unsubscribe();
        };
    }, [client, identity, ref, stableArgs]);
    const data = snapshot?.identity === identity ? snapshot.data : undefined;
    const state = snapshot?.identity === identity ? snapshot.state : "pending";
    return { data, state };
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

/** Bind a Drizzle `file(...)` column to authenticated same-origin upload and download operations. */
export function useFile(column: Column | FileRef): ChardbFileClient {
    return useMemo(() => createFileClient(column), [column]);
}
