import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const CI_CANDIDATE_SCHEMA = "chardb.ci-candidate.v1";
export const CI_CANDIDATE_TARBALL = "candidate.tgz";
export const CI_CANDIDATE_MANIFEST = "candidate.json";

const SHA256 = /^[a-f0-9]{64}$/;

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
    check(isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort()), `${label} fields drifted`);
}

async function secureDirectory(directory, { create = false } = {}) {
    const resolved = path.resolve(directory);
    if (create) {
        await mkdir(resolved).catch(error => {
            if (error?.code !== "EEXIST") throw error;
        });
    }
    const metadata = await lstat(resolved).catch(error => {
        if (error?.code === "ENOENT") throw new Error("CI candidate directory is missing");
        throw error;
    });
    check(metadata.isDirectory() && !metadata.isSymbolicLink(), "CI candidate must be a directory, not a symlink");
    return realpath(resolved);
}

async function secureFile(file, label) {
    const resolved = path.resolve(file);
    const metadata = await lstat(resolved).catch(error => {
        if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
        throw error;
    });
    check(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file`);
    return realpath(resolved);
}

async function fingerprint(file) {
    const bytes = await readFile(file);
    return {
        algorithm: "sha256",
        digest: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
    };
}

function assertFingerprint(value) {
    exactKeys(value, ["algorithm", "digest", "bytes"], "CI candidate fingerprint");
    check(value.algorithm === "sha256", "CI candidate fingerprint algorithm must be sha256");
    check(SHA256.test(value.digest ?? ""), "CI candidate fingerprint digest is invalid");
    check(Number.isSafeInteger(value.bytes) && value.bytes > 0, "CI candidate fingerprint byte count is invalid");
}

export async function stageCiCandidate(tarball, directory) {
    const source = await secureFile(tarball, "CI candidate source tarball");
    const root = await secureDirectory(directory, { create: true });
    check((await readdir(root)).length === 0, "CI candidate output directory must be empty");
    const destination = path.join(root, CI_CANDIDATE_TARBALL);
    check(source !== destination, "CI candidate source must be outside the output directory");
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const candidate = await fingerprint(destination);
    const manifest = { schema: CI_CANDIDATE_SCHEMA, file: CI_CANDIDATE_TARBALL, candidate };
    await writeFile(path.join(root, CI_CANDIDATE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
    });
    return { root, tarball: destination, candidate };
}

export async function validateCiCandidate(directory) {
    const root = await secureDirectory(directory);
    const names = (await readdir(root)).sort();
    check(
        isDeepStrictEqual(names, [CI_CANDIDATE_MANIFEST, CI_CANDIDATE_TARBALL].sort()),
        "CI candidate directory must contain exactly candidate.json and candidate.tgz"
    );
    const tarball = await secureFile(path.join(root, CI_CANDIDATE_TARBALL), "CI candidate tarball");
    const manifestPath = await secureFile(path.join(root, CI_CANDIDATE_MANIFEST), "CI candidate manifest");
    let manifest;
    try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
        throw new Error("CI candidate manifest is not valid JSON");
    }
    exactKeys(manifest, ["schema", "file", "candidate"], "CI candidate manifest");
    check(manifest.schema === CI_CANDIDATE_SCHEMA, `CI candidate schema must be ${CI_CANDIDATE_SCHEMA}`);
    check(manifest.file === CI_CANDIDATE_TARBALL, `CI candidate file must be ${CI_CANDIDATE_TARBALL}`);
    assertFingerprint(manifest.candidate);
    const candidate = await fingerprint(tarball);
    check(isDeepStrictEqual(candidate, manifest.candidate), "CI candidate tarball does not match its manifest");
    return { root, tarball, candidate };
}

async function main(argv) {
    let mode;
    let tarball;
    let directory;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--stage") {
            check(mode === undefined, "CI candidate mode may be provided only once");
            mode = "stage";
            tarball = argv[++index];
            check(Boolean(tarball), "--stage requires a tarball");
        } else if (argument === "--verify") {
            check(mode === undefined, "CI candidate mode may be provided only once");
            mode = "verify";
        } else if (argument === "--directory") {
            check(directory === undefined, "--directory may be provided only once");
            directory = argv[++index];
            check(Boolean(directory), "--directory requires a path");
        } else {
            throw new Error(`unknown CI candidate argument ${JSON.stringify(argument)}`);
        }
    }
    check(
        mode !== undefined && directory !== undefined,
        "usage: ci-candidate-artifact (--stage <tgz> | --verify) --directory <path>"
    );
    const result = mode === "stage" ? await stageCiCandidate(tarball, directory) : await validateCiCandidate(directory);
    process.stdout.write(`${JSON.stringify({ tarball: result.tarball, candidate: result.candidate })}\n`);
}

if (import.meta.main) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`CI candidate failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
