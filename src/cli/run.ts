import { runDoctor } from "./commands/doctor.ts";
import { runExplain } from "./commands/explain.ts";
import { runInit } from "./commands/init.ts";
import { runMigrate } from "./commands/migrate.ts";
import type { CliContext } from "./context.ts";

const HELP = `chardb — experimental tenant-sharding prototype for Cloudflare Durable Objects

Commands:
  chardb init <name>            scaffold a new chardb app (writes wrangler.toml, schema, worker)
  chardb doctor [wrangler]      validate wrangler.toml or wrangler.jsonc
  chardb explain <intent-json>  planner decision + estimated fanout (use --strict for CI)
  chardb shards ...             not implemented
  chardb snapshot ...           not implemented
  chardb restore ...            not implemented
  chardb migrate --url <worker> --id <id> --target <version> [--concurrency <1-32>] [--baseline]
  chardb export ...             not implemented
  chardb schedule ...           not implemented
  chardb deploy ...             not implemented
`;

const NOT_IMPLEMENTED = new Set(["deploy", "shards", "snapshot", "restore", "export", "schedule"]);

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
            const which = rest[0] ?? "wrangler";
            if (!isDoctorTarget(which)) {
                ctx.stderr("usage: chardb doctor [wrangler|schema|auth]\n");
                return 2;
            }
            const r = await runDoctor(ctx, { which });
            return r.ok ? 0 : 1;
        }
        case "explain": {
            const rawIntent = valueAfterFlag(rest, "--intent") ?? rest.find(v => !v.startsWith("--"));
            if (!rawIntent) {
                ctx.stderr("usage: chardb explain '<intent-json>' [--strict] [--prod]\n");
                return 2;
            }
            let intent: import("../wire.ts").CdbIntent;
            try {
                intent = parseIntent(rawIntent);
            } catch (err) {
                ctx.stderr(`chardb explain: ${err instanceof Error ? err.message : String(err)}\n`);
                return 2;
            }
            const result = await runExplain(ctx, {
                intent,
                strict: rest.includes("--strict"),
                prod: rest.includes("--prod"),
            });
            return result.path === "rejected" ? 1 : 0;
        }
        case "migrate": {
            const baseUrl = valueAfterFlag(rest, "--url") ?? ctx.env.CHARDB_URL;
            const migrationId = valueAfterFlag(rest, "--id");
            const rawTarget = valueAfterFlag(rest, "--target");
            const rawConcurrency = valueAfterFlag(rest, "--concurrency") ?? "4";
            const token = ctx.env.CHARDB_ADMIN_TOKEN;
            if (!baseUrl || !migrationId || !rawTarget || !token || !ctx.fetch) {
                ctx.stderr(
                    "usage: CHARDB_ADMIN_TOKEN=<secret> chardb migrate --url <worker> --id <id> --target <version> [--concurrency <1-32>] [--baseline]\n"
                );
                return 2;
            }
            const targetVersion = Number(rawTarget);
            const concurrency = Number(rawConcurrency);
            try {
                await runMigrate(ctx, {
                    baseUrl,
                    token,
                    migrationId,
                    targetVersion,
                    concurrency,
                    baseline: rest.includes("--baseline"),
                    fetch: ctx.fetch,
                });
                return 0;
            } catch (error) {
                ctx.stderr(`chardb migrate: ${error instanceof Error ? error.message : String(error)}\n`);
                return 1;
            }
        }
        default:
            if (NOT_IMPLEMENTED.has(cmd)) {
                ctx.stderr(`chardb ${cmd}: not implemented in this release\n`);
                return 1;
            }
            ctx.stderr(`unknown command: ${cmd}\n`);
            ctx.stdout(HELP);
            return 2;
    }
}

function isDoctorTarget(value: string): value is "wrangler" | "schema" | "auth" {
    return value === "wrangler" || value === "schema" || value === "auth";
}

function valueAfterFlag(argv: readonly string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

function parseIntent(raw: string): import("../wire.ts").CdbIntent {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("intent must be a JSON object");
    }
    const intent = value as Record<string, unknown>;
    if (!["select", "insert", "update", "delete", "execute"].includes(String(intent.kind))) {
        throw new TypeError("intent.kind must be select, insert, update, delete, or execute");
    }
    if (!Array.isArray(intent.tables) || !intent.tables.every(table => typeof table === "string")) {
        throw new TypeError("intent.tables must be an array of table names");
    }
    if (intent.partitionKey !== undefined) {
        const key = intent.partitionKey;
        if (key === null || typeof key !== "object" || Array.isArray(key)) {
            throw new TypeError("intent.partitionKey must be an object");
        }
        const record = key as Record<string, unknown>;
        if (typeof record.table !== "string" || typeof record.column !== "string" || !Array.isArray(record.values)) {
            throw new TypeError("intent.partitionKey requires table, column, and values");
        }
    }
    return value as import("../wire.ts").CdbIntent;
}
