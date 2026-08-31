import { describe, expect, test } from "bun:test";
import { parsePublicVectorBenchmarkProducerArgs } from "../scripts/produce-public-vector-benchmark.mjs";
import {
    parsePublicVectorBenchmarkArgs,
    publicVectorBenchmarkProducerArgs,
    publicVectorBenchmarkRunPlan,
} from "../scripts/run-public-vector-benchmark.mjs";

describe("public vector benchmark runner", () => {
    test("uses one excluded warmup and the fixed profile sample count", () => {
        expect(publicVectorBenchmarkRunPlan("ci")).toEqual([
            { sequence: -1, excluded: true, filename: "warmup.json" },
            { sequence: 0, excluded: false, filename: "sample-0.json" },
            { sequence: 1, excluded: false, filename: "sample-1.json" },
            { sequence: 2, excluded: false, filename: "sample-2.json" },
        ]);
        expect(
            publicVectorBenchmarkProducerArgs(
                "/repo/scripts/producer.mjs",
                { sequence: 2, excluded: false, filename: "sample-2.json" },
                "ci"
            )
        ).toEqual(["/repo/scripts/producer.mjs", "--profile", "ci", "--sequence", "2", "--excluded", "false"]);
    });

    test("parses bounded local runner arguments", () => {
        expect(
            parsePublicVectorBenchmarkArgs([
                "--producer",
                "scripts/producer.mjs",
                "--output-dir",
                "/tmp/evidence",
                "--profile",
                "standard",
            ])
        ).toMatchObject({
            help: false,
            profileName: "standard",
        });
        expect(() =>
            parsePublicVectorBenchmarkArgs(["--producer", "x", "--output-dir", "y", "--profile", "huge"])
        ).toThrow(/unknown profile/);
        expect(() =>
            parsePublicVectorBenchmarkArgs(["--producer", "x", "--output-dir", "y", "--target", "cloudflare"])
        ).toThrow(/unknown public vector benchmark argument/);
        expect(
            parsePublicVectorBenchmarkProducerArgs(["--profile", "ci", "--sequence", "-1", "--excluded", "true"])
        ).toMatchObject({ profileName: "ci", sequence: -1, excluded: true });
        expect(() => parsePublicVectorBenchmarkProducerArgs(["--target", "cloudflare"])).toThrow(
            /unknown public vector producer argument/
        );
    });
});
