import { stableJson } from "../util/canonical.ts";
import { exactAdminObject } from "./admin-http.ts";

export const RECOVERY_CONTINUATION_FORMAT = "chardb-recovery-continuation/v1";

const DIGEST = /^[a-f0-9]{64}$/;
const MAX_RECOVERY_SHARDS = 16_384;
const MAX_CURSOR_BYTES = 256;
const TEXT = new TextEncoder();

interface RecoveryContinuationEnv {
    readonly CDB_ADMIN_TOKEN?: string;
}

export type RecoveryContinuationState =
    | {
          readonly kind: "restore";
          readonly phase: "arm" | "quiescence" | "retention" | "vectors" | "files" | "commit";
          readonly shardIndex: number;
          readonly afterRetainedFileId: string;
          readonly afterVectorId: string;
          readonly afterPhysicalVersion: number;
          readonly files: number;
          readonly filePages: number;
          readonly filesRetained: number;
          readonly retentionPages: number;
          readonly quiescenceTurns: number;
          readonly vectors: number;
          readonly vectorPages: number;
          readonly commitPolls: number;
      }
    | {
          readonly kind: "reconcile";
          readonly phase: "files" | "vectors" | "settle";
          readonly shardIndex: number;
          readonly afterFileId: string;
          readonly afterCreatedSeq: number;
          readonly filesRehydrated: number;
          readonly filePages: number;
          readonly vectorsRequeued: number;
          readonly vectorPages: number;
          readonly settleTurns: number;
          readonly nowMs: number;
      };

interface RecoveryContinuation {
    readonly format: typeof RECOVERY_CONTINUATION_FORMAT;
    readonly recoveryPointDigest: string;
    readonly state: RecoveryContinuationState;
    readonly signature: string;
}

export function parseRecoveryOperationRequest(value: unknown): {
    readonly recoveryPoint: unknown;
    readonly continuation?: unknown;
} {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("backup request body must be an object");
    }
    const hasContinuation = Object.hasOwn(value, "continuation");
    const input = exactAdminObject(value, hasContinuation ? ["continuation", "recoveryPoint"] : ["recoveryPoint"]);
    return hasContinuation
        ? { recoveryPoint: input.recoveryPoint, continuation: input.continuation }
        : { recoveryPoint: input.recoveryPoint };
}

export async function signRecoveryContinuation(
    env: RecoveryContinuationEnv,
    recoveryPointDigest: string,
    state: RecoveryContinuationState
): Promise<RecoveryContinuation> {
    const unsigned = { format: RECOVERY_CONTINUATION_FORMAT, recoveryPointDigest, state } as const;
    const key = await recoveryContinuationKey(env, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, TEXT.encode(stableJson(unsigned)));
    return { ...unsigned, signature: hex(new Uint8Array(signature)) };
}

export async function parseRecoveryContinuation<K extends RecoveryContinuationState["kind"]>(
    env: RecoveryContinuationEnv,
    recoveryPointDigest: string,
    value: unknown,
    kind: K
): Promise<Extract<RecoveryContinuationState, { readonly kind: K }> | undefined> {
    if (value === undefined) return undefined;
    const input = exactAdminObject(value, ["format", "recoveryPointDigest", "signature", "state"]);
    if (
        input.format !== RECOVERY_CONTINUATION_FORMAT ||
        input.recoveryPointDigest !== recoveryPointDigest ||
        typeof input.signature !== "string" ||
        !DIGEST.test(input.signature)
    ) {
        throw new TypeError("recovery continuation identity is invalid");
    }
    const state = parseRecoveryContinuationState(input.state, kind);
    const unsigned = { format: RECOVERY_CONTINUATION_FORMAT, recoveryPointDigest, state } as const;
    const key = await recoveryContinuationKey(env, ["verify"]);
    const verified = await crypto.subtle.verify(
        "HMAC",
        key,
        bytesFromHex(input.signature),
        TEXT.encode(stableJson(unsigned))
    );
    if (!verified) throw new TypeError("recovery continuation signature is invalid");
    return state;
}

export function serializeRecoveryContinuationState(state: RecoveryContinuationState): string {
    return stableJson(state);
}

export function parseStoredRecoveryContinuationState<K extends RecoveryContinuationState["kind"]>(
    value: string,
    kind: K
): Extract<RecoveryContinuationState, { readonly kind: K }> {
    if (typeof value !== "string" || value.length < 2 || value.length > 16_384) {
        throw new TypeError("stored recovery continuation is invalid");
    }
    return parseRecoveryContinuationState(JSON.parse(value), kind);
}

function parseRecoveryContinuationState<K extends RecoveryContinuationState["kind"]>(
    value: unknown,
    kind: K
): Extract<RecoveryContinuationState, { readonly kind: K }> {
    if (kind === "restore") {
        const state = exactAdminObject(value, [
            "afterRetainedFileId",
            "afterPhysicalVersion",
            "afterVectorId",
            "commitPolls",
            "files",
            "filePages",
            "filesRetained",
            "kind",
            "phase",
            "quiescenceTurns",
            "retentionPages",
            "shardIndex",
            "vectors",
            "vectorPages",
        ]);
        if (
            state.kind !== "restore" ||
            !["arm", "quiescence", "retention", "vectors", "files", "commit"].includes(String(state.phase)) ||
            !validRecoveryIndex(state.shardIndex) ||
            !validCursor(state.afterRetainedFileId) ||
            !validCursor(state.afterVectorId) ||
            !validRecoveryCount(state.afterPhysicalVersion) ||
            !validRecoveryCount(state.commitPolls) ||
            !validRecoveryCount(state.files) ||
            !validRecoveryCount(state.filePages) ||
            !validRecoveryCount(state.filesRetained) ||
            !validRecoveryCount(state.quiescenceTurns) ||
            !validRecoveryCount(state.retentionPages) ||
            !validRecoveryCount(state.vectors) ||
            !validRecoveryCount(state.vectorPages)
        ) {
            throw new TypeError("restore continuation state is invalid");
        }
        return state as unknown as Extract<RecoveryContinuationState, { readonly kind: K }>;
    }
    const state = exactAdminObject(value, [
        "afterCreatedSeq",
        "afterFileId",
        "filesRehydrated",
        "filePages",
        "kind",
        "nowMs",
        "phase",
        "settleTurns",
        "shardIndex",
        "vectorsRequeued",
        "vectorPages",
    ]);
    if (
        state.kind !== "reconcile" ||
        !["files", "vectors", "settle"].includes(String(state.phase)) ||
        !validRecoveryIndex(state.shardIndex) ||
        !validCursor(state.afterFileId) ||
        !validRecoveryCount(state.afterCreatedSeq) ||
        !validRecoveryCount(state.filesRehydrated) ||
        !validRecoveryCount(state.filePages) ||
        !validRecoveryCount(state.vectorsRequeued) ||
        !validRecoveryCount(state.vectorPages) ||
        !validRecoveryCount(state.settleTurns) ||
        !validRecoveryCount(state.nowMs)
    ) {
        throw new TypeError("reconcile continuation state is invalid");
    }
    return state as unknown as Extract<RecoveryContinuationState, { readonly kind: K }>;
}

function validRecoveryIndex(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_RECOVERY_SHARDS;
}

function validRecoveryCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validCursor(value: unknown): value is string {
    return typeof value === "string" && TEXT.encode(value).byteLength <= MAX_CURSOR_BYTES;
}

async function recoveryContinuationKey(
    env: RecoveryContinuationEnv,
    usages: readonly ("sign" | "verify")[]
): Promise<CryptoKey> {
    if (typeof env.CDB_ADMIN_TOKEN !== "string" || env.CDB_ADMIN_TOKEN.length < 1) {
        throw new TypeError("admin token is misconfigured");
    }
    return await crypto.subtle.importKey(
        "raw",
        TEXT.encode(env.CDB_ADMIN_TOKEN),
        { name: "HMAC", hash: "SHA-256" },
        false,
        usages
    );
}

function hex(bytes: Uint8Array): string {
    return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
    for (let index = 0; index < bytes.length; index++)
        bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    return bytes;
}
