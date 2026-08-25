import { describe, expect, test } from "bun:test";
import { scanSecretText } from "../scripts/scan-git-history.mjs";

describe("history secret scanner", () => {
    test("finds high-confidence credentials without printing their values", () => {
        expect(scanSecretText(["AKIA", "ABCDEFGHIJKLMNOP"].join(""))).toEqual(["aws-access-key"]);
        expect(scanSecretText(["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join(""))).toEqual(["github-token"]);
        expect(scanSecretText(["-----BEGIN ", "PRIVATE KEY-----"].join(""))).toEqual(["private-key"]);
    });

    test("does not flag ordinary fixture credentials", () => {
        expect(scanSecretText("not-a-jwt test-password bearer-token fixture-secret")).toEqual([]);
    });
});
