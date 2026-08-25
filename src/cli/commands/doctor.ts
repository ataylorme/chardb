import type { CliContext } from "../context.ts";
import { type DoctorResult, checkWrangler } from "../wrangler_template.ts";

export interface DoctorOptions {
    readonly which?: "wrangler" | "schema" | "auth";
}

export async function runDoctor(ctx: CliContext, opts: DoctorOptions = {}): Promise<DoctorResult> {
    const which = opts.which ?? "wrangler";
    if (which === "wrangler") return doctorWrangler(ctx);
    if (which === "schema") {
        const error = "chardb doctor schema: not implemented; no deployed partition-contract check was performed";
        ctx.stderr(`error: ${error}\n`);
        return {
            ok: false,
            errors: [error],
            warnings: [],
        };
    }
    if (which === "auth") {
        const error = "chardb doctor auth: not implemented; no application auth configuration was checked";
        ctx.stderr(`error: ${error}\n`);
        return {
            ok: false,
            errors: [error],
            warnings: [],
        };
    }
    const error = `chardb doctor: unsupported target ${String(which)}`;
    ctx.stderr(`error: ${error}\n`);
    return { ok: false, errors: [error], warnings: [] };
}

async function doctorWrangler(ctx: CliContext): Promise<DoctorResult> {
    const candidates = [`${ctx.cwd}/wrangler.toml`, `${ctx.cwd}/wrangler.jsonc`];
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
