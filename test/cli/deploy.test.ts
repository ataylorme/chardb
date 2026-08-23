import { describe, expect, test } from "bun:test";
import { type DeployPlan, applyDeployPlan, runDeploy } from "../../src/cli/commands/deploy.ts";
import { defineLedger } from "../../src/server/ledger.ts";
import { manifestFromExports } from "../../src/server/manifest.ts";

const events = defineLedger("events", {
    id: "INTEGER PRIMARY KEY",
    topic: "TEXT NOT NULL",
});

function fakeCtx(): {
    cwd: string;
    env: Record<string, string | undefined>;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    read: (p: string) => Promise<string>;
    write: (p: string, c: string) => Promise<void>;
    exists: (p: string) => Promise<boolean>;
    written: Map<string, string>;
} {
    const written = new Map<string, string>();
    return {
        cwd: "/tmp/proj",
        env: {},
        stdout: () => {},
        stderr: () => {},
        read: async () => "",
        write: async (p, c) => {
            written.set(p, c);
        },
        exists: async () => false,
        written,
    };
}

describe("chardb deploy", () => {
    test("renders Logpush job request when ledger has destination", async () => {
        const ctx = fakeCtx();
        const manifest = manifestFromExports({ events });
        const ledgers = new Map<string, ReturnType<typeof defineLedger<string, Record<string, unknown>>>>([
            [events.__chardbRef as string, events as never],
        ]);
        const ledgerOptions = new Map([[events.__chardbRef as string, { logpush: { destination: "r2://logs" } }]]);
        const plan = await runDeploy(ctx, { manifest, ledgerOptions, ledgers });
        expect(plan.logpushJobs).toHaveLength(1);
        expect(plan.logpushJobs[0]?.name).toBe("chardb_ledger_events");
        expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
        const written = ctx.written.get("/tmp/proj/.chardb/deploy.json");
        expect(written).toBeDefined();
        if (written) {
            const parsed = JSON.parse(written) as { version: number };
            expect(parsed.version).toBe(1);
        }
    });

    test("emits empty plan with stable digest when no destinations are configured", async () => {
        const ctx = fakeCtx();
        const manifest = manifestFromExports({});
        const plan1 = await runDeploy(ctx, { manifest, ledgerOptions: new Map() });
        const plan2 = await runDeploy(ctx, { manifest, ledgerOptions: new Map() });
        expect(plan1.logpushJobs).toHaveLength(0);
        expect(plan1.digest).toBe(plan2.digest);
    });
});

interface FetchCall {
    readonly url: string;
    readonly init: RequestInit;
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeFetch(handlers: ReadonlyArray<(call: FetchCall) => Response | Promise<Response>>): {
    readonly fetch: FetchFn;
    readonly calls: ReadonlyArray<FetchCall>;
} {
    const calls: FetchCall[] = [];
    let i = 0;
    const fetchFn: FetchFn = async (input, init = {}) => {
        const call: FetchCall = { url: String(input), init };
        calls.push(call);
        const h = handlers[i++];
        if (!h) throw new Error(`unexpected fetch call #${i}: ${call.url}`);
        return h(call);
    };
    return { fetch: fetchFn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function callAt(calls: ReadonlyArray<FetchCall>, index: number): FetchCall {
    const call = calls[index];
    if (!call) throw new Error(`expected fetch call at index ${index}`);
    return call;
}

const samplePlan: DeployPlan = {
    version: 1,
    digest: "0".repeat(64),
    logpushJobs: [
        {
            name: "chardb_ledger_events",
            dataset: "chardb_ledger",
            destination_conf: "r2://logs",
            enabled: true,
            output_options: { field_names: ["id", "topic"], output_type: "ndjson" },
        },
        {
            name: "chardb_ledger_audits",
            dataset: "chardb_ledger",
            destination_conf: "r2://logs",
            enabled: true,
            output_options: { field_names: ["id"], output_type: "ndjson" },
        },
    ],
    tailConsumer: { enabled: false },
};

describe("applyDeployPlan", () => {
    const creds = { accountId: "acc-1", apiToken: "tok-secret" };

    test("POSTs each job with bearer auth and returns the created ids", async () => {
        const { fetch, calls } = makeFetch([
            () => jsonResponse(200, { success: true, result: { id: 11 } }),
            () => jsonResponse(200, { success: true, result: { id: 22 } }),
        ]);
        const result = await applyDeployPlan(samplePlan, creds, {
            fetch,
            existingJobNames: new Set(),
        });
        expect(result.created).toEqual([
            { name: "chardb_ledger_events", id: 11 },
            { name: "chardb_ledger_audits", id: 22 },
        ]);
        expect(result.skipped).toEqual([]);
        expect(calls).toHaveLength(2);
        const firstCall = callAt(calls, 0);
        expect(firstCall.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc-1/logpush/jobs");
        expect(firstCall.init.method).toBe("POST");
        const auth = (firstCall.init.headers as Record<string, string>).Authorization;
        expect(auth).toBe("Bearer tok-secret");
        const body = JSON.parse(String(firstCall.init.body)) as { name: string };
        expect(body.name).toBe("chardb_ledger_events");
    });

    test("idempotent: skips jobs whose name already exists in the account", async () => {
        const { fetch, calls } = makeFetch([() => jsonResponse(200, { success: true, result: { id: 22 } })]);
        const result = await applyDeployPlan(samplePlan, creds, {
            fetch,
            existingJobNames: new Set(["chardb_ledger_events"]),
        });
        expect(result.skipped).toEqual([{ name: "chardb_ledger_events", reason: "already-exists" }]);
        expect(result.created).toEqual([{ name: "chardb_ledger_audits", id: 22 }]);
        expect(calls).toHaveLength(1);
    });

    test("auto-fetches existing jobs when existingJobNames is omitted", async () => {
        const { fetch, calls } = makeFetch([
            () =>
                jsonResponse(200, {
                    success: true,
                    result: [{ name: "chardb_ledger_events" }],
                }),
            () => jsonResponse(200, { success: true, result: { id: 22 } }),
        ]);
        const result = await applyDeployPlan(samplePlan, creds, { fetch });
        expect(callAt(calls, 0).init.method).toBe("GET");
        expect(result.created.map(c => c.name)).toEqual(["chardb_ledger_audits"]);
    });

    test("surfaces Cloudflare error message when success=false", async () => {
        const { fetch } = makeFetch([
            () =>
                jsonResponse(400, {
                    success: false,
                    errors: [{ code: 1004, message: "invalid destination" }],
                }),
        ]);
        let captured: Error | undefined;
        try {
            await applyDeployPlan(samplePlan, creds, { fetch, existingJobNames: new Set() });
        } catch (e) {
            if (e instanceof Error) captured = e;
        }
        expect(captured?.message).toMatch(/invalid destination/);
        expect(captured?.message).toMatch(/chardb_ledger_events/);
    });

    test("respects creds.apiBase override", async () => {
        const { fetch, calls } = makeFetch([
            () => jsonResponse(200, { success: true, result: { id: 1 } }),
            () => jsonResponse(200, { success: true, result: { id: 2 } }),
        ]);
        await applyDeployPlan(
            samplePlan,
            { ...creds, apiBase: "https://api.test.example" },
            {
                fetch,
                existingJobNames: new Set(),
            }
        );
        expect(callAt(calls, 0).url).toBe("https://api.test.example/accounts/acc-1/logpush/jobs");
    });
});
