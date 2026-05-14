/**
 * Function-reference identity for `defineMutation` / `defineQuery` / etc.
 *
 * The Vite plugin walks the user's bundle, finds every `defineXxx(...)` call
 * assigned to a named export, and rewrites the returned function to set
 * `fn.__chardbRef = "<exportPath>#<exportName>"`. Clients pass the function
 * itself (`useMutation(postMessage)`); the SDK reads `__chardbRef` to fill
 * the wire field. **Users never type a wire identifier.**
 *
 * For tests/dev (no bundler), refs are auto-derived from `Function.name` so
 * the helpers work end-to-end before the plugin runs.
 */

import { ChardbRef } from "../types.ts";

const REF_KEY = "__chardbRef" as const;

export type ChardbFunctionKind = "mutation" | "query" | "ledger" | "cron" | "stream" | "gsi" | "presenceKey";

/** Marker carried on every helper-produced value. */
export interface ChardbRefMarker {
    readonly [REF_KEY]: ChardbRef;
    readonly __chardbKind: ChardbFunctionKind;
}

export function attachRef<T extends object>(target: T, kind: ChardbFunctionKind, ref?: string): T & ChardbRefMarker {
    const value: ChardbRef = ChardbRef(ref ?? autoRef(target, kind));
    Object.defineProperty(target, REF_KEY, { value, enumerable: false, configurable: true });
    Object.defineProperty(target, "__chardbKind", {
        value: kind,
        enumerable: false,
        configurable: true,
    });
    return target as T & ChardbRefMarker;
}

export function readRef(target: unknown): ChardbRef {
    if (target === null || (typeof target !== "object" && typeof target !== "function")) {
        throw new TypeError("readRef: target is not an object or function");
    }
    const ref = (target as Record<string, unknown>)[REF_KEY];
    if (typeof ref !== "string") {
        throw new TypeError("readRef: target has no __chardbRef (was it defined with chardb/server?)");
    }
    return ChardbRef(ref);
}

function autoRef(target: object, kind: ChardbFunctionKind): string {
    const name =
        typeof target === "function" && typeof (target as { name?: string }).name === "string"
            ? (target as { name: string }).name
            : "anonymous";
    return `${kind}#${name || "anonymous"}`;
}
