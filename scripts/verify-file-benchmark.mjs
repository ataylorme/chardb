import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compareFileBenchmarkReports } from "./compare-file-benchmark.mjs";
import { assertFileBenchmarkReport } from "./file-benchmark-report.mjs";
import { validateFileBenchmarkEvidence } from "./run-file-benchmark.mjs";

export const FILE_BENCHMARK_VERIFICATION_SCHEMA = "chardb.file-benchmark.verification.v1";

const MAX_TARBALL_BYTES = 64 * 1_024 * 1_024;
const PROTECTED_EVIDENCE_FILES = [
    "local.json",
    "cloudflare.json",
    "comparison.json",
    "paired.json",
    "benchmark-evidence.sha256",
];

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function value(argv, flag) {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
}

export function parseFileBenchmarkVerificationArgs(argv) {
    const valueFlags = new Set(["--tarball", "--evidence", "--output"]);
    const allowed = new Set([...valueFlags, "--help", "-h"]);
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!allowed.has(argument))
            throw new Error(`unknown file benchmark verification argument ${JSON.stringify(argument)}`);
        if (!valueFlags.has(argument)) continue;
        if (seen.has(argument)) throw new Error(`${argument} may be provided only once`);
        seen.add(argument);
        const next = argv[++index];
        if (!next || allowed.has(next)) throw new Error(`${argument} requires a value`);
    }
    if (argv.includes("--help") || argv.includes("-h")) return { help: true };
    for (const flag of ["--tarball", "--evidence", "--output"]) {
        if (!value(argv, flag)) throw new Error(`${flag} is required`);
    }
    return {
        help: false,
        tarball: path.resolve(value(argv, "--tarball")),
        evidence: path.resolve(value(argv, "--evidence")),
        output: path.resolve(value(argv, "--output")),
    };
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function fingerprintTarball(file) {
    const before = await lstat(file, { bigint: true });
    check(before.isFile() && !before.isSymbolicLink(), "candidate tarball must be a regular file, not a symlink");
    check(before.size > 0n && before.size <= BigInt(MAX_TARBALL_BYTES), "candidate tarball has invalid bytes");
    const bytes = await readFile(file);
    const after = await lstat(file, { bigint: true });
    check(
        before.dev === after.dev &&
            before.ino === after.ino &&
            before.size === after.size &&
            before.mtimeNs === after.mtimeNs &&
            BigInt(bytes.byteLength) === after.size,
        "candidate tarball changed while it was read"
    );
    return { sha256: sha256(bytes), bytes: bytes.byteLength };
}

function operationSummary(metric) {
    return {
        operations: metric.operations,
        concurrency: metric.concurrency,
        totalBytes: metric.totalBytes,
        latencyMs: structuredClone(metric.latencyMs),
        operationsPerSecond: metric.operationsPerSecond,
        ...(metric.bytesPerSecond === undefined ? {} : { bytesPerSecond: metric.bytesPerSecond }),
    };
}

function aggregateSummary(report) {
    return report.aggregate.byPayload.map(payload => ({
        name: payload.name,
        payloadBytes: payload.payloadBytes,
        upload: operationSummary(payload.upload),
        attach: operationSummary(payload.attach),
        download: operationSummary(payload.download),
    }));
}

async function validatedReceipt(evidence, validation) {
    const pairBytes = await readFile(path.join(evidence, "paired.json"));
    check(sha256(pairBytes) === validation.pairSha256, "paired benchmark changed after validation");
    const pair = JSON.parse(pairBytes.toString("utf8"));
    const reportBytes = await Promise.all(
        ["local", "cloudflare", "comparison"].map(async name => {
            const bytes = await readFile(path.join(evidence, pair.reports[name].path));
            check(sha256(bytes) === pair.reports[name].sha256, `${name} benchmark changed after validation`);
            return JSON.parse(bytes.toString("utf8"));
        })
    );
    const [localInput, cloudflareInput, comparisonInput] = reportBytes;
    const local = assertFileBenchmarkReport(localInput);
    const cloudflare = assertFileBenchmarkReport(cloudflareInput);
    const comparison = compareFileBenchmarkReports(local, cloudflare);
    check(isDeepStrictEqual(comparisonInput, comparison), "comparison changed after validation");
    return {
        schema: FILE_BENCHMARK_VERIFICATION_SCHEMA,
        ok: true,
        candidate: structuredClone(validation.candidate),
        evidence: {
            schema: validation.schema,
            pairSha256: validation.pairSha256,
            files: validation.files,
        },
        workload: structuredClone(local.workload),
        profile: structuredClone(local.profile),
        execution: structuredClone(local.execution),
        runner: structuredClone(local.runner),
        local: {
            target: structuredClone(local.target),
            aggregate: aggregateSummary(local),
        },
        cloudflare: {
            target: structuredClone(cloudflare.target),
            aggregate: aggregateSummary(cloudflare),
        },
        comparison: {
            ratioDirection: comparison.ratioDirection,
            measurementBoundary: structuredClone(comparison.measurementBoundary),
            ratios: structuredClone(comparison.ratios),
        },
        costEvidence: {
            status: "not-collected",
            pricingApplied: false,
            monthlyCostClaimed: false,
            requiredExternalInput: "Cloudflare account billable-usage counters for this execution window",
        },
    };
}

export async function verifyFileBenchmark(input) {
    const candidateBefore = await fingerprintTarball(input.tarball);
    const validation = await validateFileBenchmarkEvidence(input.evidence, candidateBefore.sha256);
    check(
        isDeepStrictEqual(validation.candidate, candidateBefore),
        "file benchmark identifies a different packed candidate"
    );
    const receipt = await validatedReceipt(path.resolve(input.evidence), validation);
    const candidateAfter = await fingerprintTarball(input.tarball);
    check(isDeepStrictEqual(candidateAfter, candidateBefore), "candidate tarball changed during verification");
    return receipt;
}

export async function writeFileBenchmarkVerification(input) {
    const output = path.resolve(input.output);
    check(output !== path.resolve(input.tarball), "verification output must not overwrite the candidate tarball");
    const evidence = path.resolve(input.evidence);
    check(
        !PROTECTED_EVIDENCE_FILES.some(filename => output === path.join(evidence, filename)),
        "verification output must not overwrite benchmark evidence"
    );
    const receipt = await verifyFileBenchmark(input);
    const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
        await rename(temporary, output);
    } finally {
        await rm(temporary, { force: true });
    }
    return receipt;
}

function usage() {
    return [
        "Usage: bun scripts/verify-file-benchmark.mjs [options]",
        "",
        "  --tarball <path>  exact packed candidate used by both targets",
        "  --evidence <dir>  benchmark directory containing paired and raw reports",
        "  --output <path>    deterministic verification receipt",
        "  --help             show this help",
    ].join("\n");
}

if (import.meta.main) {
    try {
        const options = parseFileBenchmarkVerificationArgs(process.argv.slice(2));
        if (options.help) console.log(usage());
        else console.log(JSON.stringify(await writeFileBenchmarkVerification(options)));
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 2;
    }
}
