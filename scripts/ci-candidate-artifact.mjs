import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const CI_CANDIDATE_SCHEMA = "chardb.ci-candidate.v2";
export const CI_CANDIDATE_TARBALL = "core.tgz";
export const CI_CANDIDATE_REACT_TARBALL = "react.tgz";
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

export async function stageCiCandidate(coreTarball, reactTarball, directory) {
    const coreSource = await secureFile(coreTarball, "CI core candidate source tarball");
    const reactSource = await secureFile(reactTarball, "CI React candidate source tarball");
    check(coreSource !== reactSource, "CI core and React candidates must be different files");
    const root = await secureDirectory(directory, { create: true });
    check((await readdir(root)).length === 0, "CI candidate output directory must be empty");
    const coreDestination = path.join(root, CI_CANDIDATE_TARBALL);
    const reactDestination = path.join(root, CI_CANDIDATE_REACT_TARBALL);
    check(
        coreSource !== coreDestination && reactSource !== reactDestination,
        "CI candidate sources must be outside the output directory"
    );
    await copyFile(coreSource, coreDestination, constants.COPYFILE_EXCL);
    await copyFile(reactSource, reactDestination, constants.COPYFILE_EXCL);
    const core = await fingerprint(coreDestination);
    const react = await fingerprint(reactDestination);
    const manifest = {
        schema: CI_CANDIDATE_SCHEMA,
        packages: {
            core: { name: "@chardb/core", file: CI_CANDIDATE_TARBALL, candidate: core },
            react: { name: "@chardb/react", file: CI_CANDIDATE_REACT_TARBALL, candidate: react },
        },
    };
    await writeFile(path.join(root, CI_CANDIDATE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
    });
    return { root, coreTarball: coreDestination, reactTarball: reactDestination, packages: manifest.packages };
}

export async function validateCiCandidate(directory) {
    const root = await secureDirectory(directory);
    const names = (await readdir(root)).sort();
    check(
        isDeepStrictEqual(names, [CI_CANDIDATE_MANIFEST, CI_CANDIDATE_TARBALL, CI_CANDIDATE_REACT_TARBALL].sort()),
        "CI candidate directory must contain exactly candidate.json, core.tgz, and react.tgz"
    );
    const coreTarball = await secureFile(path.join(root, CI_CANDIDATE_TARBALL), "CI core candidate tarball");
    const reactTarball = await secureFile(path.join(root, CI_CANDIDATE_REACT_TARBALL), "CI React candidate tarball");
    const manifestPath = await secureFile(path.join(root, CI_CANDIDATE_MANIFEST), "CI candidate manifest");
    let manifest;
    try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
        throw new Error("CI candidate manifest is not valid JSON");
    }
    exactKeys(manifest, ["schema", "packages"], "CI candidate manifest");
    check(manifest.schema === CI_CANDIDATE_SCHEMA, `CI candidate schema must be ${CI_CANDIDATE_SCHEMA}`);
    exactKeys(manifest.packages, ["core", "react"], "CI candidate packages");
    for (const [key, name, file] of [
        ["core", "@chardb/core", CI_CANDIDATE_TARBALL],
        ["react", "@chardb/react", CI_CANDIDATE_REACT_TARBALL],
    ]) {
        exactKeys(manifest.packages[key], ["name", "file", "candidate"], `CI ${key} package`);
        check(manifest.packages[key].name === name, `CI ${key} package name must be ${name}`);
        check(manifest.packages[key].file === file, `CI ${key} package file must be ${file}`);
        assertFingerprint(manifest.packages[key].candidate);
    }
    const core = await fingerprint(coreTarball);
    const react = await fingerprint(reactTarball);
    check(
        isDeepStrictEqual(core, manifest.packages.core.candidate),
        "CI core candidate tarball does not match its manifest"
    );
    check(
        isDeepStrictEqual(react, manifest.packages.react.candidate),
        "CI React candidate tarball does not match its manifest"
    );
    return { root, coreTarball, reactTarball, packages: manifest.packages };
}

async function main(argv) {
    let mode;
    let coreTarball;
    let reactTarball;
    let directory;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--stage") {
            check(mode === undefined, "CI candidate mode may be provided only once");
            mode = "stage";
            coreTarball = argv[++index];
            check(Boolean(coreTarball), "--stage requires a core tarball");
        } else if (argument === "--react") {
            reactTarball = argv[++index];
            check(Boolean(reactTarball), "--react requires a tarball");
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
        "usage: ci-candidate-artifact (--stage <core.tgz> --react <react.tgz> | --verify) --directory <path>"
    );
    if (mode === "stage") check(Boolean(reactTarball), "--stage requires --react <react.tgz>");
    const result =
        mode === "stage"
            ? await stageCiCandidate(coreTarball, reactTarball, directory)
            : await validateCiCandidate(directory);
    process.stdout.write(
        `${JSON.stringify({ coreTarball: result.coreTarball, reactTarball: result.reactTarball, packages: result.packages })}\n`
    );
}

if (import.meta.main) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`CI candidate failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
