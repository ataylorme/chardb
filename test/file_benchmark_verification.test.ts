import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    FILE_BENCHMARK_VERIFICATION_SCHEMA,
    parseFileBenchmarkVerificationArgs,
    verifyFileBenchmark,
    writeFileBenchmarkVerification,
} from "../scripts/verify-file-benchmark.mjs";
import {
    buildFileBenchmarkComparison,
    buildFileBenchmarkPair,
    buildFileBenchmarkReport,
    fixtureSha256,
} from "./fixtures/release-evidence-builders.ts";

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "chardb-file-benchmark-verification-"));
    const evidence = path.join(root, "evidence");
    await mkdir(evidence);
    const tarball = path.join(root, "candidate.tgz");
    const tarballBytes = new TextEncoder().encode("exact packed candidate\n");
    await writeFile(tarball, tarballBytes);
    const candidate = { sha256: fixtureSha256(tarballBytes), bytes: tarballBytes.byteLength };
    const local = buildFileBenchmarkReport("local", candidate);
    const cloudflare = buildFileBenchmarkReport("cloudflare", candidate, 2);
    const comparison = buildFileBenchmarkComparison(local, cloudflare);
    const serialized = {
        local: `${JSON.stringify(local, null, 2)}\n`,
        cloudflare: `${JSON.stringify(cloudflare, null, 2)}\n`,
        comparison: `${JSON.stringify(comparison, null, 2)}\n`,
    };
    for (const [name, value] of Object.entries(serialized)) {
        await writeFile(path.join(evidence, `${name}.json`), value);
    }
    const pair = buildFileBenchmarkPair(candidate, {
        local: fixtureSha256(serialized.local),
        cloudflare: fixtureSha256(serialized.cloudflare),
        comparison: fixtureSha256(serialized.comparison),
    });
    const pairBytes = `${JSON.stringify(pair, null, 2)}\n`;
    await writeFile(path.join(evidence, "paired.json"), pairBytes);
    await writeFile(
        path.join(evidence, "benchmark-evidence.sha256"),
        `${createHash("sha256").update(pairBytes).digest("hex")}  paired.json\n`
    );
    return { root, evidence, tarball, candidate, comparison };
}

describe("file benchmark verification", () => {
    test("binds comparable local and deployed measurements to the exact tarball without claiming cost", async () => {
        const input = await fixture();
        try {
            const first = await verifyFileBenchmark(input);
            const output = path.join(input.root, "verification.json");
            const second = await writeFileBenchmarkVerification({ ...input, output });
            expect(second).toEqual(first);
            expect(JSON.parse(await readFile(output, "utf8"))).toEqual(first);
            expect(first).toMatchObject({
                schema: FILE_BENCHMARK_VERIFICATION_SCHEMA,
                ok: true,
                candidate: input.candidate,
                workload: { id: "organization-file-lifecycle", version: 1 },
                comparison: {
                    ratioDirection: "cloudflare/local",
                    measurementBoundary: {
                        measures: ["client-observed-latency", "throughput"],
                        billingCountersCollected: false,
                        costClaimed: false,
                    },
                    ratios: input.comparison.ratios,
                },
                costEvidence: {
                    status: "not-collected",
                    pricingApplied: false,
                    monthlyCostClaimed: false,
                },
            });
            expect(first.local.aggregate[0]?.upload).not.toHaveProperty("rawLatencyMs");
        } finally {
            await rm(input.root, { recursive: true, force: true });
        }
    });

    test("rejects a different or symlinked packed candidate", async () => {
        const input = await fixture();
        try {
            const other = path.join(input.root, "other.tgz");
            await writeFile(other, "different candidate");
            await expect(verifyFileBenchmark({ ...input, tarball: other })).rejects.toThrow("candidate drifted");
            const linked = path.join(input.root, "linked.tgz");
            await symlink(input.tarball, linked);
            await expect(verifyFileBenchmark({ ...input, tarball: linked })).rejects.toThrow("not a symlink");
        } finally {
            await rm(input.root, { recursive: true, force: true });
        }
    });

    test("never overwrites the candidate or canonical evidence", async () => {
        const input = await fixture();
        try {
            await expect(writeFileBenchmarkVerification({ ...input, output: input.tarball })).rejects.toThrow(
                "must not overwrite the candidate"
            );
            await expect(
                writeFileBenchmarkVerification({ ...input, output: path.join(input.evidence, "paired.json") })
            ).rejects.toThrow("must not overwrite benchmark evidence");
        } finally {
            await rm(input.root, { recursive: true, force: true });
        }
    });

    test("has a strict, portable CLI contract", () => {
        expect(
            parseFileBenchmarkVerificationArgs([
                "--tarball",
                "candidate.tgz",
                "--evidence",
                "evidence",
                "--output",
                "verified.json",
            ])
        ).toEqual({
            help: false,
            tarball: path.resolve("candidate.tgz"),
            evidence: path.resolve("evidence"),
            output: path.resolve("verified.json"),
        });
        expect(() => parseFileBenchmarkVerificationArgs(["--tarball", "candidate.tgz"])).toThrow(
            "--evidence is required"
        );
        expect(() => parseFileBenchmarkVerificationArgs(["--wat"])).toThrow("unknown");
    });
});
