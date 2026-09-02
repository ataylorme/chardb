import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeJsonAtomically } from "../../scripts/browser-proof-report.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "migration.entry.ts");
const PHASE_ENTRY = path.join(HERE, "migration.phase.mjs");
const CONTROL_SCHEMA = "chardb.migration-workerd-phase-control.v1";
const RESULT_SCHEMA = "chardb.migration-workerd-phase-result.v1";
const PHASE_TIMEOUT_MS = 30_000;

interface FixtureState {
    readonly catalog: {
        readonly schema: { readonly activeVersion: number; readonly activeEpoch: number; readonly status: string };
        readonly users: readonly Record<string, unknown>[];
        readonly appliedSteps: number;
    };
    readonly cdb: {
        readonly schema: { readonly activeVersion: number; readonly activeEpoch: number; readonly status: string };
        readonly rows: readonly Record<string, unknown>[];
        readonly opLogRows: number;
        readonly appliedSteps: number;
    };
}

type Release = "v1" | "v2" | "v3" | "fresh" | "fresh3" | "legacy";
type PhaseAction = Readonly<Record<string, unknown>> & { readonly name: string; readonly type: string };

let scratch = "";
let phaseOrdinal = 0;
const scriptPaths = new Map<Release, string>();
const phasePids = new Set<number>();

async function buildWorker(release: Release): Promise<string> {
    const bundle = path.join(scratch, `migration-${release}.bundle.mjs`);
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
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exitCode !== 0) throw new Error(`migration fixture bundle failed: ${stderr}`);
    let source = await readFile(bundle, "utf8");
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
    await writeFile(bundle, source);
    return bundle;
}

function isMissingProcess(error: unknown): boolean {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
    return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
}

function signalProcessGroup(child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): boolean {
    if (process.platform === "win32") {
        child.kill(signal);
        return true;
    }
    try {
        process.kill(-child.pid, signal);
        return true;
    } catch (error) {
        if (isMissingProcess(error)) return false;
        throw error;
    }
}

function processGroupExists(pid: number): boolean {
    if (process.platform === "win32") return false;
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if (isMissingProcess(error)) return false;
        if (isPermissionDenied(error)) return true;
        throw error;
    }
}

async function waitForProcessGroupExit(pid: number, waitMs: number): Promise<boolean> {
    const deadline = performance.now() + waitMs;
    while (processGroupExists(pid) && performance.now() < deadline) await Bun.sleep(10);
    return !processGroupExists(pid);
}

async function terminateRemainingProcessGroup(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (process.platform === "win32") {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        return;
    }
    if (!processGroupExists(child.pid)) return;
    signalProcessGroup(child, "SIGTERM");
    if (await waitForProcessGroupExit(child.pid, 2_000)) return;
    signalProcessGroup(child, "SIGKILL");
    if (!(await waitForProcessGroupExit(child.pid, 2_000))) {
        throw new Error(`migration phase process group ${child.pid} survived SIGKILL`);
    }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
    await writeJsonAtomically(file, value);
    await chmod(file, 0o600);
}

async function runPhase(
    release: Release,
    persistencePath: string,
    label: string,
    actions: readonly PhaseAction[]
): Promise<Record<string, unknown>> {
    const scriptPath = scriptPaths.get(release);
    if (!scriptPath) throw new Error(`migration ${release} bundle is unavailable`);
    const ordinal = ++phaseOrdinal;
    const controlPath = path.join(scratch, `phase-${ordinal}-control.json`);
    const resultPath = path.join(scratch, `phase-${ordinal}-result.json`);
    await writePrivateJson(controlPath, {
        schema: CONTROL_SCHEMA,
        release,
        scriptPath,
        persistencePath,
        resultPath,
        actions,
    });
    const child = Bun.spawn([process.execPath, PHASE_ENTRY, "--control", controlPath], {
        cwd: HERE,
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ readonly timedOut: true }>(resolvePromise => {
        timeout = setTimeout(() => resolvePromise({ timedOut: true }), PHASE_TIMEOUT_MS);
    });
    const completed = await Promise.race([child.exited.then(exitCode => ({ exitCode })), deadline]);
    if (timeout !== undefined) clearTimeout(timeout);
    if ("timedOut" in completed) {
        signalProcessGroup(child, "SIGTERM");
        await terminateRemainingProcessGroup(child);
        throw new Error(`migration ${label} phase exceeded ${PHASE_TIMEOUT_MS}ms`);
    }
    await terminateRemainingProcessGroup(child);
    const [out, err] = await Promise.all([stdout, stderr]);
    if (completed.exitCode !== 0) {
        throw new Error(`migration ${label} phase exited ${completed.exitCode}\n${out}${err}`);
    }
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (
        result?.schema !== RESULT_SCHEMA ||
        result.release !== release ||
        !Number.isSafeInteger(result.producerPid) ||
        result.producerPid < 1 ||
        result.values === null ||
        typeof result.values !== "object" ||
        Array.isArray(result.values)
    ) {
        throw new Error(`migration ${label} phase returned invalid evidence`);
    }
    if (phasePids.has(result.producerPid)) throw new Error(`migration ${label} reused a prior phase process`);
    phasePids.add(result.producerPid);
    console.info(
        JSON.stringify({
            type: "chardb-migration-process-phase",
            version: 1,
            label,
            release,
            exitCode: completed.exitCode,
            processGroupExited: !processGroupExists(child.pid),
        })
    );
    return result.values as Record<string, unknown>;
}

function value<T>(phase: Record<string, unknown>, name: string): T {
    if (!(name in phase)) throw new Error(`migration phase result lacks ${name}`);
    return phase[name] as T;
}

async function persistence(name: string): Promise<string> {
    const directory = path.join(scratch, name);
    await mkdir(directory);
    return directory;
}

beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "chardb-migration-workerd-"));
    const releases: readonly Release[] = ["v1", "v2", "v3", "fresh", "fresh3", "legacy"];
    const bundles = await Promise.all(releases.map(buildWorker));
    for (let index = 0; index < releases.length; index++)
        scriptPaths.set(releases[index] as Release, bundles[index] as string);
});

afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
});

test("CLI upgrades persisted Catalog and Cdb state and fences stale epochs", async () => {
    const upgradePersistence = await persistence("upgrade");
    const seededPhase = await runPhase("v1", upgradePersistence, "v1 seed", [
        { name: "seeded", type: "call", pathname: "/fixture/seed", body: {} },
        { name: "registeredLive", type: "call", pathname: "/fixture/register-live", body: {} },
        { name: "before", type: "call", pathname: "/fixture/state" },
    ]);
    const seeded = value<{
        readonly route: { readonly domainSchemaEpoch: number };
        readonly result: { readonly ok: boolean; readonly ran?: boolean };
    }>(seededPhase, "seeded");
    expect(seeded.route.domainSchemaEpoch).toBe(1);
    expect(seeded.result).toMatchObject({ ok: true, ran: true });
    const registeredLive = value<{ readonly result: { readonly ok: boolean; readonly changeSeq: number } }>(
        seededPhase,
        "registeredLive"
    ).result;
    expect(registeredLive).toMatchObject({ ok: true });
    const activationChangeSeq = registeredLive.changeSeq + 1;
    const before = value<FixtureState>(seededPhase, "before");
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

    const upgradedPhase = await runPhase("v2", upgradePersistence, "v2 upgrade", [
        {
            name: "staleBeforeMigration",
            type: "call",
            pathname: "/fixture/mutate",
            body: {
                mutId: "blocked-before-migration",
                recoveryGeneration: 0,
                domainSchemaEpoch: 1,
                id: "blocked-before-migration",
                value: "blocked",
                note: null,
            },
        },
        { name: "migration", type: "migrate", migrationId: "workerd-v2", targetVersion: 1 },
        { name: "waitForFirstInvalidation", type: "wait", ms: 100 },
        { name: "liveAfterActivation", type: "call", pathname: "/fixture/live-state" },
        { name: "upgraded", type: "call", pathname: "/fixture/state" },
    ]);
    const staleBeforeMigration = value<{
        readonly result: { readonly ok: boolean; readonly error?: { readonly code: string } };
    }>(upgradedPhase, "staleBeforeMigration");
    expect(staleBeforeMigration.result).toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH" } });
    const migration = value<{ readonly out: string; readonly err: string }>(upgradedPhase, "migration");
    expect(migration.err).toBe("");
    expect(migration.out).toContain("activated shard ShardDO_0");
    expect(migration.out).toContain("applied Catalog schema version 1");
    expect(migration.out).toContain("schema version 1 active at epoch 2");
    expect(
        value<{
            readonly cdb: {
                readonly activeRegistrations: number;
                readonly outbox: readonly {
                    readonly registration_id: string;
                    readonly change_seq: number;
                    readonly attempts: number;
                    readonly last_error: string;
                }[];
            };
            readonly gateway: { readonly attempts: number; readonly acceptedChangeSeq: number };
        }>(upgradedPhase, "liveAfterActivation")
    ).toMatchObject({
        cdb: {
            activeRegistrations: 1,
            outbox: [
                {
                    registration_id: "migration-idle-registration",
                    change_seq: activationChangeSeq,
                    attempts: 1,
                    last_error: expect.stringContaining("dropped the first invalidation response"),
                },
            ],
        },
        gateway: { attempts: 1, acceptedChangeSeq: activationChangeSeq },
    });
    const upgraded = value<FixtureState>(upgradedPhase, "upgraded");
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
    const reconstruction = await runPhase("v2", upgradePersistence, "v2 reconstruction", [
        { name: "waitForRetry", type: "wait", ms: 1_200 },
        { name: "live", type: "call", pathname: "/fixture/live-state" },
        { name: "state", type: "call", pathname: "/fixture/state" },
        { name: "route", type: "call", pathname: "/fixture/route" },
    ]);
    expect(
        value<{
            readonly cdb: { readonly activeRegistrations: number; readonly outbox: readonly unknown[] };
            readonly gateway: { readonly attempts: number; readonly acceptedChangeSeq: number };
        }>(reconstruction, "live")
    ).toEqual({
        cdb: { activeRegistrations: 1, outbox: [] },
        gateway: { attempts: 2, acceptedChangeSeq: activationChangeSeq },
    });
    expect(value<FixtureState>(reconstruction, "state")).toEqual(upgraded);
    expect(value<{ readonly domainSchemaEpoch: number }>(reconstruction, "route").domainSchemaEpoch).toBe(2);

    const postUpgrade = await runPhase("v2", upgradePersistence, "v2 post-upgrade writes", [
        {
            name: "wrongEpoch1",
            type: "call",
            pathname: "/fixture/mutate",
            body: {
                mutId: "wrong-epoch-1",
                recoveryGeneration: 0,
                domainSchemaEpoch: 1,
                id: "wrong-epoch-1",
                value: "blocked",
                note: null,
            },
        },
        {
            name: "wrongEpoch3",
            type: "call",
            pathname: "/fixture/mutate",
            body: {
                mutId: "wrong-epoch-3",
                recoveryGeneration: 0,
                domainSchemaEpoch: 3,
                id: "wrong-epoch-3",
                value: "blocked",
                note: null,
            },
        },
        {
            name: "fresh",
            type: "call",
            pathname: "/fixture/mutate",
            body: {
                mutId: "fresh-after-migration",
                recoveryGeneration: 0,
                domainSchemaEpoch: 2,
                id: "row-after-upgrade",
                value: "after",
                note: "fresh",
            },
        },
        { name: "afterFresh", type: "call", pathname: "/fixture/state" },
        {
            name: "replay",
            type: "call",
            pathname: "/fixture/mutate",
            body: {
                mutId: "seed-mutation",
                recoveryGeneration: 0,
                domainSchemaEpoch: 2,
                id: "row-before-upgrade",
                value: "before",
            },
        },
        { name: "afterReplay", type: "call", pathname: "/fixture/state" },
    ]);
    for (const domainSchemaEpoch of [1, 3]) {
        const rejected = value<{
            readonly result: { readonly ok: boolean; readonly error?: { readonly code: string } };
        }>(postUpgrade, `wrongEpoch${domainSchemaEpoch}`);
        expect(rejected.result).toMatchObject({ ok: false, error: { code: "CDB_STALE_EPOCH" } });
    }
    const fresh = value<{ readonly result: { readonly ok: boolean; readonly ran?: boolean } }>(postUpgrade, "fresh");
    expect(fresh.result).toMatchObject({ ok: true, ran: true });
    const afterFresh = value<FixtureState>(postUpgrade, "afterFresh");
    expect(afterFresh.cdb.rows).toEqual([
        { id: "row-after-upgrade", value: "after", note: "fresh" },
        { id: "row-before-upgrade", value: "before", note: "migrated" },
    ]);
    expect(afterFresh.cdb.opLogRows).toBe(2);
    const replay = value<{ readonly result: { readonly ok: boolean; readonly ran?: boolean } }>(postUpgrade, "replay");
    expect(replay.result).toMatchObject({ ok: true, ran: false });
    expect(value<FixtureState>(postUpgrade, "afterReplay").cdb.opLogRows).toBe(2);

    const afterCatalogStep = await runPhase("v3", upgradePersistence, "v3 interrupt after Catalog step", [
        {
            name: "begun",
            type: "migration-call",
            pathname: "/begin",
            body: { migrationId: "workerd-v3", targetVersion: 2 },
        },
        {
            name: "migratedShard",
            type: "migration-call",
            pathname: "/shard",
            body: { migrationId: "workerd-v3", shardId: "ShardDO_0" },
        },
        {
            name: "catalogStep",
            type: "migration-call",
            pathname: "/catalog",
            body: { migrationId: "workerd-v3", version: 2 },
        },
        { name: "evictCatalog", type: "evict", className: "Catalog", nameFromId: "global" },
        { name: "evictCdb", type: "evict", className: "Cdb", nameFromId: "ShardDO_0" },
        { name: "state", type: "call", pathname: "/fixture/state" },
    ]);
    expect(value<{ readonly state: { readonly status: string } }>(afterCatalogStep, "begun").state.status).toBe(
        "migrating"
    );
    expect(
        value<{
            readonly shard: {
                readonly shardId: string;
                readonly status: string;
                readonly lastError: string | null;
                readonly updatedAt: number;
            };
        }>(afterCatalogStep, "migratedShard").shard
    ).toEqual({ shardId: "ShardDO_0", status: "active", lastError: null, updatedAt: expect.any(Number) });
    expect(value<{ readonly state: { readonly status: string } }>(afterCatalogStep, "catalogStep").state.status).toBe(
        "migrating"
    );
    const beforeV3Complete = value<FixtureState>(afterCatalogStep, "state");
    expect(beforeV3Complete.catalog).toMatchObject({
        schema: { activeVersion: 1, activeEpoch: 2, status: "migrating", migrationId: "workerd-v3" },
        users: [{ id: "migration-user", email: "migration@example.com", nickname: null, timezone: null }],
        appliedSteps: 2,
    });
    expect(beforeV3Complete.cdb).toMatchObject({
        schema: { activeVersion: 2, activeEpoch: 3, status: "active", lastMigrationId: "workerd-v3" },
        rows: [
            { id: "row-after-upgrade", value: "after", note: "fresh", label: "migrated-v3" },
            { id: "row-before-upgrade", value: "before", note: "migrated", label: "migrated-v3" },
        ],
        appliedSteps: 2,
    });

    const resumedV3 = await runPhase("v3", upgradePersistence, "v3 resume after Catalog step", [
        { name: "migration", type: "migrate", migrationId: "workerd-v3", targetVersion: 2 },
        { name: "duplicate", type: "migrate", migrationId: "workerd-v3", targetVersion: 2 },
        { name: "state", type: "call", pathname: "/fixture/state" },
    ]);
    const resumedV3Migration = value<{ readonly out: string; readonly err: string }>(resumedV3, "migration");
    expect(resumedV3Migration.err).toBe("");
    expect(resumedV3Migration.out).toContain("migrating 0 pending shard(s) to version 2");
    expect(resumedV3Migration.out).toContain("applied Catalog schema version 2");
    expect(resumedV3Migration.out).toContain("schema version 2 active at epoch 3");
    expect(value<{ readonly out: string; readonly err: string }>(resumedV3, "duplicate")).toEqual({
        out: "schema version 2 is already active at epoch 3\n",
        err: "",
    });
    expect(value<FixtureState>(resumedV3, "state").catalog.schema).toMatchObject({
        activeVersion: 2,
        activeEpoch: 3,
        status: "active",
        lastMigrationId: "workerd-v3",
    });

    const freshPersistence = await persistence("fresh");
    const freshPhase = await runPhase("fresh", freshPersistence, "fresh migration", [
        { name: "migration", type: "migrate", migrationId: "fresh-workerd-v2", targetVersion: 2 },
        { name: "seed", type: "call", pathname: "/fixture/seed", body: {} },
        { name: "state", type: "call", pathname: "/fixture/state" },
    ]);
    const freshMigration = value<{ readonly out: string; readonly err: string }>(freshPhase, "migration");
    expect(freshMigration.err).toBe("");
    expect(freshMigration.out).toContain("applied Catalog schema version 1");
    expect(freshMigration.out).toContain("applied Catalog schema version 2");
    const freshSeed = value<{
        readonly route: { readonly domainSchemaEpoch: number };
        readonly result: { readonly ok: boolean; readonly ran?: boolean };
    }>(freshPhase, "seed");
    expect(freshSeed.route.domainSchemaEpoch).toBe(2);
    expect(freshSeed.result).toMatchObject({ ok: true, ran: true });
    const freshState = value<FixtureState>(freshPhase, "state");
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

    const baselinePersistence = await persistence("baseline");
    const legacyPhase = await runPhase("legacy", baselinePersistence, "legacy seed", [
        { name: "seed", type: "call", pathname: "/fixture/seed", body: {} },
        { name: "state", type: "call", pathname: "/fixture/state" },
    ]);
    const legacySeed = value<{
        readonly route: { readonly domainSchemaEpoch: number };
        readonly result: { readonly ok: boolean; readonly ran?: boolean };
    }>(legacyPhase, "seed");
    expect(legacySeed.route.domainSchemaEpoch).toBe(1);
    expect(legacySeed.result).toMatchObject({ ok: true, ran: true });
    const legacyState = value<FixtureState>(legacyPhase, "state");
    expect(legacyState.catalog.schema).toMatchObject({ activeVersion: 0, activeEpoch: 1, status: "active" });
    expect(legacyState.cdb).toMatchObject({
        schema: { activeVersion: 0, activeEpoch: 1, status: "active" },
        rows: [{ id: "row-before-upgrade", value: "before", note: null }],
        opLogRows: 1,
    });

    const baselinePhase = await runPhase("fresh", baselinePersistence, "baseline migration", [
        { name: "migration", type: "migrate", migrationId: "baseline-existing-v2", targetVersion: 2, baseline: true },
        { name: "adopted", type: "call", pathname: "/fixture/state" },
        { name: "evictCatalog", type: "evict", className: "Catalog", nameFromId: "global" },
        { name: "evictCdb", type: "evict", className: "Cdb", nameFromId: "ShardDO_0" },
        { name: "reconstructed", type: "call", pathname: "/fixture/state" },
    ]);
    const baseline = value<{ readonly out: string; readonly err: string }>(baselinePhase, "migration");
    expect(baseline.err).toBe("");
    expect(baseline.out).toContain("schema version 2 active at epoch 2");
    const adopted = value<FixtureState>(baselinePhase, "adopted");
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
    expect(value<FixtureState>(baselinePhase, "reconstructed")).toEqual(adopted);

    const interruptedPersistence = await persistence("interrupted");
    await runPhase("v1", interruptedPersistence, "interrupted migration v1 seed", [
        { name: "seed", type: "call", pathname: "/fixture/seed", body: {} },
    ]);
    const interruptedPhase = await runPhase("v2", interruptedPersistence, "interrupted migration v2 begin", [
        {
            name: "begun",
            type: "migration-call",
            pathname: "/begin",
            body: { migrationId: "interrupted-v2", targetVersion: 1 },
        },
        {
            name: "migratedShard",
            type: "migration-call",
            pathname: "/shard",
            body: { migrationId: "interrupted-v2", shardId: "ShardDO_0" },
        },
        { name: "state", type: "call", pathname: "/fixture/state" },
    ]);
    const begun = value<{ readonly state: FixtureState["catalog"]["schema"] }>(interruptedPhase, "begun");
    expect(begun.state).toMatchObject({
        activeVersion: 0,
        activeEpoch: 1,
        status: "migrating",
        migrationId: "interrupted-v2",
        targetVersion: 1,
    });
    const migratedShard = value<{ readonly shard: { readonly shardId: string; readonly status: string } }>(
        interruptedPhase,
        "migratedShard"
    );
    expect(migratedShard.shard).toMatchObject({ shardId: "ShardDO_0", status: "active" });
    const interrupted = value<FixtureState>(interruptedPhase, "state");
    expect(interrupted.catalog.schema).toMatchObject({ activeVersion: 0, status: "migrating" });
    expect(interrupted.cdb.schema).toMatchObject({ activeVersion: 1, activeEpoch: 2, status: "active" });

    const resumedPhase = await runPhase("v2", interruptedPersistence, "interrupted migration resume", [
        { name: "migration", type: "migrate", migrationId: "interrupted-v2", targetVersion: 1 },
        { name: "state", type: "call", pathname: "/fixture/state" },
    ]);
    const resumed = value<{ readonly out: string; readonly err: string }>(resumedPhase, "migration");
    expect(resumed.err).toBe("");
    expect(resumed.out).toContain("migrating 0 pending shard(s) to version 1");
    expect(resumed.out).toContain("schema version 1 active at epoch 2");
    const afterResume = value<FixtureState>(resumedPhase, "state");
    expect(afterResume.catalog.schema).toMatchObject({ activeVersion: 1, activeEpoch: 2, status: "active" });
    expect(afterResume.cdb.rows).toEqual([{ id: "row-before-upgrade", value: "before", note: "migrated" }]);

    const obsoletePhase = await runPhase("v1", interruptedPersistence, "obsolete v1 rollback attempt", [
        {
            name: "obsolete",
            type: "expect-closed",
            pathname: "/fixture/mutate",
            body: {
                mutId: "obsolete-v1-write",
                recoveryGeneration: 0,
                domainSchemaEpoch: 1,
                id: "obsolete-v1-write",
                value: "must-not-commit",
            },
        },
    ]);
    expect(value<{ readonly closed: boolean }>(obsoletePhase, "obsolete").closed).toBe(true);
    const finalPhase = await runPhase("v2", interruptedPersistence, "v2 after obsolete rollback attempt", [
        { name: "state", type: "call", pathname: "/fixture/state" },
    ]);
    expect(value<FixtureState>(finalPhase, "state")).toEqual(afterResume);
}, 120_000);

test("resumes a partial multi-shard v0 to v3 journal and rejects out-of-order Catalog completion", async () => {
    const persistencePath = await persistence("fresh-three-partial");
    const interrupted = await runPhase("fresh3", persistencePath, "fresh v3 partial shard", [
        { name: "twoShards", type: "call", pathname: "/fixture/two-shards", body: {} },
        { name: "evictCatalogBeforeBegin", type: "evict", className: "Catalog", nameFromId: "global" },
        {
            name: "begun",
            type: "migration-call",
            pathname: "/begin",
            body: { migrationId: "fresh-three-partial", targetVersion: 3 },
        },
        {
            name: "firstShard",
            type: "migration-call",
            pathname: "/shard",
            body: { migrationId: "fresh-three-partial", shardId: "ShardDO_0" },
        },
        {
            name: "outOfOrderCatalog",
            type: "expect-migration-error",
            pathname: "/catalog",
            body: { migrationId: "fresh-three-partial", version: 2 },
        },
        {
            name: "incompleteCompletion",
            type: "expect-migration-error",
            pathname: "/complete",
            body: { migrationId: "fresh-three-partial" },
        },
        { name: "evictCatalog", type: "evict", className: "Catalog", nameFromId: "global" },
        { name: "evictFirstShard", type: "evict", className: "Cdb", nameFromId: "ShardDO_0" },
        {
            name: "inventory",
            type: "migration-call",
            pathname: "/shards?migrationId=fresh-three-partial",
        },
    ]);
    expect(value<{ readonly shardIds: readonly string[] }>(interrupted, "twoShards").shardIds).toEqual([
        "ShardDO_0",
        "ShardDO_1",
    ]);
    const outOfOrderCatalog = value<{
        readonly status: number;
        readonly body: Readonly<Record<string, unknown>>;
    }>(interrupted, "outOfOrderCatalog");
    expect(outOfOrderCatalog).toEqual({
        status: 400,
        body: {
            ok: false,
            error: "Catalog migration steps must apply in order",
            code: "CDB_INVALID_ARGS",
            retryable: false,
        },
    });
    const incompleteCompletion = value<{
        readonly status: number;
        readonly body: Readonly<Record<string, unknown>>;
    }>(interrupted, "incompleteCompletion");
    expect(incompleteCompletion).toEqual({
        status: 409,
        body: {
            ok: false,
            error: "schema migration shards are incomplete",
            code: "CDB_STALE_EPOCH",
            retryable: true,
        },
    });
    for (const rejected of [outOfOrderCatalog, incompleteCompletion]) {
        const serialized = JSON.stringify(rejected.body);
        expect(serialized).not.toContain("CdbError:");
        expect(serialized).not.toContain(" at ");
        expect(serialized).not.toContain("correlationId");
    }
    expect(
        value<{
            readonly shards: readonly { readonly shardId: string; readonly status: string; readonly lastError: null }[];
        }>(interrupted, "inventory").shards
    ).toMatchObject([
        { shardId: "ShardDO_0", status: "active", lastError: null },
        { shardId: "ShardDO_1", status: "pending", lastError: null },
    ]);

    const resumed = await runPhase("fresh3", persistencePath, "fresh v3 partial resume", [
        { name: "migration", type: "migrate", migrationId: "fresh-three-partial", targetVersion: 3 },
        { name: "duplicate", type: "migrate", migrationId: "fresh-three-partial", targetVersion: 3 },
        { name: "seed", type: "call", pathname: "/fixture/seed", body: {} },
        { name: "state", type: "call", pathname: "/fixture/state" },
    ]);
    const migration = value<{ readonly out: string; readonly err: string }>(resumed, "migration");
    expect(migration.err).toBe("");
    expect(migration.out).toContain("migrating 1 pending shard(s) to version 3");
    expect(migration.out).toContain("activated shard ShardDO_1");
    for (const version of [1, 2, 3]) {
        expect(migration.out).toContain(`applied Catalog schema version ${version}`);
    }
    expect(migration.out).toContain("schema version 3 active at epoch 2");
    expect(value<{ readonly out: string; readonly err: string }>(resumed, "duplicate")).toEqual({
        out: "schema version 3 is already active at epoch 2\n",
        err: "",
    });
    expect(value<{ readonly route: { readonly domainSchemaEpoch: number } }>(resumed, "seed").route).toMatchObject({
        recoveryGeneration: 0,
        domainSchemaEpoch: 2,
    });
    expect(value<FixtureState>(resumed, "state")).toMatchObject({
        catalog: {
            schema: { activeVersion: 3, activeEpoch: 2, status: "active" },
            users: [{ id: "migration-user", email: "migration@example.com", nickname: null, timezone: null }],
            appliedSteps: 3,
        },
        cdb: {
            schema: { activeVersion: 3, activeEpoch: 2, status: "active" },
            rows: [{ id: "row-before-upgrade", value: "before", note: null, label: null }],
            opLogRows: 1,
            appliedSteps: 3,
        },
    });
}, 90_000);
