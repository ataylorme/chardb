import type { CliContext } from "../context.ts";

export interface MigrateOptions {
    readonly applyDdl: (stmt: string) => Promise<void>;
    readonly statements: readonly string[];
}

export async function runMigrate(ctx: CliContext, opts: MigrateOptions): Promise<void> {
    for (const s of opts.statements) {
        if (!s.trim()) continue;
        await opts.applyDdl(s);
        ctx.stdout(`migrated: ${s.split(/\s+/).slice(0, 3).join(" ")}…\n`);
    }
}
