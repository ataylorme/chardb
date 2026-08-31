import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { orchestrateFileReshardCloudflareProof } from "../scripts/file-reshard-proof-orchestrator.mjs";
import { prepareCloudflareFileProofDirectories } from "../scripts/run-cloudflare-file-proof.mjs";
import { prepareCloudflareVectorizeProofPlan } from "../scripts/run-cloudflare-vectorize-proof.mjs";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function aliasedTrees() {
    const root = await mkdtemp(path.join(tmpdir(), "chardb-proof-directory-integrity-"));
    roots.push(root);
    const canonical = path.join(root, "canonical");
    const alias = path.join(root, "alias");
    await mkdir(canonical);
    await symlink(canonical, alias, "dir");
    return {
        root,
        output: path.join(canonical, "evidence"),
        privateDir: path.join(alias, "evidence", "private"),
    };
}

describe("proof directory canonical separation", () => {
    test("Vectorize rejects a private tree that resolves inside public evidence", async () => {
        const paths = await aliasedTrees();
        const candidate = path.join(paths.root, "candidate.tgz");
        await writeFile(candidate, "candidate");
        await expect(
            prepareCloudflareVectorizeProofPlan({
                tarball: candidate,
                output: paths.output,
                privateDir: paths.privateDir,
                nonce: "0123456789abcdef",
                runId: "0123456789abcdef",
            })
        ).rejects.toThrow("must resolve to separate trees");
    });

    test("the R2 proof rejects a private tree that resolves inside public evidence", async () => {
        const paths = await aliasedTrees();
        await expect(prepareCloudflareFileProofDirectories(paths.output, paths.privateDir)).rejects.toThrow(
            "must resolve to separate trees"
        );
    });

    test("the combined reshard proof rejects the same canonical tree before preparation", async () => {
        const paths = await aliasedTrees();
        const candidate = path.join(paths.root, "candidate.tgz");
        await writeFile(candidate, "candidate");
        await expect(
            orchestrateFileReshardCloudflareProof({
                confirmed: true,
                accountId: "a".repeat(32),
                workersDevSubdomain: "example",
                tarball: candidate,
                output: paths.output,
                privateDir: paths.privateDir,
            })
        ).rejects.toThrow("must resolve to separate trees");
    });
});
