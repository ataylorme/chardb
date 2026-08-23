import type { CdbIntent } from "../../wire.ts";
import type { CliContext } from "../context.ts";

export interface ExplainOptions {
    readonly intent: CdbIntent;
    readonly strict?: boolean;
    readonly prod?: boolean;
}

export interface ExplainResult {
    readonly path: "partition-key" | "scatter" | "gsi" | "rejected";
    readonly fanoutEstimate: number;
    readonly notes: readonly string[];
}

export async function runExplain(ctx: CliContext, opts: ExplainOptions): Promise<ExplainResult> {
    const notes: string[] = [];
    let path: ExplainResult["path"] = "scatter";
    let fanoutEstimate = 32;

    if (
        opts.intent.joinShape !== "cross-partition" &&
        opts.intent.partitionKey &&
        opts.intent.partitionKey.values.length > 0
    ) {
        path = "partition-key";
        fanoutEstimate = new Set(opts.intent.partitionKey.values.map(value => JSON.stringify(value))).size;
    } else if (opts.intent.joinShape === "cross-partition") {
        notes.push("CdbIntent.joinShape='cross-partition' — server merges via top-K / partial-aggregate");
    }

    if (opts.prod && path === "scatter") {
        notes.push("--prod: estimate uses the default 32-shard topology because no deployed range map was supplied");
    }
    if (opts.strict && path === "scatter") {
        path = "rejected";
        notes.push("--strict: scatter plan rejected (CDB_SCATTER_NOT_INDEX)");
    }

    ctx.stdout(
        `chardb explain: path=${path} fanout~${fanoutEstimate}${notes.length ? `\n  - ${notes.join("\n  - ")}` : ""}\n`
    );
    return { path, fanoutEstimate, notes };
}
