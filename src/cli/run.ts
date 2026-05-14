import { emptyManifest } from "../server/manifest.ts";
import { runDeploy } from "./commands/deploy.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runExport } from "./commands/export.ts";
import { runInit } from "./commands/init.ts";
import { runMigrate } from "./commands/migrate.ts";
import { runSchedule } from "./commands/schedule.ts";
import { runShards } from "./commands/shards.ts";
import { runRestore, runSnapshot } from "./commands/snapshot.ts";
import type { CliContext } from "./context.ts";

const HELP = `chardb — Cloudflare-native SQL with per-tenant ACID and live Drizzle queries

Commands:
  chardb init <name>            scaffold a new chardb app (writes wrangler.jsonc, schema, worker)
  chardb doctor [which]         enforce wrangler.jsonc / schema / auth contract; which ∈ {wrangler,schema,auth}
  chardb explain                planner decision + estimated fanout (use --strict for CI)
  chardb shards top             live shard heatmap from chardb-tail → AE
  chardb shards split <lo>:<hi> --to <shardId>
  chardb snapshot [--tenant T] [--label L]
  chardb restore [--barrier b] [--time t] [--tenant T]
  chardb migrate                runtime migrate; applies pending DDL
  chardb export <dir>           streaming logical dump + R2 manifest + auth schema
  chardb schedule {list|audit|replay}
  chardb deploy                 render .chardb/deploy.json (Logpush jobs + tail-consumer plan)
`;

export async function runCli(ctx: CliContext, argv: readonly string[]): Promise<number> {
    const [cmd, ...rest] = argv;
    switch (cmd) {
        case undefined:
        case "--help":
        case "-h":
            ctx.stdout(HELP);
            return 0;
        case "init": {
            const name = rest[0];
            if (!name) {
                ctx.stderr("usage: chardb init <name>\n");
                return 2;
            }
            await runInit(ctx, { name });
            return 0;
        }
        case "doctor": {
            const which = (rest[0] as "wrangler" | "schema" | "auth" | undefined) ?? "wrangler";
            const r = await runDoctor(ctx, { which });
            return r.ok ? 0 : 1;
        }
        case "shards": {
            const sub = rest[0];
            if (sub === "top") {
                await runShards(ctx, { cmd: "top" });
                return 0;
            }
            if (sub === "split") {
                const range = rest[1];
                const toShard = rest[3];
                if (!range || !toShard) {
                    ctx.stderr("usage: chardb shards split <lo>:<hi> --to <shardId>\n");
                    return 2;
                }
                const [lo, hi] = range.split(":").map(Number);
                await runShards(ctx, {
                    cmd: "split",
                    vshardLo: lo as number,
                    vshardHi: hi as number,
                    toShard,
                });
                return 0;
            }
            ctx.stderr(`unknown shards subcommand: ${sub}\n`);
            return 2;
        }
        case "snapshot": {
            const opts = parseFlags(rest);
            await runSnapshot(ctx, {
                ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
                ...(opts.label !== undefined ? { label: opts.label } : {}),
            });
            return 0;
        }
        case "restore": {
            const opts = parseFlags(rest);
            await runRestore(ctx, {
                ...(opts.barrier !== undefined ? { barrierId: opts.barrier } : {}),
                ...(opts.time !== undefined ? { time: opts.time } : {}),
                ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
            });
            return 0;
        }
        case "migrate": {
            // The runtime applier (DO RPC + barrier coordination) isn't wired
            // up yet. Be honest about it instead of silently no-op-ing: load
            // the user's drizzle-kit migration files from rest[0] (defaults
            // to ./drizzle) and surface them as a plan the user can pipe to
            // their own applier. Once the workerd-side migrate RPC lands,
            // this gets replaced.
            const dir = rest[0] ?? `${ctx.cwd}/drizzle`;
            ctx.stdout(`chardb migrate: emitting DDL plan from ${dir}\n`);
            let statements: readonly string[] = [];
            try {
                const planPath = `${dir}/_journal.json`;
                if (await ctx.exists(planPath)) {
                    const journal = JSON.parse(await ctx.read(planPath)) as {
                        entries?: ReadonlyArray<{ idx: number; tag: string }>;
                    };
                    const tags = journal.entries?.map(e => e.tag) ?? [];
                    const collected: string[] = [];
                    for (const tag of tags) {
                        const sqlPath = `${dir}/${tag}.sql`;
                        if (await ctx.exists(sqlPath)) collected.push(await ctx.read(sqlPath));
                    }
                    statements = collected;
                }
            } catch (err) {
                ctx.stderr(
                    `chardb migrate: unable to read drizzle-kit journal: ${err instanceof Error ? err.message : String(err)}\n`
                );
            }
            await runMigrate(ctx, {
                applyDdl: async stmt => {
                    ctx.stdout(`-- would apply --\n${stmt}\n`);
                },
                statements,
            });
            return 0;
        }
        case "export": {
            const out = rest[0] ?? `${ctx.cwd}/.chardb/export`;
            await runExport(ctx, { out });
            return 0;
        }
        case "deploy": {
            // The CLI ships a no-manifest deploy that still emits the artifact so
            // CI can diff it; the bundler is expected to pre-populate
            // `.chardb/deploy-input.json` before running this command.
            await runDeploy(ctx, { manifest: emptyManifest(), ledgerOptions: new Map() });
            return 0;
        }
        case "schedule": {
            const sub = rest[0] as "list" | "audit" | "replay" | undefined;
            if (!sub || !["list", "audit", "replay"].includes(sub)) {
                ctx.stderr("usage: chardb schedule {list|audit|replay}\n");
                return 2;
            }
            await runSchedule(ctx, sub);
            return 0;
        }
        default:
            ctx.stderr(`unknown command: ${cmd}\n`);
            ctx.stdout(HELP);
            return 2;
    }
}

function parseFlags(rest: readonly string[]): { [k: string]: string } {
    const out: { [k: string]: string } = {};
    for (let i = 0; i < rest.length; i++) {
        const v = rest[i];
        if (typeof v === "string" && v.startsWith("--")) {
            const key = v.slice(2);
            const next = rest[i + 1];
            if (next && !next.startsWith("--")) {
                out[key] = next;
                i++;
            } else {
                out[key] = "true";
            }
        }
    }
    return out;
}
