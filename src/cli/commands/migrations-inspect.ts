import { pathToFileURL } from "node:url";
import { inspectSchemaSnapshot } from "../../server/schema-snapshot.ts";
import { stableJson } from "../../util/canonical.ts";
import type { CliContext } from "../context.ts";

const MIGRATION_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Hidden fresh-process boundary used only by `migrations generate`. */
const DIGEST = /^[0-9a-f]{64}$/;

export async function runMigrationsInspect(
    ctx: CliContext,
    name: string,
    version: number,
    previousDigest: string | null
): Promise<void> {
    if (!MIGRATION_NAME.test(name)) throw new Error("migration name is invalid");
    if (!Number.isSafeInteger(version) || version < 1 || version > 1_024)
        throw new Error("migration version is invalid");
    if (version === 1 ? previousDigest !== null : typeof previousDigest !== "string" || !DIGEST.test(previousDigest)) {
        throw new Error("previous migration digest is invalid");
    }
    const authModule = (await import(pathToFileURL(`${ctx.cwd}/src/auth.ts`).href)) as Record<string, unknown>;
    const schemaModule = (await import(pathToFileURL(`${ctx.cwd}/src/schema.ts`).href)) as Record<string, unknown>;
    const auth = authModule.auth;
    if (typeof auth !== "object" || auth === null || !("options" in auth)) {
        throw new Error('src/auth.ts must export the named CharDB auth value "auth"');
    }
    const authOptions = (auth as { readonly options?: unknown }).options;
    if (typeof authOptions !== "object" || authOptions === null) {
        throw new Error("src/auth.ts auth.options is invalid");
    }
    const snapshot = inspectSchemaSnapshot({
        name,
        version,
        previousDigest,
        domainSchema: schemaModule,
        authOptions: authOptions as never,
    });
    ctx.stdout(`${stableJson(snapshot)}\n`);
}
