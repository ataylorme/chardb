import type { CliContext } from "../context.ts";

export type ScheduleSub = "list" | "audit" | "replay";

export async function runSchedule(ctx: CliContext, sub: ScheduleSub): Promise<void> {
    switch (sub) {
        case "list":
            ctx.stdout("chardb schedule list: enumerate registered crons (foundation skeleton)\n");
            return;
        case "audit":
            ctx.stdout("chardb schedule audit: missed occurrences from _chardb_schedule_log (foundation skeleton)\n");
            return;
        case "replay":
            ctx.stdout("chardb schedule replay: backfill missed occurrences (foundation skeleton)\n");
            return;
    }
}
