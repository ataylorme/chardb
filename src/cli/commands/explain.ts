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

    if (opts.intent.partitionKey && opts.intent.partitionKey.values.length === 1) {
        path = "partition-key";
        fanoutEstimate = 1;
    } else if (opts.intent.joinShape === "cross-partition") {
        notes.push("CdbIntent.joinShape='cross-partition' — server merges via top-K / partial-aggregate");
        if (opts.strict) notes.push("--strict: scatter shape requires .acceptApproximate() (CDB_SCATTER_NOT_INDEX)");
    }

    ctx.stdout(
        `chardb explain: path=${path} fanout~${fanoutEstimate}${notes.length ? `\n  - ${notes.join("\n  - ")}` : ""}\n`
    );
    return { path, fanoutEstimate, notes };
}
