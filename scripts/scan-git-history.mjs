const MAX_BLOB_BYTES = 32 * 1024 * 1024;

const RULES = [
    ["private-key", /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/],
    ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/],
    ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
    ["stripe-live-key", /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/],
    ["openai-key", /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/],
    ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
];

function runGit(args, input) {
    const result = Bun.spawnSync(["git", ...args], {
        stdin: input === undefined ? undefined : Buffer.from(input),
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
    }
    return result.stdout;
}

export function scanSecretText(text) {
    return RULES.filter(([, expression]) => expression.test(text)).map(([name]) => name);
}

export function scanGitHistory() {
    const objectLines = runGit(["rev-list", "--objects", "--all"]).toString().split("\n").filter(Boolean);
    const paths = new Map();
    for (const line of objectLines) {
        const separator = line.indexOf(" ");
        const objectId = separator === -1 ? line : line.slice(0, separator);
        if (!paths.has(objectId)) paths.set(objectId, separator === -1 ? "<unknown>" : line.slice(separator + 1));
    }
    const objectIds = [...paths.keys()];
    const metadata = runGit(
        ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        `${objectIds.join("\n")}\n`
    )
        .toString()
        .split("\n")
        .filter(Boolean);
    const findings = [];
    let scannedBlobs = 0;
    let scannedBytes = 0;
    for (const line of metadata) {
        const [objectId, type, rawSize] = line.split(" ");
        if (!objectId || type !== "blob") continue;
        const size = Number(rawSize);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_BYTES) {
            throw new Error(`cannot safely scan Git blob ${objectId} with size ${rawSize}`);
        }
        const content = runGit(["cat-file", "blob", objectId]);
        scannedBlobs++;
        scannedBytes += content.byteLength;
        if (content.includes(0)) continue;
        const rules = scanSecretText(content.toString("utf8"));
        for (const rule of rules) findings.push({ rule, objectId, path: paths.get(objectId) ?? "<unknown>" });
    }
    return {
        commits: Number(runGit(["rev-list", "--all", "--count"]).toString().trim()),
        scannedBlobs,
        scannedBytes,
        findings,
    };
}

if (import.meta.main) {
    const result = scanGitHistory();
    if (result.findings.length > 0) {
        for (const finding of result.findings) {
            console.error(`${finding.rule}: ${finding.objectId} ${finding.path}`);
        }
        console.error(`history secret scan failed with ${result.findings.length} high-confidence finding(s)`);
        process.exit(1);
    }
    console.info(JSON.stringify({ type: "chardb-history-secret-scan", ...result }));
}
