import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Miniflare } from "miniflare";
import type { CliContext } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/run.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "migration.entry.ts");
const ADMIN_TOKEN = "workerd-migration-secret";
const WORKER_NAME = "migration-upgrade-worker";

interface FixtureState {
    readonly catalog: {
        readonly schema: {
            readonly activeVersion: number;
            readonly activeEpoch: number;
            readonly status: string;
        };
        readonly users: readonly Record<string, unknown>[];
        readonly appliedSteps: number;
    };
    readonly cdb: {
        readonly schema: {
            readonly activeVersion: number;
            readonly activeEpoch: number;
            readonly status: string;
        };
        readonly rows: readonly Record<string, unknown>[];
        readonly opLogRows: number;
        readonly appliedSteps: number;
    };
}

let persistencePath = "";
let scriptV1 = "";
let scriptV2 = "";
let scriptFresh = "";
let scriptLegacy = "";
let mf: Miniflare | undefined;

async function buildWorker(release: "v1" | "v2" | "fresh" | "legacy"): Promise<string> {
    const bundle = path.join(tmpdir(), `chardb-migration-${release}-${process.pid}.bundle.mjs`);
    try {
        const proc = Bun.spawn(
            [
                "bun",
                "build",
                ENTRY,
                "--target=browser",
                "--format=esm",
                "--external=cloudflare:workers",
                `--define=CHARDB_MIGRATION_RELEASE='${release}'`,
                "--outfile",
                bundle,
            ],
            { stdout: "pipe", stderr: "pipe" }
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            throw new Error(`migration fixture bundle failed: ${await new Response(proc.stderr).text()}`);
        }
        let source = await Bun.file(bundle).text();
        source = source.replace(
            "await import(this.#props.path.join(this.#props.migrationFolder, fileName))",
            'await Promise.reject(new Error("Node file migrations are unavailable in workerd"))'
        );
        source = source.replace(
            "await import(nodeSqlite)",
            'await Promise.reject(new Error("Node sqlite is unavailable in workerd"))'
        );
        if (/\bimport\s*\([^"'`]/.test(source)) {
            throw new Error("migration fixture bundle contains an unsupported dynamic module specifier");
        }
        return source;
    } finally {
        await rm(bundle, { force: true });
    }
}

function start(script: string): Miniflare {
    return new Miniflare({
        name: WORKER_NAME,
        modules: true,
        script,
        bindings: { CDB_ADMIN_TOKEN: ADMIN_TOKEN },
        durableObjects: {
            CDB_CATALOG: { className: "Catalog", useSQLite: true },
            CDB_SHARD: { className: "Cdb", useSQLite: true },
        },
        durableObjectsPersist: persistencePath,
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
    });
}

async function stopBeforeRestart(): Promise<void> {
    const current = mf;
    mf = undefined;
    await current?.dispose();
    // Miniflare can resolve dispose before its workerd control socket is gone.
    await Bun.sleep(500);
}

async function waitUntilReady(label: string): Promise<URL> {
    if (!mf) throw new Error(`migration Miniflare is not running during ${label}`);
    return await Promise.race([
        mf.ready,
        Bun.sleep(15_000).then(() => {
            throw new Error(`migration Miniflare did not become ready during ${label}`);
        }),
    ]);
}

async function call<T>(pathname: string, body?: Record<string, unknown>): Promise<T> {
    if (!mf) throw new Error("migration Miniflare is not running");
    const response = await mf.dispatchFetch(`http://example.com${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
}

async function migrate(
    baseUrl: URL,
    targetVersion = 1,
    migrationId = "workerd-v2",
    baseline = false
): Promise<{ readonly out: string; readonly err: string }> {
    let out = "";
    let err = "";
    const ctx: CliContext = {
        cwd: HERE,
        env: { CHARDB_ADMIN_TOKEN: ADMIN_TOKEN },
        stdout: value => {
            out += value;
        },
        stderr: value => {
            err += value;
        },
        async read() {
            throw new Error("migration CLI should not read files");
        },
        async write() {
            throw new Error("migration CLI should not write files");
        },
        async exists() {
            return false;
        },
        fetch: globalThis.fetch,
    };
    const argv = [
        "migrate",
        "--url",
        baseUrl.origin,
        "--id",
        migrationId,
        "--target",
        String(targetVersion),
        "--concurrency",
        "2",
        ...(baseline ? ["--baseline"] : []),
    ];
    const code = await runCli(ctx, argv);
    if (code !== 0) throw new Error(`migration CLI exited ${code}; stdout=${out}; stderr=${err}`);
    return { out, err };
}

beforeAll(async () => {
    persistencePath = await mkdtemp(path.join(tmpdir(), "chardb-migration-workerd-"));
    [scriptV1, scriptV2, scriptFresh, scriptLegacy] = await Promise.all([
        buildWorker("v1"),
        buildWorker("v2"),
        buildWorker("fresh"),
        buildWorker("legacy"),
    ]);
});

afterAll(async () => {
    await mf?.dispose();
    if (persistencePath) await rm(persistencePath, { recursive: true, force: true });
});

test("CLI upgrades persisted Catalog and Cdb state and fences stale epochs", async () => {
    mf = start(scriptV1);
    await waitUntilReady("v1 seed");
    const seeded = await call<{
        readonly route: { readonly domainSchemaEpoch: number };
        readonly result: { readonly ok: boolean; readonly ran?: boolean };
    }>("/fixture/seed", {});
    expect(seeded.route.domainSchemaEpoch).toBe(1);
    expect(seeded.result).toMatchObject({ ok: true, ran: true });
    const before = await call<FixtureState>("/fixture/state");
    expect(before.catalog).toMatchObject({
        schema: { activeVersion: 0, activeEpoch: 1, status: "active" },
        users: [{ id: "migration-user", email: "migration@example.com" }],
        appliedSteps: 0,
    });
    expect(before.cdb).toMatchObject({
        schema: { activeVersion: 0, activeEpoch: 1, status: "active" },
        rows: [{ id: "row-before-upgrade", value: "before" }],
        opLogRows: 1,
        appliedSteps: 0,
    });
    await stopBeforeRestart();

    mf = start(scriptV2);
    const v2Url = await waitUntilReady("v2 upgrade");
    const staleBeforeMigration = await call<{
        readonly result: { readonly ok: boolean; readonly error?: { readonly code: string } };
    }>("/fixture/mutate", {
        mutId: "blocked-before-migration",
        domainSchemaEpoch: 1,
        id: "blocked-before-migration",
        value: "blocked",
        note: null,
    });
    expect(staleBeforeMigration.result).toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH" } });
    const migration = await migrate(v2Url);
    expect(migration.err).toBe("");
    expect(migration.out).toContain("activated shard ShardDO_0");
    expect(migration.out).toContain("applied Catalog schema version 1");
    expect(migration.out).toContain("schema version 1 active at epoch 2");

    const upgraded = await call<FixtureState>("/fixture/state");
    expect(upgraded.catalog).toMatchObject({
        schema: { activeVersion: 1, activeEpoch: 2, status: "active" },
        users: [{ id: "migration-user", email: "migration@example.com", nickname: null }],
        appliedSteps: 1,
    });
    expect(upgraded.cdb).toMatchObject({
        schema: { activeVersion: 1, activeEpoch: 2, status: "active" },
        rows: [{ id: "row-before-upgrade", value: "before", note: "migrated" }],
        opLogRows: 1,
        appliedSteps: 1,
    });

    for (const domainSchemaEpoch of [1, 3]) {
        const rejected = await call<{
            readonly result: { readonly ok: boolean; readonly error?: { readonly code: string } };
        }>("/fixture/mutate", {
            mutId: `wrong-epoch-${domainSchemaEpoch}`,
            domainSchemaEpoch,
            id: `wrong-epoch-${domainSchemaEpoch}`,
            value: "blocked",
            note: null,
        });
        expect(rejected.result).toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH" } });
    }
    const fresh = await call<{ readonly result: { readonly ok: boolean; readonly ran?: boolean } }>("/fixture/mutate", {
        mutId: "fresh-after-migration",
        domainSchemaEpoch: 2,
        id: "row-after-upgrade",
        value: "after",
        note: "fresh",
    });
    expect(fresh.result).toMatchObject({ ok: true, ran: true });
    const afterFresh = await call<FixtureState>("/fixture/state");
    expect(afterFresh.cdb.rows).toEqual([
        { id: "row-after-upgrade", value: "after", note: "fresh" },
        { id: "row-before-upgrade", value: "before", note: "migrated" },
    ]);
    expect(afterFresh.cdb.opLogRows).toBe(2);

    const replay = await call<{ readonly result: { readonly ok: boolean; readonly ran?: boolean } }>(
        "/fixture/mutate",
        {
            mutId: "seed-mutation",
            domainSchemaEpoch: 2,
            id: "row-before-upgrade",
            value: "before",
        }
    );
    expect(replay.result).toMatchObject({ ok: true, ran: false });
    expect((await call<FixtureState>("/fixture/state")).cdb.opLogRows).toBe(2);

    await stopBeforeRestart();
    mf = start(scriptV2);
    await waitUntilReady("v2 reconstruction");
    const reconstructed = await call<FixtureState>("/fixture/state");
    expect(reconstructed).toEqual(afterFresh);
    const route = await call<{ readonly domainSchemaEpoch: number }>("/fixture/route");
    expect(route.domainSchemaEpoch).toBe(2);

    await stopBeforeRestart();
    await rm(persistencePath, { recursive: true, force: true });
    persistencePath = await mkdtemp(path.join(tmpdir(), "chardb-migration-fresh-workerd-"));
    mf = start(scriptFresh);
    const freshUrl = await waitUntilReady("fresh migration");
    const freshMigration = await migrate(freshUrl, 2, "fresh-workerd-v2");
    expect(freshMigration.err).toBe("");
    expect(freshMigration.out).toContain("applied Catalog schema version 1");
    expect(freshMigration.out).toContain("applied Catalog schema version 2");
    const freshSeed = await call<{
        readonly route: { readonly domainSchemaEpoch: number };
        readonly result: { readonly ok: boolean; readonly ran?: boolean };
    }>("/fixture/seed", {});
    expect(freshSeed.route.domainSchemaEpoch).toBe(2);
    expect(freshSeed.result).toMatchObject({ ok: true, ran: true });
    const freshState = await call<FixtureState>("/fixture/state");
    expect(freshState.catalog).toMatchObject({
        schema: { activeVersion: 2, activeEpoch: 2, status: "active" },
        users: [{ id: "migration-user", email: "migration@example.com", nickname: null }],
        appliedSteps: 2,
    });
    expect(freshState.cdb).toMatchObject({
        schema: { activeVersion: 2, activeEpoch: 2, status: "active" },
        rows: [{ id: "row-before-upgrade", value: "before", note: null }],
        opLogRows: 1,
        appliedSteps: 2,
    });

    await stopBeforeRestart();
    await rm(persistencePath, { recursive: true, force: true });
    persistencePath = await mkdtemp(path.join(tmpdir(), "chardb-migration-baseline-workerd-"));
    mf = start(scriptLegacy);
    await waitUntilReady("legacy seed");
    const legacySeed = await call<{
        readonly route: { readonly domainSchemaEpoch: number };
        readonly result: { readonly ok: boolean; readonly ran?: boolean };
    }>("/fixture/seed", {});
    expect(legacySeed.route.domainSchemaEpoch).toBe(1);
    expect(legacySeed.result).toMatchObject({ ok: true, ran: true });
    const legacyState = await call<FixtureState>("/fixture/state");
    expect(legacyState.catalog.schema).toMatchObject({ activeVersion: 0, activeEpoch: 1, status: "active" });
    expect(legacyState.cdb).toMatchObject({
        schema: { activeVersion: 0, activeEpoch: 1, status: "active" },
        rows: [{ id: "row-before-upgrade", value: "before", note: null }],
        opLogRows: 1,
    });

    await stopBeforeRestart();
    mf = start(scriptFresh);
    const baselineUrl = await waitUntilReady("baseline migration");
    const baseline = await migrate(baselineUrl, 2, "baseline-existing-v2", true);
    expect(baseline.err).toBe("");
    expect(baseline.out).toContain("schema version 2 active at epoch 2");
    const adopted = await call<FixtureState>("/fixture/state");
    expect(adopted.catalog).toMatchObject({
        schema: { activeVersion: 2, activeEpoch: 2, status: "active" },
        users: [{ id: "migration-user", email: "migration@example.com", nickname: null }],
        appliedSteps: 2,
    });
    expect(adopted.cdb).toMatchObject({
        schema: { activeVersion: 2, activeEpoch: 2, status: "active" },
        rows: [{ id: "row-before-upgrade", value: "before", note: null }],
        opLogRows: 1,
        appliedSteps: 0,
    });

    if (!mf) throw new Error("migration Miniflare is not running during baseline reconstruction");
    await mf.unsafeEvictDurableObject(WORKER_NAME, "Catalog", { name: "global" });
    await mf.unsafeEvictDurableObject(WORKER_NAME, "Cdb", { name: "ShardDO_0" });
    expect(await call<FixtureState>("/fixture/state")).toEqual(adopted);
}, 60_000);
