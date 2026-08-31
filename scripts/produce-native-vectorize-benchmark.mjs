import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { disposeMiniflareBounded } from "./miniflare-lifecycle.mjs";
import {
    VECTORIZE_LOCAL_FAKE_BENCHMARK_SCHEMA,
    VECTORIZE_READY_SEARCH_WORKLOAD,
    assertVectorizeLocalFakeBenchmarkReport,
} from "./vectorize-local-fake-benchmark-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "test", "workerd", "vector-delivery.entry.ts");
const COMPATIBILITY_DATE = "2026-08-06";
const ORGANIZATION_ID = "org-native-vector-benchmark";
const ISOLATED_ORGANIZATION_ID = "org-native-vector-benchmark-isolated";
const DOCUMENT_ID = "ready-search-document";
const VALUES = Object.freeze([0, 1, ...Array.from({ length: 30 }, () => 0)]);

function check(condition, message) {
    if (!condition) throw new Error(message);
}

async function packageVersion(file) {
    const value = JSON.parse(await readFile(file, "utf8"));
    return typeof value.version === "string" && value.version.length > 0 ? value.version : "unknown";
}

async function buildWorker(directory) {
    const bundle = path.join(directory, "vector-delivery.worker.mjs");
    const child = Bun.spawn(
        [
            process.execPath,
            "build",
            ENTRY,
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:workers",
            "--outfile",
            bundle,
        ],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" }
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`vector benchmark bundle failed: ${stderr}`);
    const bytes = await readFile(bundle);
    return {
        source: bytes.toString("utf8"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
    };
}

async function call(instance, pathname, input = {}) {
    const response = await instance.dispatchFetch(new URL(pathname, "http://vector-benchmark.invalid"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });
    const text = await response.text();
    let value;
    try {
        value = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`${pathname} returned invalid JSON`);
    }
    if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${JSON.stringify(value)}`);
    return value;
}

async function driveReady(instance, vectorId) {
    for (let turn = 0; turn < 16; turn++) {
        const state = await call(instance, "/state");
        const head = state.heads.find(candidate => candidate.vector_id === vectorId);
        if (head?.state === "ready" && head.version === head.delivered_version) return state;
        await call(instance, "/vector-process", { limit: 100 });
        await call(instance, "/force-due");
        await call(instance, "/alarm");
    }
    throw new Error("vector benchmark setup did not reach ready state in 16 turns");
}

function assertExactMatch(result, label) {
    check(Array.isArray(result), `${label} did not return an array`);
    check(result.length === 1, `${label} did not return exactly one match`);
    check(
        result[0] !== null &&
            typeof result[0] === "object" &&
            !Array.isArray(result[0]) &&
            JSON.stringify(Object.keys(result[0]).sort()) === JSON.stringify(["rowPk", "score"]),
        `${label} returned non-public fields`
    );
    check(result[0]?.rowPk === DOCUMENT_ID, `${label} returned the wrong row`);
    check(
        typeof result[0]?.score === "number" && Number.isFinite(result[0].score),
        `${label} returned an invalid score`
    );
}

export async function produceNativeVectorizeBenchmark() {
    const temporaryPath = await mkdtemp(path.join(tmpdir(), "chardb-native-vector-benchmark-"));
    let instance;
    let report;
    let disposalStatus = "absent";
    try {
        const bundle = await buildWorker(temporaryPath);
        instance = new Miniflare({
            name: "vector-delivery-benchmark",
            modules: true,
            script: bundle.source,
            durableObjects: {
                CDB: { className: "VectorProofCdb", useSQLite: true },
                VECTOR_INDEX: { className: "VectorIndexProbe", useSQLite: true },
            },
            durableObjectsPersist: path.join(temporaryPath, "durable-objects"),
            compatibilityDate: COMPATIBILITY_DATE,
            compatibilityFlags: ["nodejs_compat"],
        });
        await instance.ready;

        const refs = await call(instance, "/refs");
        const mutation = await call(instance, "/mutate", {
            organizationId: ORGANIZATION_ID,
            mutId: "native-vector-benchmark-seed",
            ref: refs.benchmarkPut,
            args: {
                organizationId: ORGANIZATION_ID,
                id: DOCUMENT_ID,
                body: "ready vector benchmark",
                values: VALUES,
            },
        });
        check(mutation?.ok === true && mutation?.ran === true, "vector benchmark seed mutation did not commit");
        const vectorId = mutation?.result?.vectorId;
        check(typeof vectorId === "string" && vectorId.length > 0, "vector benchmark seed returned no vector id");
        const ready = await driveReady(instance, vectorId);
        const head = ready.heads.find(candidateHead => candidateHead.vector_id === vectorId);
        check(head?.state === "ready" && head.version === head.delivered_version, "vector was not ready before timing");

        const search = organizationId =>
            call(instance, "/benchmark-search", { organizationId, values: VALUES, limit: 1 });
        assertExactMatch(await search(ORGANIZATION_ID), "preflight owning search");
        const isolated = await search(ISOLATED_ORGANIZATION_ID);
        check(Array.isArray(isolated) && isolated.length === 0, "preflight isolated search returned a match");

        const rawSamples = [];
        for (let sequence = -1; sequence < 5; sequence++) {
            const started = performance.now();
            const result = await search(ORGANIZATION_ID);
            const elapsedMs = performance.now() - started;
            assertExactMatch(result, `search sample ${sequence}`);
            rawSamples.push({ sequence, excluded: sequence === -1, elapsedMs });
        }

        const samples = rawSamples.slice(1);
        const nodeModules = path.join(ROOT, "node_modules");
        report = assertVectorizeLocalFakeBenchmarkReport({
            schema: VECTORIZE_LOCAL_FAKE_BENCHMARK_SCHEMA,
            artifact: { kind: "workerd-worker-bundle", sha256: bundle.sha256, bytes: bundle.bytes },
            environment: {
                bun: Bun.version,
                miniflare: await packageVersion(path.join(nodeModules, "miniflare", "package.json")),
                workerd: await packageVersion(path.join(nodeModules, "workerd", "package.json")),
                compatibilityDate: COMPATIBILITY_DATE,
                durableObjectStorage: "persistent-sqlite",
            },
            workload: { ...VECTORIZE_READY_SEARCH_WORKLOAD },
            sampling: { warmup: rawSamples[0], samples },
            track: {
                label: "local-workerd-fake-vectorize",
                runtime: "miniflare/workerd",
                backend: "persistent-fake-index-do",
                realVectorize: false,
                samplesMs: samples.map(sample => sample.elapsedMs),
            },
            correctness: {
                readyBeforeTiming: true,
                owningOrganizationExactMatch: true,
                isolatedOrganizationEmpty: true,
                productionCandidateValidation: true,
                assertionsOutsideTiming: true,
            },
        });
    } finally {
        const disposed = await disposeMiniflareBounded(instance, {
            label: "native vector benchmark teardown",
            timeoutMs: 5_000,
        });
        disposalStatus = disposed.status;
        await rm(temporaryPath, { recursive: true, force: true });
    }
    if (disposalStatus !== "disposed" && disposalStatus !== "absent") {
        throw new Error(`native vector benchmark teardown failed: ${disposalStatus}`);
    }
    return report;
}

if (import.meta.main) {
    try {
        process.stdout.write(`${JSON.stringify(await produceNativeVectorizeBenchmark())}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    }
}
