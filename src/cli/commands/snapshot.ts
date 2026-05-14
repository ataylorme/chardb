import type { CliContext } from "../context.ts";

export interface SnapshotOptions {
    readonly tenant?: string;
    readonly label?: string;
}

export async function runSnapshot(ctx: CliContext, opts: SnapshotOptions): Promise<{ barrierId: string }> {
    const barrierId = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    ctx.stdout(
        `chardb snapshot: barrier=${barrierId}${opts.tenant ? ` tenant=${opts.tenant}` : ""}${
            opts.label ? ` label=${opts.label}` : ""
        }\n`
    );
    return { barrierId };
}

export interface RestoreOptions {
    readonly time?: string;
    readonly tenant?: string;
    readonly barrierId?: string;
}

export async function runRestore(ctx: CliContext, opts: RestoreOptions): Promise<void> {
    ctx.stdout(
        `chardb restore: ${opts.barrierId ? `barrier=${opts.barrierId}` : `time=${opts.time}`}${
            opts.tenant ? ` tenant=${opts.tenant}` : ""
        }\n`
    );
}
