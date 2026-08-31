import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    CI_CANDIDATE_MANIFEST,
    CI_CANDIDATE_TARBALL,
    stageCiCandidate,
    validateCiCandidate,
} from "../scripts/ci-candidate-artifact.mjs";

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "chardb-ci-candidate-"));
    const source = path.join(root, "source.tgz");
    const directory = path.join(root, "artifact");
    await writeFile(source, "exact candidate bytes");
    const staged = await stageCiCandidate(source, directory);
    return { root, source, directory, staged };
}

describe("cross-OS CI candidate artifact", () => {
    test("stages and verifies one exact candidate with a portable fixed path", async () => {
        const value = await fixture();
        try {
            const verified = await validateCiCandidate(value.directory);
            expect(verified.tarball).toBe(path.join(verified.root, CI_CANDIDATE_TARBALL));
            expect(verified.candidate).toEqual(value.staged.candidate);
            expect(JSON.parse(await readFile(path.join(value.directory, CI_CANDIDATE_MANIFEST), "utf8"))).toEqual({
                schema: "chardb.ci-candidate.v1",
                file: CI_CANDIDATE_TARBALL,
                candidate: value.staged.candidate,
            });
        } finally {
            await rm(value.root, { recursive: true, force: true });
        }
    });

    test("rejects changed candidate bytes and padded artifacts", async () => {
        const changed = await fixture();
        try {
            await writeFile(path.join(changed.directory, CI_CANDIDATE_TARBALL), "different bytes");
            await expect(validateCiCandidate(changed.directory)).rejects.toThrow("does not match its manifest");
        } finally {
            await rm(changed.root, { recursive: true, force: true });
        }

        const padded = await fixture();
        try {
            await writeFile(path.join(padded.directory, "extra.txt"), "not part of the handoff");
            await expect(validateCiCandidate(padded.directory)).rejects.toThrow("must contain exactly");
        } finally {
            await rm(padded.root, { recursive: true, force: true });
        }
    });

    test("rejects a symlink substituted for the candidate", async () => {
        const value = await fixture();
        try {
            await rm(path.join(value.directory, CI_CANDIDATE_TARBALL));
            await symlink(value.source, path.join(value.directory, CI_CANDIDATE_TARBALL));
            await expect(validateCiCandidate(value.directory)).rejects.toThrow("regular file");
        } finally {
            await rm(value.root, { recursive: true, force: true });
        }
    });
});
