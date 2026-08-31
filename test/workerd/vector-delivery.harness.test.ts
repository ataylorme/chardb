import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "../../scripts/miniflare-lifecycle.mjs";
import { cdbVectorizePhysicalId } from "../../src/server/do/cdb-vectorize-wire.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "vector-delivery.entry.ts");

interface MutationResponse {
    readonly ok: boolean;
    readonly ran?: boolean;
    readonly result?: { readonly id: string; readonly vectorId: string } | string;
}

interface CdbState {
    readonly rows: readonly { readonly id: string; readonly embedding: string | null }[];
    readonly heads: readonly {
        readonly vector_id: string;
        readonly version: number;
        readonly delivered_version: number;
        readonly state: string;
    }[];
    readonly outbox: readonly {
        readonly vector_id: string;
        readonly target_version: number;
        readonly operation: string;
        readonly phase: string;
        readonly mutation_id: string | null;
        readonly accepted_at: number | null;
        readonly attempts: number;
        readonly next_attempt_at: number;
        readonly leased_until: number | null;
        readonly terminal_failure: number;
        readonly last_error: string | null;
    }[];
    readonly attempts: readonly { readonly vector_id: string; readonly physical_version: number }[];
}

interface VectorState {
    readonly processedUpToMutation: string | null;
    readonly documents: readonly { readonly id: string; readonly namespace: string }[];
    readonly calls: readonly {
        readonly sequence: number;
        readonly operation: "upsert" | "delete";
        readonly ids_json: string;
        readonly payload_hash: string;
    }[];
    readonly pending: readonly { readonly sequence: number; readonly operation: string }[];
}

let mf: Miniflare | undefined;
let temporaryPath = "";
let workerSource = "";

async function buildWorker(): Promise<string> {
    const bundle = path.join(temporaryPath, "vector-delivery.worker.mjs");
    const child = Bun.spawn(
        [
            "bun",
            "build",
            ENTRY,
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:workers",
            "--outfile",
            bundle,
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
    const source = await Bun.file(bundle).text();
    if (source.includes("import(")) throw new Error("vector delivery fixture bundle contains a dynamic import");
    return source;
}

async function startRuntime(): Promise<Miniflare> {
    const instance = new Miniflare({
        name: "vector-delivery-proof",
        modules: true,
        script: workerSource,
        durableObjects: {
            CDB: { className: "VectorProofCdb", useSQLite: true },
            PLATFORM_CDB: { className: "PlatformAlarmVectorProofCdb", useSQLite: true },
            VECTOR_INDEX: { className: "VectorIndexProbe", useSQLite: true },
        },
        durableObjectsPersist: path.join(temporaryPath, "durable-objects"),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
    });
    try {
        await instance.ready;
        return instance;
    } catch (error) {
        await disposeMiniflareBounded(instance, { label: "failed vector delivery startup" });
        throw error;
    }
}

async function restartRuntime(): Promise<void> {
    const disposed = await disposeMiniflareBounded(mf, { label: "vector delivery restart", timeoutMs: 5_000 });
    mf = undefined;
    if (disposed.status !== "disposed") throw new Error(`vector delivery restart failed: ${disposed.status}`);
    mf = await startRuntime();
}

async function call<TResult>(pathName: string, input: Record<string, unknown> = {}): Promise<TResult> {
    if (!mf) throw new Error("vector delivery Miniflare is unavailable");
    const response = await mf.dispatchFetch(`http://example.com/${pathName}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });
    const result = (await response.json()) as TResult;
    if (response.status !== 200) throw new Error(`${pathName} returned ${response.status}: ${JSON.stringify(result)}`);
    return result;
}

async function callFailure(
    pathName: string,
    input: Record<string, unknown>
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    if (!mf) throw new Error("vector delivery Miniflare is unavailable");
    const response = await mf.dispatchFetch(`http://example.com/${pathName}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function ids(call: VectorState["calls"][number]): readonly string[] {
    const parsed: unknown = JSON.parse(call.ids_json);
    if (!Array.isArray(parsed) || !parsed.every(value => typeof value === "string")) {
        throw new Error("vector proof stored malformed call ids");
    }
    return parsed;
}

function acceptedMutationId(state: CdbState): string {
    const mutationId = state.outbox[0]?.mutation_id;
    if (!mutationId) throw new Error("vector proof expected one accepted mutation id");
    return mutationId;
}

beforeAll(async () => {
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-vector-delivery-"));
    workerSource = await buildWorker();
    mf = await startRuntime();
});

afterAll(async () => {
    const disposed = await disposeMiniflareBounded(mf, { label: "vector delivery final teardown", timeoutMs: 5_000 });
    mf = undefined;
    if (disposed.status !== "disposed" && disposed.status !== "absent") {
        throw new Error(`vector delivery teardown failed: ${disposed.status}`);
    }
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
});

describe("native asynchronous Vectorize delivery", () => {
    test("separates acceptance from visibility across loss, restart, replacement, cleanup, and delete", async () => {
        const refs = await call<{ readonly put: string; readonly replace: string; readonly delete: string }>("refs");
        const mutate = (input: Record<string, unknown>) => call<MutationResponse>("mutate", input);
        const mutation = (mutId: string, ref: string, body: string, values: number[]) => ({
            organizationId: "org-native-a",
            mutId,
            ref,
            args: { organizationId: "org-native-a", id: "message-a", body, values },
        });

        await call("vector-fault", { mode: "accept_then_throw" });
        const first = await mutate(mutation("put-1", refs.put, "first", [0.25, -0.5, 1]));
        expect(first).toMatchObject({ ok: true, ran: true, result: { id: "message-a" } });
        const vectorId = (first.result as { vectorId: string }).vectorId;
        const physical1 = cdbVectorizePhysicalId(vectorId, 1);
        expect((await call<CdbState>("state")).outbox).toEqual([
            expect.objectContaining({ phase: "submit", mutation_id: null, attempts: 0 }),
        ]);
        expect((await call<VectorState>("vector-state")).calls).toEqual([]);
        await call("alarm");
        let state = await call<CdbState>("state");
        let remote = await call<VectorState>("vector-state");
        expect(state.heads).toEqual([expect.objectContaining({ version: 1, delivered_version: 0, state: "pending" })]);
        expect(state.outbox).toEqual([expect.objectContaining({ phase: "submit", mutation_id: null, attempts: 1 })]);
        expect(remote.documents).toEqual([]);
        expect(remote.pending).toHaveLength(1);

        await call("force-due");
        await call("alarm");
        state = await call<CdbState>("state");
        expect(state.outbox).toEqual([
            expect.objectContaining({ phase: "verify", mutation_id: expect.any(String), attempts: 2 }),
        ]);
        expect(state.heads[0]).toMatchObject({ delivered_version: 0, state: "pending" });

        const beforeRestart = state;
        await restartRuntime();
        expect(await call<CdbState>("state")).toEqual(beforeRestart);
        await call("force-due");
        await call("alarm");
        expect((await call<CdbState>("state")).heads[0]).toMatchObject({ delivered_version: 0, state: "pending" });

        expect(await call<{ readonly processed: number }>("vector-process", { limit: 100 })).toEqual({ processed: 2 });
        await call("force-due");
        await call("alarm");
        state = await call<CdbState>("state");
        expect(state.heads[0]).toMatchObject({ version: 1, delivered_version: 1, state: "ready" });
        remote = await call<VectorState>("vector-state");
        expect(remote.documents.map(document => document.id)).toEqual([physical1]);
        const firstCalls = remote.calls.filter(item => item.operation === "upsert");
        expect(firstCalls).toHaveLength(2);
        expect(firstCalls[0]?.ids_json).toBe(firstCalls[1]?.ids_json);
        expect(firstCalls[0]?.payload_hash).toBe(firstCalls[1]?.payload_hash);

        await mutate(mutation("replace-2", refs.replace, "second", [-1, 0.5, 0.25]));
        await call("alarm");
        state = await call<CdbState>("state");
        expect(state.heads[0]).toMatchObject({ version: 2, delivered_version: 1, state: "pending" });
        expect(state.outbox[0]).toMatchObject({ target_version: 2, phase: "verify" });
        await mutate(mutation("replace-3", refs.replace, "third", [0, 1, 0.5]));
        await call("alarm");
        state = await call<CdbState>("state");
        expect(state.heads[0]).toMatchObject({ version: 3, delivered_version: 1, state: "pending" });
        expect(state.outbox[0]).toMatchObject({ target_version: 3, phase: "verify" });

        await call("vector-process", { limit: 100 });
        remote = await call<VectorState>("vector-state");
        expect(remote.processedUpToMutation).toBe(acceptedMutationId(state));
        await call("force-due");
        await call("alarm");
        state = await call<CdbState>("state");
        expect(state.heads[0]).toMatchObject({ version: 3, delivered_version: 3, state: "ready" });
        expect(state.outbox[0]).toMatchObject({ operation: "delete", phase: "submit" });
        const physical2 = cdbVectorizePhysicalId(vectorId, 2);
        const physical3 = cdbVectorizePhysicalId(vectorId, 3);

        await call("force-due");
        await call("alarm");
        state = await call<CdbState>("state");
        remote = await call<VectorState>("vector-state");
        expect(state.outbox[0]).toMatchObject({ operation: "delete", phase: "verify" });
        expect(remote.documents.map(document => document.id).sort()).toEqual([physical1, physical2, physical3].sort());
        await call("force-due");
        await call("alarm");
        expect((await call<CdbState>("state")).outbox[0]).toMatchObject({ phase: "verify" });
        await call("vector-process", { limit: 100 });
        remote = await call<VectorState>("vector-state");
        expect(remote.processedUpToMutation).toBe(acceptedMutationId(state));
        await call("force-due");
        await call("alarm");
        state = await call<CdbState>("state");
        expect(state.heads[0]).toMatchObject({ state: "ready", delivered_version: 3 });
        expect(state.outbox[0]).toMatchObject({
            operation: "delete",
            phase: "verify",
            terminal_failure: 1,
            last_error: "terminal: external vector absence could not be proven",
        });
        expect((await call<VectorState>("vector-state")).documents.map(document => document.id)).toEqual([physical3]);

        await call("vector-fault", { mode: "delete_accept_then_throw", targetId: physical3 });
        expect(
            await mutate({
                organizationId: "org-native-a",
                mutId: "delete-4",
                ref: refs.delete,
                args: { organizationId: "org-native-a", id: "message-a" },
            })
        ).toMatchObject({ ok: true, ran: true });
        await call("alarm");
        state = await call<CdbState>("state");
        remote = await call<VectorState>("vector-state");
        expect(state.rows).toEqual([]);
        expect(state.heads[0]).toMatchObject({ version: 4, state: "deleting" });
        expect(state.outbox[0]).toMatchObject({ operation: "delete", phase: "submit" });
        expect(remote.documents.map(document => document.id)).toEqual([physical3]);
        const lostDelete = remote.calls.at(-1) as VectorState["calls"][number];
        expect(lostDelete.operation).toBe("delete");

        await call("force-due");
        await call("alarm");
        state = await call<CdbState>("state");
        expect(state.outbox[0]).toMatchObject({ phase: "verify", mutation_id: expect.any(String) });
        remote = await call<VectorState>("vector-state");
        const deleteCalls = remote.calls.filter(item => item.operation === "delete" && ids(item).includes(physical3));
        expect(deleteCalls.length).toBeGreaterThanOrEqual(2);
        expect(deleteCalls.at(-1)?.ids_json).toBe(lostDelete.ids_json);
        expect(remote.documents.map(document => document.id)).toEqual([physical3]);

        await call("vector-process", { limit: 100 });
        await call("force-due");
        await call("alarm");
        state = await call<CdbState>("state");
        remote = await call<VectorState>("vector-state");
        expect(state.heads).toEqual([]);
        expect(state.outbox).toEqual([]);
        expect(state.attempts).toEqual([]);
        expect(remote.documents).toEqual([]);
    }, 30_000);

    test("keeps an accepted delete active at the poll cap until its settlement floor", async () => {
        const shardId = "vector-native-delete-floor";
        const organizationId = "org-native-delete-floor";
        const refs = await call<{ readonly put: string; readonly delete: string }>("refs", { shardId });
        const created = await call<MutationResponse>("mutate", {
            shardId,
            organizationId,
            mutId: "native-delete-floor-put",
            ref: refs.put,
            args: {
                organizationId,
                id: "message-delete-floor",
                body: "accepted delete settlement floor",
                values: [1, 0, 0],
            },
        });
        expect(created).toMatchObject({ ok: true, ran: true });
        const vectorId = (created.result as { readonly vectorId: string }).vectorId;

        await call("alarm", { shardId });
        await call("vector-process", { limit: 100 });
        await call("force-due", { shardId });
        await call("alarm", { shardId });
        expect((await call<CdbState>("state", { shardId })).heads[0]).toMatchObject({
            vector_id: vectorId,
            state: "ready",
            delivered_version: 1,
        });

        await expect(
            call<MutationResponse>("mutate", {
                shardId,
                organizationId,
                mutId: "native-delete-floor-delete",
                ref: refs.delete,
                args: { organizationId, id: "message-delete-floor" },
            })
        ).resolves.toMatchObject({ ok: true, ran: true });
        await call("alarm", { shardId });
        const accepted = await call<CdbState>("state", { shardId });
        const acceptedAt = accepted.outbox[0]?.accepted_at;
        if (acceptedAt === null || acceptedAt === undefined) throw new Error("accepted delete has no timestamp");
        expect(accepted.outbox[0]).toMatchObject({
            operation: "delete",
            phase: "verify",
            mutation_id: expect.any(String),
            accepted_at: expect.any(Number),
            terminal_failure: 0,
        });

        await call("force-accepted-delete-poll-bound", { shardId });
        const consumedAlarm = await call<{ readonly alarm: number | null }>("scheduled-alarm", { shardId });
        expect(consumedAlarm.alarm).toBeInteger();
        expect(consumedAlarm.alarm as number).toBeGreaterThan(acceptedAt);
        expect(consumedAlarm.alarm as number).toBeLessThan(acceptedAt + 120_000);
        await call("alarm", { shardId });

        const deferred = await call<CdbState>("state", { shardId });
        expect(deferred.outbox[0]).toMatchObject({
            operation: "delete",
            phase: "verify",
            attempts: 33,
            next_attempt_at: acceptedAt + 120_000,
            leased_until: null,
            terminal_failure: 0,
            last_error: null,
        });
        expect(deferred.heads[0]).toMatchObject({ vector_id: vectorId, state: "deleting" });
        const deferredAlarm = await call<{ readonly alarm: number | null }>("scheduled-alarm", { shardId });
        expect(deferredAlarm.alarm).toBeInteger();
        expect(deferredAlarm.alarm as number).toBeGreaterThan(consumedAlarm.alarm as number);
        expect(deferredAlarm.alarm as number).toBeLessThan(deferred.outbox[0]?.next_attempt_at ?? 0);

        expect(await call<{ readonly processed: number }>("vector-process", { limit: 100 })).toEqual({ processed: 1 });
        await call("force-due", { shardId });
        await call("alarm", { shardId });

        const settled = await call<CdbState>("state", { shardId });
        expect(settled.heads).toEqual([]);
        expect(settled.outbox).toEqual([]);
        expect(settled.attempts).toEqual([]);
    }, 30_000);

    test("crosses Worker to Cdb RPC while preserving one validated match and its metadata", async () => {
        const refs = await call<{ readonly benchmarkPut: string }>("refs");
        const values = Array.from({ length: 32 }, (_, index) => (index === 0 ? 1 : 0));
        const organizationId = "org-native-rpc";
        const mutation = await call<MutationResponse>("mutate", {
            organizationId,
            mutId: "rpc-put-1",
            ref: refs.benchmarkPut,
            args: {
                organizationId,
                id: "rpc-message",
                body: "rpc metadata",
                values,
            },
        });
        expect(mutation).toMatchObject({ ok: true, ran: true, result: { id: "rpc-message" } });
        const vectorId = (mutation.result as { readonly vectorId: string }).vectorId;

        let ready = false;
        for (let turn = 0; turn < 16; turn++) {
            const current = await call<CdbState>("state");
            const head = current.heads.find(candidate => candidate.vector_id === vectorId);
            if (head?.state === "ready" && head.version === head.delivered_version) {
                ready = true;
                break;
            }
            await call("vector-process", { limit: 100 });
            await call("force-due");
            await call("alarm");
        }
        expect(ready).toBe(true);

        const search = await call("rpc-vector-search", { organizationId, values, limit: 1 });
        expect(search).toEqual({
            ok: true,
            value: [
                {
                    vectorId,
                    rowPk: "rpc-message",
                    score: 1,
                    metadata: { body: "rpc metadata" },
                },
            ],
        });

        expect(
            await callFailure("rpc-vector-search", {
                organizationId,
                values,
                limit: 1,
                domainSchemaEpoch: 2,
            })
        ).toEqual({
            status: 500,
            body: {
                code: "CDB_STALE_EPOCH",
                error: expect.stringContaining("schema epoch"),
            },
        });
    }, 30_000);

    test("uses real platform alarm consumption and preserves the earliest replacement", async () => {
        const shardId = "vector-native-platform-alarm";
        const organizationId = "org-native-platform-alarm";
        const platform = { shardId, platformAlarm: true };
        const refs = await call<{ readonly put: string }>("refs", platform);
        await expect(
            call<MutationResponse>("mutate", {
                ...platform,
                organizationId,
                mutId: "native-platform-alarm-1",
                ref: refs.put,
                args: {
                    organizationId,
                    id: "message-platform-alarm",
                    body: "platform alarm",
                    values: [1, 0, 0],
                },
            })
        ).resolves.toMatchObject({ ok: true, ran: true });
        type AlarmTurn = {
            readonly turn: number;
            readonly entry_alarm: number | null;
            readonly exit_alarm: number | null;
            readonly next_attempt_at: number | null;
        };
        let turns: readonly AlarmTurn[] = [];
        for (let turn = 0; turn < 200 && turns.length === 0; turn++) {
            turns = await call<readonly AlarmTurn[]>("alarm-turns", platform);
            if (turns.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
        }

        expect(turns).not.toEqual([]);
        const firstTurn = turns[0] as AlarmTurn;
        expect(firstTurn.turn).toBe(1);
        expect(firstTurn.entry_alarm).toBeNull();
        expect(firstTurn.exit_alarm).toBeInteger();
        expect(firstTurn.next_attempt_at).toBeInteger();
        expect(firstTurn.exit_alarm).toBe(firstTurn.next_attempt_at);
        const state = await call<CdbState>("state", platform);
        expect(state.outbox[0]).toMatchObject({ phase: "verify" });
        expect(state.outbox[0]?.attempts).toBeGreaterThanOrEqual(1);
    }, 30_000);

    test("wakes a future delete settlement through the platform without manual maintenance", async () => {
        const shardId = "vector-native-platform-delete";
        const organizationId = "org-native-platform-delete";
        const platform = { shardId, platformAlarm: true };
        const refs = await call<{ readonly put: string; readonly delete: string }>("refs", platform);
        await expect(
            call<MutationResponse>("mutate", {
                ...platform,
                organizationId,
                mutId: "native-platform-delete-put",
                ref: refs.put,
                args: {
                    organizationId,
                    id: "message-platform-delete",
                    body: "platform delete wake",
                    values: [1, 0, 0],
                },
            })
        ).resolves.toMatchObject({ ok: true, ran: true });

        let ready = false;
        for (let turn = 0; turn < 400 && !ready; turn++) {
            const remote = await call<VectorState>("vector-state");
            if (remote.pending.length > 0) await call("vector-process", { limit: 100 });
            const state = await call<CdbState>("state", platform);
            ready = state.heads[0]?.state === "ready" && state.heads[0]?.delivered_version === 1;
            if (!ready) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(ready).toBe(true);

        await expect(
            call<MutationResponse>("mutate", {
                ...platform,
                organizationId,
                mutId: "native-platform-delete-delete",
                ref: refs.delete,
                args: { organizationId, id: "message-platform-delete" },
            })
        ).resolves.toMatchObject({ ok: true, ran: true });
        const callsBefore = (await call<VectorState>("vector-state")).calls.filter(
            item => item.operation === "delete"
        ).length;
        const deferred = await call<{ readonly wakeAt: number }>("defer-delete-wake", {
            ...platform,
            delayMs: 50,
        });
        expect(deferred.wakeAt).toBeGreaterThan(Date.now());

        let deleteCalls = callsBefore;
        for (let turn = 0; turn < 300 && deleteCalls === callsBefore; turn++) {
            deleteCalls = (await call<VectorState>("vector-state")).calls.filter(
                item => item.operation === "delete"
            ).length;
            if (deleteCalls === callsBefore) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(deleteCalls).toBeGreaterThan(callsBefore);
        expect((await call<CdbState>("state", platform)).outbox[0]).toMatchObject({
            operation: "delete",
            phase: "verify",
        });
        const turns = await call<readonly { readonly entry_alarm: number | null }[]>("alarm-turns", platform);
        expect(turns.length).toBeGreaterThanOrEqual(2);
        expect(turns.every(turn => turn.entry_alarm === null)).toBe(true);
    }, 30_000);
});
