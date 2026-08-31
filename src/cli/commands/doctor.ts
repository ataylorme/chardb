import type { CliContext } from "../context.ts";
import { type DoctorResult, checkWrangler } from "../wrangler_template.ts";

export async function runDoctor(ctx: CliContext): Promise<DoctorResult> {
    const candidates = [`${ctx.cwd}/wrangler.toml`, `${ctx.cwd}/wrangler.json`, `${ctx.cwd}/wrangler.jsonc`];
    const path = await firstExisting(ctx, candidates);
    if (!path) {
        return {
            ok: false,
            errors: [`Wrangler config not found at ${candidates.join(" or ")}; run \`chardb init\``],
            warnings: [],
        };
    }
    const text = await ctx.read(path);
    const r = checkWrangler(text);
    for (const e of r.errors) ctx.stderr(`error: ${e}\n`);
    for (const w of r.warnings) ctx.stderr(`warn:  ${w}\n`);
    if (r.ok) ctx.stdout(`chardb doctor: ${path.slice(ctx.cwd.length + 1)} passes\n`);
    return r;
}

async function firstExisting(ctx: CliContext, paths: readonly string[]): Promise<string | undefined> {
    for (const path of paths) {
        if (await ctx.exists(path)) return path;
    }
    return undefined;
}
