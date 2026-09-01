import { isDeepStrictEqual } from "node:util";
import { assertBrowserProofReport } from "./browser-proof-report.mjs";

export function assertMatchingBrowserReport(browser, fingerprint, reactFingerprint) {
    assertBrowserProofReport(browser);
    if (!isDeepStrictEqual(browser.package?.tarball, fingerprint)) {
        throw new Error("browser evidence does not identify the candidate tarball");
    }
    if (
        browser.reactPackage?.name !== "@chardb/react" ||
        (reactFingerprint !== undefined && !isDeepStrictEqual(browser.reactPackage?.tarball, reactFingerprint))
    ) {
        throw new Error("browser evidence does not identify the candidate React tarball");
    }
    return browser;
}
