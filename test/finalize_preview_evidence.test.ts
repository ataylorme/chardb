import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    PREVIEW_EVIDENCE_MANIFEST_SCHEMA,
    buildPreviewEvidenceManifest,
    writePreviewEvidenceManifest,
} from "../scripts/finalize-preview-evidence.mjs";
import { PACKED_ORG_USER_CHECKS, buildPackedOrgUserReport } from "../scripts/packed-org-user-report.mjs";
import { REQUIRED_PREVIEW_STEPS } from "../scripts/preview-gate-report.mjs";
import {
    buildBrowserEvidence,
    buildGeneratedProjectEvidence,
    buildPackedChatEvidence,
    buildPackedPublicVectorEvidence,
} from "./fixtures/release-evidence-builders";

function digest(value: string) {
    return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "chardb-preview-evidence-"));
    const tarball = "exact tarball";
    const fingerprint = { algorithm: "sha256" as const, digest: digest(tarball), bytes: tarball.length };
    const generatedProject = buildGeneratedProjectEvidence(fingerprint);
    const packedChat = buildPackedChatEvidence(fingerprint);
    const packedPublicVector = buildPackedPublicVectorEvidence(fingerprint);
    const browser = buildBrowserEvidence(fingerprint);
    await writeFile(path.join(directory, "chardb-core-0.1.0.tgz"), tarball);
    await mkdir(path.join(directory, "nested"));
    await writeFile(path.join(directory, "nested", "proof.json"), '{"ok":true}\n');
    await writeFile(path.join(directory, "generated-project.json"), `${JSON.stringify(generatedProject)}\n`);
    await writeFile(path.join(directory, "packed-chat.json"), `${JSON.stringify(packedChat)}\n`);
    await writeFile(path.join(directory, "packed-public-vector.json"), `${JSON.stringify(packedPublicVector)}\n`);
    await writeFile(path.join(directory, "browser-proof.json"), `${JSON.stringify(browser)}\n`);
    await writeFile(
        path.join(directory, "packed-org-user.json"),
        `${JSON.stringify(
            buildPackedOrgUserReport({
                package: { name: "@chardb/core", version: "0.1.0", tarball: fingerprint },
                checks: Object.fromEntries(PACKED_ORG_USER_CHECKS.map(name => [name, true])),
            })
        )}\n`
    );
    await writeFile(
        path.join(directory, "preview-gate.json"),
        `${JSON.stringify({
            schema: "chardb.preview-gate.report.v1",
            suite: "organization-preview-release-gate",
            source: { gitSha: "abc", dirty: false },
            package: {
                name: "@chardb/core",
                version: "0.1.0",
                tarball: fingerprint,
            },
            steps: REQUIRED_PREVIEW_STEPS.map(name => ({ name, status: "passed" })),
            generatedProject,
            packedChat,
            packedPublicVector,
            browser,
            summary: { passed: true, completedSteps: REQUIRED_PREVIEW_STEPS.length, failedStep: null },
        })}\n`
    );
    return { directory, tarball };
}

describe("preview evidence finalization", () => {
    test("writes a deterministic manifest and independently checkable sums", async () => {
        const { directory, tarball } = await fixture();
        const manifest = await writePreviewEvidenceManifest(directory);
        expect(manifest).toMatchObject({
            schema: PREVIEW_EVIDENCE_MANIFEST_SCHEMA,
            candidate: { digest: digest(tarball), bytes: tarball.length },
            source: { gitSha: "abc", dirty: false },
        });
        expect(manifest.files.map(file => file.path)).toEqual([
            "browser-proof.json",
            "chardb-core-0.1.0.tgz",
            "generated-project.json",
            "nested/proof.json",
            "packed-chat.json",
            "packed-org-user.json",
            "packed-public-vector.json",
            "preview-gate.json",
        ]);
        const sums = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
        expect(sums).toContain("  evidence-manifest.json\n");
        expect(sums).not.toContain("  SHA256SUMS\n");
    });

    test("rejects failed gates, tarball drift, and symlinks", async () => {
        const failed = await fixture();
        const failedReportPath = path.join(failed.directory, "preview-gate.json");
        const failedReport = JSON.parse(await readFile(failedReportPath, "utf8"));
        failedReport.summary.passed = false;
        await writeFile(failedReportPath, JSON.stringify(failedReport));
        await expect(buildPreviewEvidenceManifest(failed.directory)).rejects.toThrow("did not pass");

        const drifted = await fixture();
        await writeFile(path.join(drifted.directory, "chardb-core-0.1.0.tgz"), "changed");
        await expect(buildPreviewEvidenceManifest(drifted.directory)).rejects.toThrow("does not match");

        const linked = await fixture();
        await symlink(path.join(linked.directory, "nested", "proof.json"), path.join(linked.directory, "linked"));
        await expect(buildPreviewEvidenceManifest(linked.directory)).rejects.toThrow("cannot contain symlink");
    });

    test("refuses to finalize dirty source or weak candidate identity", async () => {
        const dirty = await fixture();
        const dirtyReportPath = path.join(dirty.directory, "preview-gate.json");
        const dirtyReport = JSON.parse(await readFile(dirtyReportPath, "utf8"));
        dirtyReport.source.dirty = true;
        await writeFile(dirtyReportPath, JSON.stringify(dirtyReport));
        await expect(buildPreviewEvidenceManifest(dirty.directory)).rejects.toThrow("clean source tree");

        const weak = await fixture();
        const weakReportPath = path.join(weak.directory, "preview-gate.json");
        const weakReport = JSON.parse(await readFile(weakReportPath, "utf8"));
        weakReport.package.tarball.algorithm = "md5";
        await writeFile(weakReportPath, JSON.stringify(weakReport));
        await expect(buildPreviewEvidenceManifest(weak.directory)).rejects.toThrow("valid tarball fingerprint");
    });

    test("rejects forged minimal gates, missing steps, and missing or changed child reports", async () => {
        const minimal = await fixture();
        const minimalPath = path.join(minimal.directory, "preview-gate.json");
        const complete = JSON.parse(await readFile(minimalPath, "utf8"));
        await writeFile(
            minimalPath,
            JSON.stringify({
                schema: complete.schema,
                suite: complete.suite,
                source: complete.source,
                package: complete.package,
                summary: complete.summary,
            })
        );
        await expect(buildPreviewEvidenceManifest(minimal.directory)).rejects.toThrow("exact passing release step set");

        const missingChild = await fixture();
        const missingChildPath = path.join(missingChild.directory, "preview-gate.json");
        const missingChildReport = JSON.parse(await readFile(missingChildPath, "utf8"));
        missingChildReport.packedChat = undefined;
        await writeFile(missingChildPath, JSON.stringify(missingChildReport));
        await expect(buildPreviewEvidenceManifest(missingChild.directory)).rejects.toThrow("packed-chat evidence");

        const missingFile = await fixture();
        await rm(path.join(missingFile.directory, "browser-proof.json"));
        await expect(buildPreviewEvidenceManifest(missingFile.directory)).rejects.toThrow("browser-proof.json");

        const changedChild = await fixture();
        const childPath = path.join(changedChild.directory, "generated-project.json");
        const child = JSON.parse(await readFile(childPath, "utf8"));
        child.invariants.generatedByPackedCli = false;
        await writeFile(childPath, JSON.stringify(child));
        await expect(buildPreviewEvidenceManifest(changedChild.directory)).rejects.toThrow("differs");
    });
});
