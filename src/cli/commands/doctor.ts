import type { CliContext } from "../context.ts";
import { type DoctorResult, checkWrangler } from "../wrangler_template.ts";

export interface DoctorOptions {
    readonly which?: "wrangler" | "schema" | "auth";
}

export async function runDoctor(ctx: CliContext, opts: DoctorOptions = {}): Promise<DoctorResult> {
    const which = opts.which ?? "wrangler";
    if (which === "wrangler") return doctorWrangler(ctx);
    if (which === "schema") {
        // The partition-contract digest comparison runs at `defineChardb`
        // construction (deriving via `colocation/derive.ts`). The CLI gate
        // that diff-checks the digest against the deployed value isn't
        // wired yet — return a warning so callers don't treat this command
        // as a real check.
        ctx.stdout("chardb doctor schema: not yet implemented at the CLI layer\n");
        return {
            ok: true,
            errors: [],
            warnings: ["`chardb doctor schema` is not yet enforced — use `defineChardb` failure modes for now"],
        };
    }
    if (which === "auth") {
        // `assertAuthProfile` in `chardb/auth/profile.ts` is the real
        // check; it runs inside `withChardb()` at config time. The CLI
        // entry point can't statically import the user's options without a
        // loader, so we surface the same caveat here.
        ctx.stdout("chardb doctor auth: not yet implemented at the CLI layer\n");
        return {
            ok: true,
            errors: [],
            warnings: [
                "`chardb doctor auth` is not yet enforced — `assertAuthProfile` in chardb/auth runs at config time",
            ],
        };
    }
    return { ok: true, errors: [], warnings: [] };
}

async function doctorWrangler(ctx: CliContext): Promise<DoctorResult> {
    const path = `${ctx.cwd}/wrangler.jsonc`;
    if (!(await ctx.exists(path))) {
        return {
            ok: false,
            errors: [`wrangler.jsonc not found at ${path}; run \`chardb init\``],
            warnings: [],
        };
    }
    const text = await ctx.read(path);
    const r = checkWrangler(text);
    for (const e of r.errors) ctx.stderr(`error: ${e}\n`);
    for (const w of r.warnings) ctx.stderr(`warn:  ${w}\n`);
    if (r.ok) ctx.stdout("chardb doctor: wrangler.jsonc passes\n");
    return r;
}
