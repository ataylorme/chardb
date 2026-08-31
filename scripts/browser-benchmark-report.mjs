import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const BROWSER_REPORT_SCHEMA = "chardb.packed-browser.report.v1";
export const MAX_BROWSER_SAMPLES = 100;
export const MAX_BROWSER_WARMUP_SAMPLES = 20;

const PROFILES = {
    smoke: { samples: 3, warmupSamples: 0 },
    benchmark: { samples: 25, warmupSamples: 1 },
};

function parseBoundedInteger(name, raw, minimum, maximum) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
        throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
    }
    return value;
}

export function parseBrowserSamplePlan(profileName, sampleOverride, warmupOverride) {
    const profile = PROFILES[profileName];
    if (profile === undefined) throw new Error(`unknown CDB_BROWSER_E2E_PROFILE ${JSON.stringify(profileName)}`);
    const samples = parseBoundedInteger(
        "CDB_BROWSER_E2E_SAMPLES",
        sampleOverride ?? String(profile.samples),
        1,
        MAX_BROWSER_SAMPLES
    );
    const warmupSamples = parseBoundedInteger(
        "CDB_BROWSER_E2E_WARMUP_SAMPLES",
        warmupOverride ?? String(profile.warmupSamples),
        0,
        MAX_BROWSER_WARMUP_SAMPLES
    );
    return { name: profileName, samples, warmupSamples };
}

export function summarizeBrowserTimings(values) {
    if (values.length === 0) throw new Error("cannot summarize an empty timing sample");
    if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        throw new Error("browser timings must be finite non-negative numbers");
    }
    const sorted = [...values].sort((left, right) => left - right);
    return {
        minimum: sorted[0],
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        maximum: sorted.at(-1),
        mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    };
}

function browserTimingRecord(sample, index) {
    const timings = {
        authReadyMs: sample.authReadyMs,
        initialQueryMs: sample.initialQueryMs,
        mutationAckMs: sample.mutationAckMs,
        liveUpdateMs: sample.liveUpdateMs,
    };
    for (const [name, value] of Object.entries(timings)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new Error(`browser sample ${index} has invalid ${name}`);
        }
    }
    return {
        index,
        timingsMs: {
            authReady: timings.authReadyMs,
            initialQuery: timings.initialQueryMs,
            mutationAck: timings.mutationAckMs,
            liveUpdate: timings.liveUpdateMs,
        },
    };
}

export function buildBrowserMeasurement(samples, warmups, restart) {
    if (samples.length === 0) throw new Error("browser measurement requires at least one sample");
    for (const [name, value] of Object.entries(restart)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new Error(`browser restart has invalid ${name}`);
        }
    }
    return {
        clock: "performance.now",
        unit: "milliseconds",
        warmups: warmups.map(browserTimingRecord),
        samples: samples.map(browserTimingRecord),
        restart: { ...restart },
        summaries: {
            authReadyMs: summarizeBrowserTimings(samples.map(sample => sample.authReadyMs)),
            initialQueryMs: summarizeBrowserTimings(samples.map(sample => sample.initialQueryMs)),
            mutationAckMs: summarizeBrowserTimings(samples.map(sample => sample.mutationAckMs)),
            liveUpdateMs: summarizeBrowserTimings(samples.map(sample => sample.liveUpdateMs)),
        },
    };
}

function percentile(sorted, fraction) {
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export async function fingerprintFile(file) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const metadata = await stat(file);
    return { algorithm: "sha256", digest: hash.digest("hex"), bytes: metadata.size };
}

export function defaultBrowserReportPath(tarballPath) {
    return `${tarballPath}.browser-e2e.json`;
}

export async function writeJsonAtomically(file, value) {
    const absolute = path.resolve(file);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        await rename(temporary, absolute);
    } finally {
        await rm(temporary, { force: true });
    }
    return absolute;
}
