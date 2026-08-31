import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareChatBenchmarkReports } from "./chat-benchmark-report.mjs";

function value(argv, flag) {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const localPath = value(argv, "--local");
const deployedPath = value(argv, "--deployed");
const outputPath = value(argv, "--output");
if (!localPath || !deployedPath || !outputPath || argv.length !== 6) {
    throw new Error("usage: compare-chat-benchmark --local <report> --deployed <report> --output <report>");
}
const comparison = compareChatBenchmarkReports(
    JSON.parse(await readFile(path.resolve(localPath), "utf8")),
    JSON.parse(await readFile(path.resolve(deployedPath), "utf8"))
);
await writeFile(path.resolve(outputPath), `${JSON.stringify(comparison, null, 2)}\n`);
console.log(JSON.stringify(comparison));
