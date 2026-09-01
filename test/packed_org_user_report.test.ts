import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJsonAtomically } from "../scripts/browser-proof-report.mjs";
import {
    PACKED_ORG_USER_CHECKS,
    PACKED_ORG_USER_REPORT_SCHEMA,
    assertMatchingPackedOrgUserReport,
    buildPackedOrgUserReport,
    parsePackedOrgUserArgs,
} from "../scripts/packed-org-user-report.mjs";

const fingerprint = { algorithm: "sha256" as const, digest: "a".repeat(64), bytes: 448_830 };
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function input() {
    return {
        package: { name: "@chardb/core" as const, version: "0.1.0", tarball: fingerprint },
        checks: Object.fromEntries(PACKED_ORG_USER_CHECKS.map(name => [name, true])) as Record<string, true>,
    };
}

describe("packed org-user evidence", () => {
    test("parses one tarball and an optional report path", () => {
        expect(parsePackedOrgUserArgs(["package.tgz"])).toEqual({ tarball: "package.tgz", reportPath: undefined });
        expect(parsePackedOrgUserArgs(["package.tgz", "--report", "proof.json"])).toEqual({
            tarball: "package.tgz",
            reportPath: "proof.json",
        });
        expect(() => parsePackedOrgUserArgs([])).toThrow("usage");
        expect(() => parsePackedOrgUserArgs(["a.tgz", "b.tgz"])).toThrow("one tarball");
        expect(() => parsePackedOrgUserArgs(["a.tgz", "--report"])).toThrow("requires a path");
        expect(() => parsePackedOrgUserArgs(["a.tgz", "--report", "one", "--report", "two"])).toThrow("only once");
        expect(() => parsePackedOrgUserArgs(["a.tgz", "--unknown"])).toThrow("unknown");
    });

    test("binds every successful check to one exact packed candidate", () => {
        const report = buildPackedOrgUserReport(input());
        expect(report).toEqual({
            schema: PACKED_ORG_USER_REPORT_SCHEMA,
            suite: "packed-org-user-consumer",
            package: { name: "@chardb/core", version: "0.1.0", tarball: fingerprint },
            checks: Object.fromEntries(PACKED_ORG_USER_CHECKS.map(name => [name, true])),
        });
        expect(assertMatchingPackedOrgUserReport(report, fingerprint)).toBe(report);
        expect(JSON.stringify(report)).not.toContain("/private/");
        expect(JSON.stringify(report).length).toBeLessThan(4_096);
    });

    test("rejects candidate drift, missing checks, false checks, and extra fields", () => {
        const report = buildPackedOrgUserReport(input());
        expect(() => assertMatchingPackedOrgUserReport(report, { ...fingerprint, digest: "b".repeat(64) })).toThrow(
            "expected tarball"
        );

        const { strictConsumerTypecheck: _missing, ...missing } = report.checks;
        expect(() => assertMatchingPackedOrgUserReport({ ...report, checks: missing }, fingerprint)).toThrow(
            "missing a required check"
        );
        expect(() =>
            assertMatchingPackedOrgUserReport(
                { ...report, checks: { ...report.checks, strictConsumerTypecheck: false } },
                fingerprint
            )
        ).toThrow("missing a required check");
        expect(() =>
            assertMatchingPackedOrgUserReport({ ...report, checks: { ...report.checks, invented: true } }, fingerprint)
        ).toThrow("missing a required check");
        expect(() => assertMatchingPackedOrgUserReport({ ...report, path: "/private/proof" }, fingerprint)).toThrow(
            "fields drifted"
        );
        expect(() =>
            assertMatchingPackedOrgUserReport(
                { ...report, package: { ...report.package, installToken: "secret" } },
                fingerprint
            )
        ).toThrow("fields drifted");
    });

    test("writes one bounded report atomically without leaving a temporary file", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "chardb-org-user-report-"));
        temporaryDirectories.push(directory);
        const file = path.join(directory, "org-user.json");
        await writeFile(file, "stale\n");

        const report = buildPackedOrgUserReport(input());
        await writeJsonAtomically(file, report);

        expect(JSON.parse(await readFile(file, "utf8"))).toEqual(report);
        expect(await readdir(directory)).toEqual(["org-user.json"]);
    });
});
