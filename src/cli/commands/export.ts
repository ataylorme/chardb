import type { CliContext } from "../context.ts";

/**
 * Streaming logical dump + R2 manifest + auth schema. The foundation skeleton
 * emits the manifest shape; the streaming pipeline is wired in once the
 * Catalog snapshot RPC is online.
 */
export interface ExportOptions {
    readonly out: string;
}

export async function runExport(ctx: CliContext, opts: ExportOptions): Promise<void> {
    const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        tables: [] as { table: string; rowCount: number; r2Key: string }[],
        blobs: [] as { id: string; sha256: string; size: number; r2Key: string }[],
        auth: { schemaVersion: 1, models: [] as string[] },
    };
    await ctx.write(`${opts.out}/manifest.json`, JSON.stringify(manifest, null, 2));
    ctx.stdout(
        `chardb export: stub manifest written to ${opts.out}/manifest.json
(streaming dump + R2 fan-out is not yet wired; the manifest shape is documented for consumers to anticipate.)
`
    );
}
