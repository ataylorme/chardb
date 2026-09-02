import { describe, expect, test } from "bun:test";
import {
    FILE_RESHARD_BENCHMARK_PHASES,
    FILE_RESHARD_BENCHMARK_PROFILES,
} from "../scripts/file-reshard-benchmark-report.mjs";
import {
    FILE_RESHARD_DEPLOYMENT_BINDINGS,
    FILE_RESHARD_DEPLOYMENT_CAPABILITIES_SCHEMA,
    FILE_RESHARD_DEPLOYMENT_CORRECTNESS,
    FILE_RESHARD_DEPLOYMENT_PAIR_SCHEMA,
    FILE_RESHARD_DEPLOYMENT_SAMPLE_SCHEMA,
    FILE_RESHARD_DEPLOYMENT_TEARDOWN_SCHEMA,
    FILE_RESHARD_LOCAL_BINDINGS,
    assertFileReshardDeploymentCapabilities,
    assertFileReshardDeploymentPair,
    assertFileReshardDeploymentSample,
    assertFileReshardDeploymentTeardown,
    compareFileReshardDeploymentSamples,
} from "../scripts/file-reshard-deployment-proof.mjs";

const DIGEST = "a".repeat(64);
const IDENTITY = "b".repeat(64);

function target(kind: "local" | "deployed") {
    return {
        kind,
        runtime: kind === "local" ? "miniflare/workerd" : "cloudflare-workers",
        deploymentVersion: kind === "local" ? "local-dev" : "version-1",
        configurationSha256: "c".repeat(64),
        bindings: [...(kind === "local" ? FILE_RESHARD_LOCAL_BINDINGS : FILE_RESHARD_DEPLOYMENT_BINDINGS)],
        sourceShard: "cdb-source",
        destinationShard: "cdb-destination",
        r2Bucket: "chardb-file-reshard-proof-test",
        vectorizeIndex: "chardb-file-reshard-proof-test",
    };
}

function sample(kind: "local" | "deployed", sequence: number, multiplier = 1) {
    const profile = FILE_RESHARD_BENCHMARK_PROFILES.small;
    if (!profile) throw new Error("small profile is missing");
    const opaqueIdentity = kind === "local" ? IDENTITY : "e".repeat(64);
    const physicalIds = Array.from({ length: profile.files }, (_, index) => `physical-${kind}-${index}`);
    return {
        schema: FILE_RESHARD_DEPLOYMENT_SAMPLE_SCHEMA,
        sequence,
        excluded: sequence === -1,
        candidateSha256: DIGEST,
        runKey: `deployment_proof_${sequence < 0 ? "warmup" : sequence}`,
        workload: { id: "file-vector-aware-range-move", version: 3, profile },
        target: target(kind),
        execution: {
            startedAt: "2026-08-29T00:00:00.000Z",
            completedAt: "2026-08-29T00:00:01.000Z",
            requestAttempts: 2,
        },
        dataset: {
            organizations: profile.organizations,
            files: profile.files,
            metadataRows: profile.files,
            vectors: profile.files,
            objectBytes: 128,
        },
        timing: {
            totalMs: 100 * multiplier,
            phasesMs: Object.fromEntries(FILE_RESHARD_BENCHMARK_PHASES.map((phase, index) => [phase, index + 1])),
        },
        movement: {
            runTurns: 12,
            routeEpochBefore: 4,
            routeEpochAfter: 5,
            r2: {
                objectsBefore: profile.files,
                objectsAfter: profile.files,
                bytesBefore: 128,
                bytesAfter: 128,
                identityDigestBefore: opaqueIdentity,
                identityDigestAfter: opaqueIdentity,
                operationTrace: {
                    available: kind === "local",
                    method: kind === "local" ? "cdb-r2-proxy" : "unavailable-native-binding",
                    putsDuringMove: kind === "local" ? 0 : null,
                    deletesDuringMove: kind === "local" ? 0 : null,
                },
            },
            vectors: {
                headsBefore: profile.files,
                headsAfter: profile.files,
                readyHeadsBefore: profile.files,
                readyHeadsAfter: profile.files,
                outboxBefore: profile.files,
                outboxAfter: profile.files,
                attemptsBefore: profile.files,
                attemptsAfter: profile.files,
                headDigestBefore: opaqueIdentity,
                headDigestAfter: opaqueIdentity,
                outboxDigestBefore: kind === "local" ? DIGEST : "f".repeat(64),
                outboxDigestAfter: kind === "local" ? DIGEST : "f".repeat(64),
                attemptDigestBefore: kind === "local" ? "c".repeat(64) : "1".repeat(64),
                attemptDigestAfter: kind === "local" ? "c".repeat(64) : "1".repeat(64),
                physicalIdsBefore: [...physicalIds],
                physicalIdsAfter: [...physicalIds],
                physicalIdentityDigestBefore: kind === "local" ? "d".repeat(64) : "2".repeat(64),
                physicalIdentityDigestAfter: kind === "local" ? "d".repeat(64) : "2".repeat(64),
                providerRecordsBefore: profile.files,
                providerRecordsAfter: profile.files,
                providerMutationTrace: {
                    available: kind === "local",
                    method: kind === "local" ? "durable-object-vector-probe" : "stable-physical-identity",
                    upsertsDuringMove: kind === "local" ? 0 : null,
                    deletesDuringMove: kind === "local" ? 0 : null,
                },
                search: { rowPk: "row-0", score: 1 },
            },
        },
        responseLoss: {
            operation: "apply_snapshot",
            firstStatus: 503,
            committed: true,
            sameRunKey: true,
            retrySucceeded: true,
        },
        alarm: {
            invoked: true,
            durable: true,
            ownerShard: "cdb-destination",
            deletedMetadataRows: 1,
            remainingMetadataRows: profile.files - 1,
            retainedObjects: profile.files,
        },
        correctness: Object.fromEntries(FILE_RESHARD_DEPLOYMENT_CORRECTNESS.map(name => [name, true])),
    };
}

function pair() {
    const profile = FILE_RESHARD_BENCHMARK_PROFILES.small;
    if (!profile) throw new Error("small profile is missing");
    const local = [sample("local", 0, 1), sample("local", 1, 2), sample("local", 2, 3)];
    const deployed = [sample("deployed", 0, 2), sample("deployed", 1, 3), sample("deployed", 2, 4)];
    return {
        schema: FILE_RESHARD_DEPLOYMENT_PAIR_SCHEMA,
        ok: true,
        candidate: { sha256: DIGEST, bytes: 1_024 },
        profile,
        execution: {
            startedAt: "2026-08-29T00:00:00.000Z",
            completedAt: "2026-08-29T00:01:00.000Z",
            order: [-1, 0, 1, 2].map((sequence, index) => ({
                sequence,
                targets: index % 2 === 0 ? ["local", "deployed"] : ["deployed", "local"],
            })),
        },
        deployment: {
            worker: "chardb-file-reshard-proof-test",
            bucket: "chardb-file-reshard-proof-test",
            vectorizeIndex: "chardb-file-reshard-proof-test",
            version: "version-1",
            accountIdSha256: "d".repeat(64),
        },
        warmup: { local: sample("local", -1), deployed: sample("deployed", -1) },
        runs: local.map((localSample, sequence) => ({ sequence, local: localSample, deployed: deployed[sequence] })),
        comparison: compareFileReshardDeploymentSamples(local, deployed, "small"),
    };
}

describe("file reshard deployment evidence", () => {
    test("accepts exact local and deployed architecture evidence", () => {
        const capabilities = {
            schema: FILE_RESHARD_DEPLOYMENT_CAPABILITIES_SCHEMA,
            releaseSha256: DIGEST,
            runId: "deployment_proof_run_1234",
            target: target("deployed"),
            protocol: "bounded-operator-v1",
            features: {
                alarms: true,
                commitThenResponseLoss: true,
                directR2OperationTrace: false,
                fileAwareReshard: true,
                freshDisposableData: true,
                providerVectorMutationTrace: false,
                publicVectorSearch: true,
                retainedFileRecovery: true,
                vectorAwareReshard: true,
            },
        };
        expect(
            assertFileReshardDeploymentCapabilities(capabilities, {
                releaseSha256: DIGEST,
                runId: "deployment_proof_run_1234",
                kind: "deployed",
                configurationSha256: "c".repeat(64),
            }).target.bindings
        ).toEqual(FILE_RESHARD_DEPLOYMENT_BINDINGS);
        expect(() =>
            assertFileReshardDeploymentCapabilities(capabilities, {
                configurationSha256: "e".repeat(64),
            })
        ).toThrow("configuration digest drifted");
        expect(assertFileReshardDeploymentSample(sample("local", 0))).toMatchObject({ sequence: 0 });
        expect(assertFileReshardDeploymentPair(pair()).comparison).toMatchObject({ descriptiveOnly: true });
    });

    test("rejects weak movement, retry, alarm, and ownership claims", () => {
        const r2Write = sample("local", 0);
        r2Write.movement.r2.operationTrace.putsDuringMove = 1;
        expect(() => assertFileReshardDeploymentSample(r2Write)).toThrow("zero Cdb R2 movement operations");

        const extraAttempt = sample("local", 0);
        extraAttempt.execution.requestAttempts = 3;
        expect(() => assertFileReshardDeploymentSample(extraAttempt)).toThrow("exactly one lost response");

        const wrongOwner = sample("local", 0);
        wrongOwner.alarm.ownerShard = "cdb-source";
        expect(() => assertFileReshardDeploymentSample(wrongOwner)).toThrow("destination owner");

        const reusedCdb = sample("local", 0);
        reusedCdb.target.destinationShard = reusedCdb.target.sourceShard;
        expect(() => assertFileReshardDeploymentSample(reusedCdb)).toThrow("two distinct Cdbs");

        const missingBinding = sample("local", 0);
        missingBinding.target.bindings = missingBinding.target.bindings.filter(name => name !== "CDB_RESHARD");
        expect(() => assertFileReshardDeploymentSample(missingBinding)).toThrow("required deployed architecture");

        const providerMutation = sample("local", 0);
        providerMutation.movement.vectors.providerMutationTrace.upsertsDuringMove = 1;
        expect(() => assertFileReshardDeploymentSample(providerMutation)).toThrow("zero provider vector movement");

        const physicalDrift = sample("deployed", 0);
        physicalDrift.movement.vectors.physicalIdsAfter[0] = "different-physical-id";
        expect(() => assertFileReshardDeploymentSample(physicalDrift)).toThrow("physical IDs changed");

        const r2IdentityDrift = sample("deployed", 0);
        r2IdentityDrift.movement.r2.identityDigestAfter = "3".repeat(64);
        expect(() => assertFileReshardDeploymentSample(r2IdentityDrift)).toThrow("R2 identity changed");

        const inventedTrace = sample("deployed", 0);
        inventedTrace.movement.vectors.providerMutationTrace.upsertsDuringMove = 0;
        expect(() => assertFileReshardDeploymentSample(inventedTrace)).toThrow("stable physical identity");
    });

    test("accepts independent opaque IDs while rejecting semantic cross-target drift and a reordered plan", () => {
        const local = [sample("local", 0), sample("local", 1), sample("local", 2)];
        const deployed = [sample("deployed", 0), sample("deployed", 1), sample("deployed", 2)];
        expect(compareFileReshardDeploymentSamples(local, deployed, "small")).toMatchObject({
            descriptiveOnly: true,
        });
        const driftedRunKey = deployed[0];
        if (!driftedRunKey) throw new Error("deployed sample is missing");
        driftedRunKey.runKey = "deployment_proof_wrong_0";
        expect(() => compareFileReshardDeploymentSamples(local, deployed, "small")).toThrow("semantic run key drifted");
        driftedRunKey.runKey = local[0]?.runKey ?? "";
        const driftedSample = deployed[1];
        if (!driftedSample) throw new Error("deployed sample is missing");
        driftedSample.candidateSha256 = "e".repeat(64);
        expect(() => compareFileReshardDeploymentSamples(local, deployed, "small")).toThrow("candidate drifted");
        driftedSample.candidateSha256 = DIGEST;
        driftedSample.movement.runTurns++;
        expect(() => compareFileReshardDeploymentSamples(local, deployed, "small")).toThrow(
            "movement runTurns drifted"
        );

        const changedPair = pair();
        const reorderedStep = changedPair.execution.order[1];
        if (!reorderedStep) throw new Error("execution step is missing");
        reorderedStep.targets.reverse();
        expect(() => assertFileReshardDeploymentPair(changedPair)).toThrow("execution order 1 drifted");

        const splitResources = pair();
        splitResources.deployment.vectorizeIndex = "different-proof-index";
        expect(() => assertFileReshardDeploymentPair(splitResources)).toThrow(
            "Worker, R2 bucket, and Vectorize index identity drifted"
        );

        const wrongVersion = pair();
        const firstRun = wrongVersion.runs[0];
        if (!firstRun) throw new Error("first deployment proof run is missing");
        const deployedSample = firstRun.deployed;
        if (!deployedSample) throw new Error("first deployed proof sample is missing");
        deployedSample.target.deploymentVersion = "version-2";
        expect(() => assertFileReshardDeploymentPair(wrongVersion)).toThrow("target identity drifted from deployment");
    });

    test("requires exact Worker, R2, Vectorize, and local-state cleanup receipts", () => {
        const teardown = {
            schema: FILE_RESHARD_DEPLOYMENT_TEARDOWN_SCHEMA,
            ok: true,
            candidateSha256: DIGEST,
            worker: "chardb-file-vector-reshard-proof-unit",
            bucket: "chardb-file-vector-reshard-proof-unit",
            vectorizeIndex: "chardb-file-vector-reshard-proof-unit",
            localStateStopped: true,
            workerDeleted: true,
            bucketDeleted: true,
            vectorizeIndexDeleted: true,
            workerAbsentVerified: true,
            bucketAbsentVerified: true,
            vectorizeIndexAbsentVerified: true,
            idempotentReplay: { done: true, remaining: 0 },
        };
        expect(assertFileReshardDeploymentTeardown(teardown, { candidateSha256: DIGEST })).toEqual(teardown);
        expect(() => assertFileReshardDeploymentTeardown({ ...teardown, vectorizeIndexAbsentVerified: false })).toThrow(
            "vectorizeIndexAbsentVerified is incomplete"
        );
        expect(() =>
            assertFileReshardDeploymentTeardown({ ...teardown, vectorizeIndex: "different-proof-index" })
        ).toThrow("target identity drifted");
    });
});
