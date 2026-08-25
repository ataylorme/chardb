/** Canonical Wrangler template emitted by `chardb init` and enforced by `chardb doctor`. */

export interface WranglerTemplateInput {
    readonly name: string;
    readonly compatibilityDate: string;
    readonly assetsDir: string;
}

export function renderWrangler(input: WranglerTemplateInput): string {
    return `name = ${tomlString(input.name)}
main = "src/worker.ts"
compatibility_date = ${tomlString(input.compatibilityDate)}
compatibility_flags = ["nodejs_compat"]

[[migrations]]
tag = "init"
new_sqlite_classes = ["Cdb", "Catalog", "Gateway", "BlobMeta", "Resharder", "GsiShard"]

[assets]
directory = ${tomlString(input.assetsDir)}
binding = "CDB_DASHBOARD"
run_worker_first = ["/_chardb/*", "/ws"]

[observability.logs]
enabled = true

[observability.traces]
enabled = true`;
}

export function renderWranglerJsonc(input: WranglerTemplateInput): string {
    return JSON.stringify(
        {
            name: input.name,
            main: "src/worker.ts",
            compatibility_date: input.compatibilityDate,
            compatibility_flags: ["nodejs_compat"],
            migrations: [
                {
                    tag: "init",
                    new_sqlite_classes: ["Cdb", "Catalog", "Gateway", "BlobMeta", "Resharder", "GsiShard"],
                },
            ],
            assets: {
                directory: input.assetsDir,
                binding: "CDB_DASHBOARD",
                run_worker_first: ["/_chardb/*", "/ws"],
            },
            observability: {
                logs: { enabled: true },
                traces: { enabled: true },
            },
        },
        null,
        2
    );
}

const REQUIRED_DO_CLASSES = ["Cdb", "Catalog", "Gateway", "BlobMeta", "Resharder", "GsiShard"] as const;
const CTX_EXPORTS_DEFAULT_DATE = "2025-11-17";

export interface DoctorResult {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}

export function checkWrangler(rawConfig: string): DoctorResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let cfg: {
        compatibility_date?: string;
        compatibility_flags?: string[];
        migrations?: { new_sqlite_classes?: string[] }[];
        observability?: { traces?: { enabled?: boolean } };
        assets?: { run_worker_first?: string[] };
    };
    try {
        cfg = parseWrangler(rawConfig) as typeof cfg;
    } catch (e) {
        return {
            ok: false,
            errors: [`Wrangler config is not valid TOML or JSONC: ${(e as Error).message}`],
            warnings,
        };
    }
    const flags = cfg.compatibility_flags ?? [];
    if (!flags.includes("nodejs_compat")) {
        errors.push('compatibility_flags must include "nodejs_compat"');
    }
    const dateEnablesLoopbacks =
        typeof cfg.compatibility_date === "string" && cfg.compatibility_date >= CTX_EXPORTS_DEFAULT_DATE;
    if (flags.includes("disable_ctx_exports") || (!dateEnablesLoopbacks && !flags.includes("enable_ctx_exports"))) {
        errors.push(
            `native loopback exports require compatibility_date >= "${CTX_EXPORTS_DEFAULT_DATE}" or compatibility_flags to include "enable_ctx_exports"`
        );
    }
    const classes = new Set((cfg.migrations ?? []).flatMap(migration => migration.new_sqlite_classes ?? []));
    for (const klass of REQUIRED_DO_CLASSES) {
        if (!classes.has(klass)) errors.push(`migrations missing new_sqlite_classes entry for "${klass}"`);
    }
    if (cfg.observability?.traces?.enabled !== true) {
        warnings.push("observability.traces.enabled is not true (G19 region observability)");
    }
    const runWorkerFirst = cfg.assets?.run_worker_first ?? [];
    const missingReservedRoutes = ["/_chardb/*", "/ws"].filter(route => !runWorkerFirst.includes(route));
    if (missingReservedRoutes.length > 0) {
        warnings.push(
            `assets.run_worker_first should include reserved chardb routes (${missingReservedRoutes.join(",")})`
        );
    }
    return { ok: errors.length === 0, errors, warnings };
}

function parseWrangler(source: string): unknown {
    const jsonc = stripJsoncComments(source);
    if (jsonc.trimStart().startsWith("{")) return JSON.parse(jsonc);
    return Bun.TOML.parse(source);
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

function stripJsoncComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1");
}
