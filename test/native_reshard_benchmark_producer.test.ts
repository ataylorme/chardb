import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reserveLoopbackPort } from "../scripts/local-file-proof-runtime.mjs";
import { assertReshardBenchmarkSample } from "../scripts/reshard-benchmark-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCER = path.join(ROOT, "scripts", "produce-native-reshard-benchmark.mjs");
const FIXTURE = path.join(ROOT, "test", "fixtures", "reshard-benchmark");
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");

test("real Wrangler producer survives a bulk crash and emits strict native evidence", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "chardb-native-reshard-test-"));
    try {
        const bundleDir = path.join(temporary, "bundle");
        const bundle = Bun.spawn(
            [WRANGLER, "deploy", "--dry-run", "--outdir", bundleDir, "--config", "wrangler.toml"],
            {
                cwd: FIXTURE,
                env: { ...process.env, WRANGLER_LOG_PATH: path.join(temporary, "wrangler.log") },
                stdout: "pipe",
                stderr: "pipe",
            }
        );
        const [bundleExit, bundleStdout, bundleStderr] = await Promise.all([
            bundle.exited,
            new Response(bundle.stdout).text(),
            new Response(bundle.stderr).text(),
        ]);
        expect(bundleExit, `${bundleStderr}\n${bundleStdout}`).toBe(0);
        const candidate = path.join(bundleDir, "worker.js");
        const candidateBytes = await readFile(candidate);
        const candidateSha256 = createHash("sha256").update(candidateBytes).digest("hex");
        const alteredCandidate = path.join(temporary, "altered-worker.js");
        await writeFile(alteredCandidate, Buffer.concat([candidateBytes, Buffer.from("\n// altered\n")]));
        const rejected = Bun.spawn(
            [
                process.execPath,
                PRODUCER,
                "--profile",
                "standard-v1",
                "--sequence",
                "-1",
                "--excluded",
                "true",
                "--candidate",
                alteredCandidate,
                "--candidate-sha256",
                candidateSha256,
            ],
            { cwd: ROOT, stdout: "pipe", stderr: "pipe" }
        );
        const [rejectedExit, rejectedStdout, rejectedStderr] = await Promise.all([
            rejected.exited,
            new Response(rejected.stdout).text(),
            new Response(rejected.stderr).text(),
        ]);
        expect(rejectedExit, rejectedStdout).toBe(2);
        expect(rejectedStderr).toContain("candidate worker digest does not match");
        const port = await reserveLoopbackPort();
        const child = Bun.spawn(
            [
                process.execPath,
                PRODUCER,
                "--profile",
                "standard-v1",
                "--sequence",
                "-1",
                "--excluded",
                "true",
                "--candidate",
                candidate,
                "--candidate-sha256",
                candidateSha256,
            ],
            {
                cwd: ROOT,
                env: { ...process.env, CDB_RESHARD_BENCHMARK_PORT: String(port) },
                stdout: "pipe",
                stderr: "pipe",
            }
        );
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        expect(exitCode, stderr).toBe(0);
        const sample = assertReshardBenchmarkSample(JSON.parse(stdout), {
            sequence: -1,
            candidateSha256,
        });
        expect(sample.target).toMatchObject({
            kind: "local",
            transport: "wrangler-miniflare-http",
            storage: { durableObjects: true, sqlite: true },
        });
        expect(sample.movement).toMatchObject({
            bulk: { rows: 5_120 },
            capture: { transactionGroups: 256, entries: 256 },
            replay: { transactionGroups: 256, entries: 256 },
            drain: { rows: 5_120 },
        });
        expect(sample.correctness).toMatchObject({
            bulkCursorResumed: true,
            sourceDrained: true,
            staleRoute: { attempts: 2, committedOnce: true },
            live: { reason: "shardsChanged", mustRefetch: true, snapshotConverged: true },
        });
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}, 180_000);
