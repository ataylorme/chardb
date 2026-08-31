import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CHARDB_PACKAGE_NAME, CHARDB_REACT_PACKAGE_NAME, npmPackFilename } from "./package-identity.mjs";
import { assertMatchingPackedOrgUserReport } from "./packed-org-user-report.mjs";
import { assertPassingPreviewGateReport } from "./preview-gate-report.mjs";

export const PREVIEW_EVIDENCE_MANIFEST_SCHEMA = "chardb.preview-evidence-manifest.v1";
const EXCLUDED = new Set(["evidence-manifest.json", "SHA256SUMS"]);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function filesUnder(root, directory = root) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (EXCLUDED.has(relative)) continue;
        if (entry.isSymbolicLink()) throw new Error(`preview evidence cannot contain symlink ${relative}`);
        if (entry.isDirectory()) files.push(...(await filesUnder(root, absolute)));
        else if (entry.isFile()) files.push(relative);
        else throw new Error(`preview evidence contains unsupported entry ${relative}`);
    }
    return files;
}

export async function buildPreviewEvidenceManifest(directory) {
    const root = path.resolve(directory);
    const report = JSON.parse(await readFile(path.join(root, "preview-gate.json"), "utf8"));
    assertPassingPreviewGateReport(report);
    const candidate = report.package?.tarball;
    if (report.package?.name !== CHARDB_PACKAGE_NAME) {
        throw new Error(`preview gate package must be ${CHARDB_PACKAGE_NAME}`);
    }
    if (!VERSION.test(report.package?.version ?? "")) {
        throw new Error("preview gate package version is invalid");
    }
    const reactCandidate = report.reactPackage?.tarball;
    if (report.reactPackage?.name !== CHARDB_REACT_PACKAGE_NAME) {
        throw new Error(`preview gate React package must be ${CHARDB_REACT_PACKAGE_NAME}`);
    }
    if (!VERSION.test(report.reactPackage?.version ?? "")) {
        throw new Error("preview gate React package version is invalid");
    }
    const listedFiles = await filesUnder(root);
    for (const [relative, key] of [
        ["generated-project.json", "generatedProject"],
        ["packed-chat.json", "packedChat"],
        ["packed-public-vector.json", "packedPublicVector"],
        ["browser-proof.json", "browser"],
    ]) {
        const child = JSON.parse(await readFile(path.join(root, relative), "utf8"));
        if (!isDeepStrictEqual(child, report[key])) {
            throw new Error(`preview evidence ${relative} differs from the passing gate report`);
        }
    }
    const packedOrgUser = JSON.parse(await readFile(path.join(root, "packed-org-user.json"), "utf8"));
    assertMatchingPackedOrgUserReport(packedOrgUser, candidate);
    const files = [];
    for (const relative of listedFiles) {
        const absolute = path.join(root, ...relative.split("/"));
        const stat = await lstat(absolute);
        const bytes = await readFile(absolute);
        files.push({ path: relative, bytes: stat.size, sha256: sha256(bytes) });
    }
    const tarball = files.find(file => file.path === npmPackFilename(report.package.name, report.package.version));
    if (!tarball || tarball.sha256 !== candidate.digest || tarball.bytes !== candidate.bytes) {
        throw new Error("preview evidence tarball does not match the gate report");
    }
    const reactTarball = files.find(
        file => file.path === npmPackFilename(report.reactPackage.name, report.reactPackage.version)
    );
    if (!reactTarball || reactTarball.sha256 !== reactCandidate.digest || reactTarball.bytes !== reactCandidate.bytes) {
        throw new Error("preview evidence React tarball does not match the gate report");
    }
    return {
        schema: PREVIEW_EVIDENCE_MANIFEST_SCHEMA,
        candidate: { algorithm: "sha256", digest: candidate.digest, bytes: candidate.bytes },
        source: { gitSha: report.source?.gitSha ?? null, dirty: report.source?.dirty === true },
        files,
    };
}

export async function writePreviewEvidenceManifest(directory) {
    const root = path.resolve(directory);
    const manifest = await buildPreviewEvidenceManifest(root);
    const manifestPath = path.join(root, "evidence-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestBytes = await readFile(manifestPath);
    const sums = [
        ...manifest.files.map(file => `${file.sha256}  ${file.path}`),
        `${sha256(manifestBytes)}  evidence-manifest.json`,
    ];
    await writeFile(path.join(root, "SHA256SUMS"), `${sums.join("\n")}\n`);
    return manifest;
}

function parseArgs(argv) {
    if (argv.length !== 2 || argv[0] !== "--directory" || !argv[1]) {
        throw new Error("usage: finalize-preview-evidence --directory <passing-preview-output>");
    }
    return path.resolve(argv[1]);
}

if (import.meta.main) {
    const directory = parseArgs(process.argv.slice(2));
    const manifest = await writePreviewEvidenceManifest(directory);
    console.log(JSON.stringify({ directory, candidate: manifest.candidate, files: manifest.files.length }));
}
