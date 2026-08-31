import type { FileReshardBenchmarkProfile } from "./file-reshard-benchmark-report.mjs";

export type FileReshardDeploymentKind = "local" | "deployed";

export interface FileReshardDeploymentTarget {
    kind: FileReshardDeploymentKind;
    runtime: string;
    deploymentVersion: string;
    configurationSha256: string;
    bindings: readonly string[];
    sourceShard: string;
    destinationShard: string;
    r2Bucket: string;
    vectorizeIndex: string;
}

export interface FileReshardDeploymentCapabilities extends Record<string, unknown> {
    schema: string;
    releaseSha256: string;
    runId: string;
    target: FileReshardDeploymentTarget;
    protocol: "bounded-operator-v1";
    features: Record<string, true>;
}

export interface FileReshardDeploymentFault extends Record<string, unknown> {
    schema: string;
    runKey: string;
    operation: string;
    committed: true;
    retryable: true;
}

export interface FileReshardDeploymentSample extends Record<string, unknown> {
    schema: string;
    sequence: number;
    excluded: boolean;
    candidateSha256: string;
    runKey: string;
    workload: { id: string; version: number; profile: FileReshardBenchmarkProfile };
    target: FileReshardDeploymentTarget;
    execution: { startedAt: string; completedAt: string; requestAttempts: 2 };
    dataset: { organizations: number; files: number; metadataRows: number; vectors: number; objectBytes: number };
    timing: { totalMs: number; phasesMs: Record<string, number> };
    movement: Record<string, unknown>;
    responseLoss: Record<string, unknown>;
    alarm: Record<string, unknown>;
    correctness: Record<string, true>;
}

export interface FileReshardDeploymentPair extends Record<string, unknown> {
    schema: string;
    ok: true;
    candidate: { sha256: string; bytes: number };
    profile: FileReshardBenchmarkProfile;
    execution: Record<string, unknown>;
    deployment: Record<string, unknown>;
    warmup: { local: FileReshardDeploymentSample; deployed: FileReshardDeploymentSample };
    runs: readonly Record<string, unknown>[];
    comparison: Record<string, unknown>;
}

export const FILE_RESHARD_DEPLOYMENT_SAMPLE_SCHEMA: string;
export const FILE_RESHARD_DEPLOYMENT_PAIR_SCHEMA: string;
export const FILE_RESHARD_DEPLOYMENT_CAPABILITIES_SCHEMA: string;
export const FILE_RESHARD_DEPLOYMENT_TEARDOWN_SCHEMA: string;
export const FILE_RESHARD_DEPLOYMENT_FAULT_SCHEMA: string;
export const FILE_RESHARD_DEPLOYMENT_BINDINGS: readonly string[];
export const FILE_RESHARD_LOCAL_BINDINGS: readonly string[];
export const FILE_RESHARD_DEPLOYMENT_CORRECTNESS: readonly string[];

export function assertFileReshardDeploymentCapabilities(
    input: unknown,
    expected?: Record<string, unknown>
): FileReshardDeploymentCapabilities;
export function assertFileReshardDeploymentFault(
    input: unknown,
    expected: { runKey: string; operation: string }
): FileReshardDeploymentFault;
export function assertFileReshardDeploymentTeardown(
    input: unknown,
    expected?: { candidateSha256?: string }
): Record<string, unknown>;
export function assertFileReshardDeploymentSample(
    input: unknown,
    expected?: Record<string, unknown>
): FileReshardDeploymentSample;
export function compareFileReshardDeploymentSamples(
    localSamples: readonly unknown[],
    deployedSamples: readonly unknown[],
    profileName: string
): Record<string, unknown>;
export function assertFileReshardDeploymentPair(input: unknown): FileReshardDeploymentPair;
