import type { CliContext } from "../context.ts";

export type ShardsSubcommand =
    | { readonly cmd: "top" }
    | {
          readonly cmd: "split";
          readonly vshardLo: number;
          readonly vshardHi: number;
          readonly toShard: string;
      };

export async function runShards(ctx: CliContext, sub: ShardsSubcommand): Promise<void> {
    switch (sub.cmd) {
        case "top":
            ctx.stdout(
                `chardb shards top: planned read from chardb-tail Worker → Workers Analytics Engine (lag ~5–60s).
  shard_id      class    region   colo   cpu_ms   wall_ms   ops/s   err   oplog_bytes   oplog_conflict_rate
(not yet implemented — the schema above documents the intended row shape.)
`
            );
            return;
        case "split":
            ctx.stdout(
                `chardb shards split: planned orchestration of Resharder migration of vshards [${sub.vshardLo}, ${sub.vshardHi}] → ${sub.toShard}
(not yet implemented — \`src/server/do/resharder.ts\` exposes the runtime RPCs the CLI will call.)
`
            );
            return;
    }
}
