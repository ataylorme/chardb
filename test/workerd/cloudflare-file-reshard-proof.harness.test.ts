import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { FILE_RESHARD_BENCHMARK_PROFILES } from "../../scripts/file-reshard-benchmark-report.mjs";
import {
    assertFileReshardDeploymentCapabilities,
    assertFileReshardDeploymentFault,
    assertFileReshardDeploymentSample,
} from "../../scripts/file-reshard-deployment-proof.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "cloudflare-file-reshard-proof");
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");
const RUN_ID = "local_file_reshard_proof";
const TOKEN = "local_admin_token_1234";
const RELEASE = "b".repeat(64);
const CONFIGURATION = "a".repeat(64);
const RUN_KEY = "local_file_reshard_proof_restart";

let temporaryPath = "";
let port = 0;
let inspectorPort = 0;
let origin = "";
let config = "";
let runtime: ReturnType<typeof Bun.spawn> | undefined;
let runtimeOutput = "";

async function availablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    if (!address || typeof address === "string") throw new Error("could not reserve a Wrangler test port");
    return address.port;
}

async function command(args: readonly string[]): Promise<void> {
    const child = Bun.spawn([...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`command failed with ${exitCode}\n${stdout}\n${stderr}`);
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        runtimeOutput = `${runtimeOutput}${decoder.decode(next.value, { stream: true })}`.slice(-200_000);
    }
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

async function start(): Promise<void> {
    runtimeOutput = "";
    runtime = Bun.spawn(
        [
            WRANGLER,
            "dev",
            "--config",
            config,
            "--local",
            "--ip",
            "127.0.0.1",
            "--port",
            String(port),
            "--inspector-port",
            String(inspectorPort),
            "--persist-to",
            path.join(temporaryPath, "state"),
            "--var",
            `CDB_ADMIN_TOKEN:${TOKEN}`,
            "--var",
            "CDB_PROOF_TARGET_KIND:local",
            "--var",
            "CDB_PROOF_RUNTIME:wrangler-miniflare-workerd",
            "--var",
            "CDB_PROOF_LOCAL_VERSION:local-dev",
            "--var",
            `CDB_PROOF_CONFIGURATION_SHA256:${CONFIGURATION}`,
            "--var",
            `CDB_RELEASE_SHA256:${RELEASE}`,
            "--var",
            `CDB_PROOF_RUN_ID:${RUN_ID}`,
            "--var",
            "CDB_PROOF_R2_BUCKET:chardb-file-reshard-proof-local",
            "--show-interactive-dev-session=false",
        ],
        {
            cwd: ROOT,
            env: {
                ...process.env,
                XDG_CONFIG_HOME: path.join(temporaryPath, "config"),
                WRANGLER_LOG_PATH: path.join(temporaryPath, "wrangler.log"),
            },
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
        }
    );
    if (runtime.stdout instanceof ReadableStream) void drain(runtime.stdout);
    if (runtime.stderr instanceof ReadableStream) void drain(runtime.stderr);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (runtime.exitCode !== null) throw new Error(`Wrangler exited before readiness\n${runtimeOutput}`);
        try {
            const response = await fetch(`${origin}/proof/file-reshard/capabilities`, {
                headers: { authorization: `Bearer ${TOKEN}`, "x-chardb-proof-run-id": RUN_ID },
            });
            if (response.ok) return;
        } catch {
            // Wrangler is still starting.
        }
        await Bun.sleep(100);
    }
    throw new Error(`Wrangler did not become ready\n${runtimeOutput}`);
}

async function stop(): Promise<void> {
    const child = runtime;
    runtime = undefined;
    if (!child) return;
    if (process.platform === "win32") {
        if (child.exitCode === null) child.kill("SIGTERM");
        await Promise.race([child.exited, Bun.sleep(2_000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        return;
    }
    if (!processGroupExists(child.pid)) return;
    signalProcessGroup(child, "SIGTERM");
    if (await waitForProcessGroupExit(child.pid, 2_000)) return;
    signalProcessGroup(child, "SIGKILL");
    if (!(await waitForProcessGroupExit(child.pid, 2_000))) {
        throw new Error(`Wrangler process group ${child.pid} survived SIGKILL`);
    }
}

function headers(inject = false): HeadersInit {
    return {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-chardb-proof-run-id": RUN_ID,
        ...(inject ? { "x-chardb-proof-inject": "commit-then-response-loss-once" } : {}),
    };
}

function requestBody(): Record<string, unknown> {
    return {
        runId: RUN_ID,
        runKey: RUN_KEY,
        sequence: 0,
        excluded: false,
        candidateSha256: RELEASE,
        profile: FILE_RESHARD_BENCHMARK_PROFILES.small,
        fault: { operation: "apply_snapshot", mode: "commit-then-response-loss-once" },
    };
}

beforeAll(async () => {
    temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-file-reshard-proof-"));
    const app = path.join(temporaryPath, "app");
    await cp(FIXTURE, app, { recursive: true });
    await mkdir(path.join(app, "node_modules", "@chardb"), { recursive: true });
    await symlink(ROOT, path.join(app, "node_modules", "@chardb", "core"), "dir");
    for (const dependency of ["better-auth", "drizzle-orm", "zod"]) {
        await symlink(path.join(ROOT, "node_modules", dependency), path.join(app, "node_modules", dependency), "dir");
    }
    config = path.join(app, "wrangler.toml");
    port = await availablePort();
    do inspectorPort = await availablePort();
    while (inspectorPort === port);
    origin = `http://127.0.0.1:${port}`;
    await command([process.execPath, "run", "build"]);
    await start();
}, 60_000);

afterAll(async () => {
    await stop();
    if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
}, 15_000);

describe("packaged Wrangler file reshard proof", () => {
    test("persists snapshot response loss and completes exact movement after restart", async () => {
        const denied = await fetch(`${origin}/proof/file-reshard/capabilities`);
        expect(denied.status).toBe(404);
        const capabilitiesResponse = await fetch(`${origin}/proof/file-reshard/capabilities`, {
            headers: headers(),
        });
        expect(capabilitiesResponse.status).toBe(200);
        const capabilities = assertFileReshardDeploymentCapabilities(await capabilitiesResponse.json(), {
            releaseSha256: RELEASE,
            runId: RUN_ID,
            kind: "local",
        });
        expect(capabilities.target.deploymentVersion).toBe("local-dev");

        const missingInjection = await fetch(`${origin}/proof/file-reshard/run`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(requestBody()),
        });
        expect(missingInjection.status).toBe(409);

        const first = await fetch(`${origin}/proof/file-reshard/run`, {
            method: "POST",
            headers: headers(true),
            body: JSON.stringify(requestBody()),
        });
        const firstBody = await first.json();
        if (first.status !== 503) throw new Error(`first proof request failed: ${JSON.stringify(firstBody)}`);
        assertFileReshardDeploymentFault(firstBody, { runKey: RUN_KEY, operation: "apply_snapshot" });

        await stop();
        await start();
        const retried = await fetch(`${origin}/proof/file-reshard/run`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(requestBody()),
        });
        const retriedBody = await retried.json();
        if (retried.status !== 200) {
            throw new Error(`restarted proof request failed with ${retried.status}: ${JSON.stringify(retriedBody)}`);
        }
        const sample = assertFileReshardDeploymentSample(retriedBody, {
            sequence: 0,
            runKey: RUN_KEY,
            profile: "small",
            kind: "local",
            candidateSha256: RELEASE,
        });
        expect(sample.movement).toMatchObject({
            r2: {
                objectsBefore: 16,
                objectsAfter: 16,
                operationTrace: { available: true, putsDuringMove: 0, deletesDuringMove: 0 },
            },
            vectors: {
                headsBefore: 16,
                headsAfter: 16,
                readyHeadsBefore: 16,
                readyHeadsAfter: 16,
                providerRecordsBefore: 16,
                providerRecordsAfter: 16,
                providerMutationTrace: {
                    available: true,
                    method: "durable-object-vector-probe",
                    upsertsDuringMove: 0,
                    deletesDuringMove: 0,
                },
                search: { rowPk: "row-0-0" },
            },
        });
        expect(sample.alarm).toMatchObject({ deletedObjects: 1, remainingObjects: 15 });

        await stop();
        await start();
        const replayed = await fetch(`${origin}/proof/file-reshard/run`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(requestBody()),
        });
        expect(replayed.status).toBe(200);
        expect(JSON.stringify(await replayed.json())).toBe(JSON.stringify(sample));

        const cleanupBody = JSON.stringify({ runId: RUN_ID, runKey: RUN_KEY });
        const deniedCleanup = await fetch(`${origin}/proof/file-reshard/cleanup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: cleanupBody,
        });
        expect(deniedCleanup.status).toBe(404);
        const cleanup = await fetch(`${origin}/proof/file-reshard/cleanup`, {
            method: "POST",
            headers: headers(),
            body: cleanupBody,
        });
        expect(cleanup.status).toBe(200);
        expect((await cleanup.json()) as unknown).toEqual({
            schema: "chardb.file-reshard-proof-cleanup.v1",
            runId: RUN_ID,
            runKey: RUN_KEY,
            deleted: 15,
            remaining: 0,
            done: true,
        });
        const repeatedCleanup = await fetch(`${origin}/proof/file-reshard/cleanup`, {
            method: "POST",
            headers: headers(),
            body: cleanupBody,
        });
        expect(repeatedCleanup.status).toBe(200);
        expect((await repeatedCleanup.json()) as unknown).toEqual({
            schema: "chardb.file-reshard-proof-cleanup.v1",
            runId: RUN_ID,
            runKey: RUN_KEY,
            deleted: 0,
            remaining: 0,
            done: true,
        });
    }, 60_000);
});
