import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    FILE_RESHARD_PROOF_DEPLOYMENT_FILES,
    FILE_RESHARD_PROOF_PREPARATION_EVIDENCE_SCHEMA,
    FILE_RESHARD_PROOF_PREPARATION_SCHEMA,
    type FileReshardProofPreparationEvidence,
    assertFileReshardProofPreparationEvidence,
    deriveFileReshardProofTarget,
    parseFileReshardProofPreparationArgs,
    prepareFileReshardProofApp,
    validatePreparedFileReshardProof,
} from "../scripts/prepare-file-reshard-deployment-proof.mjs";

const NONCE = "0123456789abcdef";
const RUN_ID = "file-reshard-proof-run-01";
const PHASES = ["package-lock", "install", "typecheck", "wrangler-doctor", "worker-dry-run"] as const;
const RUNTIME_EXPORTS = [
    "CDB_VECTOR_DELIVERY_SETTLEMENT_MS",
    "CDB_VECTOR_DELETE_UNPROVEN_TERMINAL_ERROR",
    "cdbVectorLogicalId",
    "cdbVectorResourceId",
    "cdbVectorizeOrganizationNamespace",
    "cdbVectorizePhysicalId",
    "cdbVectorizeResourceFilter",
    "collectSchemaResourceDescriptors",
    "deleteCdbVector",
    "dispatchOrganizationVectorSearch",
    "isChardbVectorResourceDescriptor",
    "parseCdbVectorizePhysicalId",
    "stageCdbVector",
    "vector",
    "vshardOf",
].sort();
const TYPE_EXPORTS = [
    ...RUNTIME_EXPORTS,
    "CdbValidatedVectorMatch",
    "CdbVectorizeMatch",
    "CdbVectorizeMutationIndex",
    "CdbVectorizeRecord",
    "CdbVectorizeSearchIndex",
    "OrganizationVectorSearchValidation",
].sort();
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })));
});

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "chardb-file-reshard-prepare-"));
    temporaryDirectories.push(root);
    return root;
}

async function writeInstalledCandidate(app: string): Promise<void> {
    const packageJson = JSON.parse(await readFile(path.join(app, "package.json"), "utf8")) as Record<string, unknown>;
    const packages: Record<string, unknown> = {
        "": packageJson,
        "node_modules/@chardb/core": { resolved: "file:chardb-proof.tgz" },
    };
    for (const [name, version] of Object.entries({
        "@noble/hashes": "1.8.0",
        "better-auth": "1.6.30",
        "drizzle-orm": "0.45.2",
        zod: "4.4.3",
        "@cloudflare/workers-types": "5.20260830.1",
        typescript: "5.9.3",
        wrangler: "4.125.0",
    })) {
        packages[`node_modules/${name}`] = { version };
    }
    await writeFile(
        path.join(app, "package-lock.json"),
        `${JSON.stringify({ name: packageJson.name, lockfileVersion: 3, packages }, null, 2)}\n`
    );
    const bridge = path.join(app, "node_modules", "@chardb", "core", "dist", "internal");
    await mkdir(bridge, { recursive: true });
    await writeFile(path.join(bridge, "vector-proof.mjs"), `export { ${RUNTIME_EXPORTS.join(", ")} };\n`);
    await writeFile(path.join(bridge, "vector-proof.d.mts"), `export { ${TYPE_EXPORTS.join(", ")} };\n`);
}

async function preparedFixture() {
    const root = await temporaryRoot();
    const packageFile = path.join(root, "candidate.tgz");
    const privateDir = path.join(root, "private");
    await writeFile(packageFile, "exact candidate tarball bytes");
    const prepared = await prepareFileReshardProofApp(
        { package: packageFile, privateDir, nonce: NONCE, runId: RUN_ID },
        {
            validate: async ({ app }) => {
                await writeInstalledCandidate(app);
                return { phases: PHASES };
            },
        }
    );
    return { root, packageFile, privateDir, ...prepared };
}

describe("file/vector reshard deployment preparation", () => {
    test("parses a small CLI and rejects ambiguous arguments", () => {
        const options = parseFileReshardProofPreparationArgs([
            "--package",
            "candidate.tgz",
            "--private-dir",
            "private",
        ]);
        expect(options.package).toBe(path.resolve("candidate.tgz"));
        expect(options.privateDir).toBe(path.resolve("private"));
        expect(options.npmExecutable).toBe("npm");
        expect(options.nonce).toBeUndefined();
        expect(() =>
            parseFileReshardProofPreparationArgs([
                "--package",
                "a.tgz",
                "--package",
                "b.tgz",
                "--private-dir",
                "private",
            ])
        ).toThrow("--package may be supplied only once");
        expect(() => parseFileReshardProofPreparationArgs(["--package", "a.tgz"])).toThrow("--private-dir is required");
        expect(() =>
            parseFileReshardProofPreparationArgs(["--package", "a.tgz", "--private-dir", "private", "--nonce", "ABC"])
        ).toThrow("16 lowercase hexadecimal");
    });

    test("writes a private wrapper and a complete public evidence record", async () => {
        const prepared = await preparedFixture();
        expect(prepared.receipt.schema).toBe(FILE_RESHARD_PROOF_PREPARATION_SCHEMA);
        expect(prepared.evidence.schema).toBe(FILE_RESHARD_PROOF_PREPARATION_EVIDENCE_SCHEMA);
        expect(prepared.receipt.evidence).toEqual(prepared.evidence);
        expect(prepared.evidence.target.worker).toBe(
            deriveFileReshardProofTarget(prepared.evidence.candidate.digest, NONCE)
        );
        expect(prepared.evidence.target).toEqual({
            worker: prepared.evidence.target.worker,
            bucket: prepared.evidence.target.worker,
            vectorizeIndex: prepared.evidence.target.worker,
        });
        expect(prepared.evidence.deploymentInput.files.map(record => record.path)).toEqual([
            ...FILE_RESHARD_PROOF_DEPLOYMENT_FILES,
        ]);
        expect(prepared.evidence.deploymentInput.files.find(record => record.path === "chardb-proof.tgz")).toEqual({
            path: "chardb-proof.tgz",
            bytes: prepared.evidence.candidate.bytes,
            sha256: prepared.evidence.candidate.digest,
        });
        expect(prepared.evidence.mutatingCommandsExecuted).toBe(false);
        expect(JSON.parse(await readFile(prepared.evidencePath, "utf8"))).toEqual(prepared.evidence);
        expect(JSON.parse(await readFile(prepared.preparation, "utf8"))).toEqual(prepared.receipt);
        expect(Bun.TOML.parse(await readFile(path.join(prepared.receipt.app, "wrangler.toml"), "utf8"))).toHaveProperty(
            "durable_objects.bindings",
            [
                { name: "CDB_CATALOG", class_name: "Catalog" },
                { name: "CDB_SHARD", class_name: "Cdb" },
                { name: "CDB_GATEWAY", class_name: "Gateway" },
                { name: "CDB_RESHARD", class_name: "Resharder" },
            ]
        );

        const validated = await validatePreparedFileReshardProof({
            package: prepared.packageFile,
            preparation: prepared.preparation,
        });
        expect(validated.evidence).toEqual(prepared.evidence);
        expect(validated.receipt).toEqual(prepared.evidence);
        expect(validated.wrapper).toEqual(prepared.receipt);
    });

    test("the public validator fails closed on target, phase, file, digest, and tarball drift", async () => {
        const { evidence } = await preparedFixture();
        const mutations: Array<[string, (copy: FileReshardProofPreparationEvidence) => void, string]> = [
            [
                "target",
                copy => Object.assign(copy.target, { bucket: `${copy.target.bucket}-other` }),
                "target ownership",
            ],
            [
                "phase",
                copy => Object.assign(copy.validation, { phases: copy.validation.phases.slice(0, -1) }),
                "validation phases",
            ],
            [
                "file",
                copy => {
                    Object.assign(copy.deploymentInput, { files: copy.deploymentInput.files.slice(0, -1) });
                    Object.assign(copy.deploymentInput, {
                        digest: sha256(JSON.stringify(copy.deploymentInput.files)),
                    });
                },
                "deployment files",
            ],
            ["aggregate", copy => Object.assign(copy.deploymentInput, { digest: "f".repeat(64) }), "digest is invalid"],
            [
                "tarball",
                copy => {
                    const tarball = copy.deploymentInput.files.find(record => record.path === "chardb-proof.tgz");
                    if (!tarball) throw new Error("fixture tarball is missing");
                    Object.assign(tarball, {
                        sha256: "e".repeat(64),
                    });
                    Object.assign(copy.deploymentInput, {
                        digest: sha256(JSON.stringify(copy.deploymentInput.files)),
                    });
                },
                "tarball identity",
            ],
        ];
        for (const [label, mutate, message] of mutations) {
            const copy = structuredClone(evidence) as FileReshardProofPreparationEvidence;
            mutate(copy);
            expect(() => assertFileReshardProofPreparationEvidence(copy), label).toThrow(message);
        }
    });

    test("validation rejects app and source candidate changes after preparation", async () => {
        const appDrift = await preparedFixture();
        await writeFile(path.join(appDrift.receipt.app, "src", "worker.ts"), "export default {};\n");
        await expect(
            validatePreparedFileReshardProof({
                package: appDrift.packageFile,
                preparation: appDrift.preparation,
            })
        ).rejects.toThrow("prepared deployment tree changed after validation");

        const candidateDrift = await preparedFixture();
        await writeFile(candidateDrift.packageFile, "different candidate tarball bytes");
        await expect(
            validatePreparedFileReshardProof({
                package: candidateDrift.packageFile,
                preparation: candidateDrift.preparation,
            })
        ).rejects.toThrow("preparation evidence candidate drifted");
    });

    test("rejects a symlink candidate before copying it", async () => {
        const root = await temporaryRoot();
        const target = path.join(root, "candidate-real.tgz");
        const link = path.join(root, "candidate.tgz");
        await writeFile(target, "candidate");
        await symlink(target, link);
        await expect(
            prepareFileReshardProofApp({ package: link, privateDir: path.join(root, "private") })
        ).rejects.toThrow("must be a regular file, not a symlink");
    });

    test("the evidence aggregate digest is the canonical record digest", async () => {
        const { evidence } = await preparedFixture();
        expect(evidence.deploymentInput.digest).toBe(sha256(JSON.stringify(evidence.deploymentInput.files)));
        expect(evidence.fixtureInput.digest).toBe(sha256(JSON.stringify(evidence.fixtureInput.files)));
    });
});
