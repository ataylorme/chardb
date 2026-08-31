import { expect, test } from "bun:test";
import { produceNativeVectorizeBenchmark } from "../scripts/produce-native-vectorize-benchmark.mjs";
import { assertVectorizeLocalFakeBenchmarkReport } from "../scripts/vectorize-local-fake-benchmark-report.mjs";

test("native Workerd benchmark measures one warmup and five ready-vector searches", async () => {
    const report = assertVectorizeLocalFakeBenchmarkReport(await produceNativeVectorizeBenchmark());
    expect(report.sampling.warmup).toMatchObject({ sequence: -1, excluded: true });
    expect(report.sampling.samples.map(sample => sample.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(report.track.samplesMs).toEqual(report.sampling.samples.map(sample => sample.elapsedMs));
    expect(report.workload).toMatchObject({ dimensions: 32, metric: "cosine", topK: 1 });
    expect(report.correctness).toEqual({
        readyBeforeTiming: true,
        owningOrganizationExactMatch: true,
        isolatedOrganizationEmpty: true,
        productionCandidateValidation: true,
        assertionsOutsideTiming: true,
    });
}, 60_000);
