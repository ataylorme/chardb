/** `MutationReplayEnvelope` (versioned JSON) — the cached replay payload. */

import type { CdbErrorCode } from "../errors.ts";
import type { Cookie, RawJson } from "../types.ts";

export interface MutationReplayEnvelope {
    readonly v: 1;
    readonly status: "ok" | "user_error";
    readonly rowsAffected: number;
    readonly lastInsertRowid?: number | null;
    readonly returning?: readonly RawJson[];
    readonly errorCode?: CdbErrorCode;
    readonly errorMessage?: string;
    readonly cookie: Cookie;
    readonly warnings?: readonly string[];
}

export function encodeEnvelope(env: MutationReplayEnvelope): string {
    return JSON.stringify(env);
}

export function decodeEnvelope(s: string): MutationReplayEnvelope {
    const v = JSON.parse(s) as MutationReplayEnvelope;
    if (v.v !== 1) throw new TypeError(`unexpected envelope version: ${(v as { v: unknown }).v}`);
    return v;
}
