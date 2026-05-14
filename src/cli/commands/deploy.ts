/**
 * `chardb deploy` — render the deploy plan from a `ChardbManifest`, and
 * optionally apply it against the Cloudflare Logpush API.
 *
 * `runDeploy` is pure: it writes `.chardb/deploy.json` with the rendered
 * Logpush job request bodies, the tail-consumer Worker spec (if any), and a
 * stable digest keyed by the manifest contents. CI can diff the file against
 * `.chardb/deploy.json` from `main` and refuse the deploy if a sensitive
 * field changed unexpectedly.
 *
 * `applyDeployPlan` takes a rendered plan plus credentials and POSTs each
 * Logpush job to `https://api.cloudflare.com/client/v4/accounts/:id/logpush/jobs`.
 * The `fetch` implementation is injected so the apply path is fully
 * mockable from tests; production callers pass the global `fetch`.
 */

import type { LedgerOptions, LedgerTable } from "../../server/ledger.ts";
import { renderLedgerLogpush, renderLogpushJobRequest } from "../../server/logpush.ts";
import type { ChardbManifest } from "../../server/manifest.ts";
import { sha256Hex, stableJson } from "../../util/canonical.ts";
import type { CliContext } from "../context.ts";

export interface DeployPlan {
    readonly version: 1;
    readonly digest: string;
    readonly logpushJobs: readonly ReturnType<typeof renderLogpushJobRequest>[];
    readonly tailConsumer: {
        readonly enabled: boolean;
        readonly destinationName?: string;
    };
}

export interface DeployInput {
    readonly manifest: ChardbManifest;
    /**
     * Per-ledger options. `defineLedger` carries the destination through its
     * type, but the runtime handle does not (`logpush` is build-time metadata).
     * `chardb deploy` therefore receives the lookup explicitly so the planner
     * stays agnostic of the bundler's storage choice.
     */
    readonly ledgerOptions: ReadonlyMap<string, LedgerOptions>;
    /** Resolved ledger handles by ref. */
    readonly ledgers?: ReadonlyMap<string, LedgerTable<string, unknown>>;
    readonly tailDestination?: string;
}

export async function runDeploy(ctx: CliContext, input: DeployInput): Promise<DeployPlan> {
    const jobs: ReturnType<typeof renderLogpushJobRequest>[] = [];
    for (const [ref, opts] of input.ledgerOptions) {
        const ledger = input.ledgers?.get(ref);
        if (!ledger) continue;
        const spec = renderLedgerLogpush(ledger, opts);
        if (!spec) continue;
        jobs.push(renderLogpushJobRequest(spec));
    }
    const tailConsumer = input.tailDestination
        ? { enabled: true, destinationName: input.tailDestination }
        : { enabled: false };
    const planSeed = stableJson({ jobs, tailConsumer });
    const digest = sha256Hex(planSeed);
    const plan: DeployPlan = { version: 1, digest, logpushJobs: jobs, tailConsumer };
    await ctx.write(`${ctx.cwd}/.chardb/deploy.json`, JSON.stringify(plan, null, 2));
    ctx.stdout(`chardb deploy: rendered ${jobs.length} Logpush job(s); plan digest ${digest.slice(0, 12)}\n`);
    return plan;
}

/** Cloudflare API credentials and target. Token must have `Logpush:Edit`. */
export interface CloudflareApiCreds {
    readonly accountId: string;
    readonly apiToken: string;
    /** Override the API base for tests / Cloudflare's gov regions. */
    readonly apiBase?: string;
}

/** Minimal subset of the Cloudflare Logpush response envelope we read. */
interface LogpushApiEnvelope {
    readonly success: boolean;
    readonly errors?: ReadonlyArray<{ readonly code?: number; readonly message?: string }>;
    readonly result?: { readonly id?: number | string } | null;
}

/** Minimal `fetch`-shaped surface; lets tests pass a stub without `preconnect`. */
export type DeployFetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ApplyDeployOptions {
    /** Inject for tests; defaults to `globalThis.fetch`. */
    readonly fetch?: DeployFetchFn;
    /**
     * Skip jobs whose `name` already exists in the account (idempotent apply).
     * Default `true`. When `false`, the caller is responsible for clearing
     * `existingJobNames`.
     */
    readonly skipExisting?: boolean;
    /** Pre-fetched list of existing job names; if omitted, will GET first. */
    readonly existingJobNames?: ReadonlySet<string>;
}

export interface ApplyDeployResult {
    readonly created: ReadonlyArray<{ readonly name: string; readonly id: string | number }>;
    readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: "already-exists" }>;
}

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

function authHeaders(creds: CloudflareApiCreds): Record<string, string> {
    return {
        Authorization: `Bearer ${creds.apiToken}`,
        "Content-Type": "application/json",
    };
}

/**
 * Apply a rendered `DeployPlan` against the Cloudflare Logpush API.
 *
 * The function is idempotent on job `name`: by default we GET the existing
 * job list and skip any whose name we'd otherwise re-create, so re-running
 * a deploy is safe. Errors raised by the API surface as `Error` with the
 * Cloudflare error message attached.
 *
 * The `tailConsumer` field of the plan is informational only here — wiring
 * a tail-consumer Worker requires `wrangler deploy` of a separate Worker
 * binary, which we do *not* attempt to drive from this function. The
 * caller's CI pipeline runs `wrangler deploy` first and then this apply.
 */
export async function applyDeployPlan(
    plan: DeployPlan,
    creds: CloudflareApiCreds,
    opts: ApplyDeployOptions = {}
): Promise<ApplyDeployResult> {
    const fetchFn: DeployFetchFn = opts.fetch ?? (globalThis.fetch as DeployFetchFn);
    if (typeof fetchFn !== "function") {
        throw new Error("applyDeployPlan requires a fetch implementation (globalThis.fetch or opts.fetch)");
    }
    const base = creds.apiBase ?? DEFAULT_API_BASE;
    const url = `${base}/accounts/${encodeURIComponent(creds.accountId)}/logpush/jobs`;

    const skipExisting = opts.skipExisting !== false;
    let existing: ReadonlySet<string>;
    if (opts.existingJobNames) {
        existing = opts.existingJobNames;
    } else if (skipExisting) {
        const r = await fetchFn(url, { method: "GET", headers: authHeaders(creds) });
        if (!r.ok) throw new Error(`logpush GET failed: HTTP ${r.status}`);
        const env = (await r.json()) as { readonly result?: ReadonlyArray<{ readonly name?: string }> };
        existing = new Set((env.result ?? []).map(j => j.name).filter((n): n is string => typeof n === "string"));
    } else {
        existing = new Set<string>();
    }

    const created: { name: string; id: string | number }[] = [];
    const skipped: { name: string; reason: "already-exists" }[] = [];
    for (const job of plan.logpushJobs) {
        if (existing.has(job.name)) {
            skipped.push({ name: job.name, reason: "already-exists" });
            continue;
        }
        const r = await fetchFn(url, {
            method: "POST",
            headers: authHeaders(creds),
            body: JSON.stringify(job),
        });
        const env = (await r.json()) as LogpushApiEnvelope;
        if (!r.ok || !env.success) {
            const reason = env.errors?.[0]?.message ?? `HTTP ${r.status}`;
            throw new Error(`logpush POST failed for ${job.name}: ${reason}`);
        }
        const id = env.result?.id ?? "";
        created.push({ name: job.name, id });
    }
    return { created, skipped };
}
