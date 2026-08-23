/** Canonical wrangler.jsonc template emitted by `chardb init` and enforced by `chardb doctor`. */

export interface WranglerTemplateInput {
    readonly name: string;
    readonly compatibilityDate: string;
    readonly r2Bucket: string;
    readonly vectorizeIndex: string;
    readonly gsiQueue: string;
    readonly assetsDir: string;
}

export function renderWrangler(input: WranglerTemplateInput): string {
    const cfg = {
        name: input.name,
        main: "src/worker.ts",
        compatibility_date: input.compatibilityDate,
        durable_objects: {
            bindings: [
                { name: "CDB_CATALOG", class_name: "Catalog" },
                { name: "CDB_SHARD", class_name: "Cdb" },
                { name: "CDB_GATEWAY", class_name: "Gateway" },
                { name: "CDB_BLOBMETA", class_name: "BlobMeta" },
                { name: "CDB_RESHARDER", class_name: "Resharder" },
                { name: "CDB_GSI", class_name: "GsiShard" },
            ],
        },
        migrations: [
            {
                tag: "init",
                new_sqlite_classes: ["Cdb", "Catalog", "Gateway", "BlobMeta", "Resharder", "GsiShard"],
            },
        ],
        r2_buckets: [{ binding: "CDB_R2", bucket_name: input.r2Bucket }],
        vectorize: [{ binding: "CDB_VECTORIZE", index_name: input.vectorizeIndex }],
        queues: {
            producers: [{ binding: "CDB_GSI_QUEUE", queue: input.gsiQueue }],
            consumers: [{ queue: input.gsiQueue, max_batch_size: 100 }],
        },
        triggers: { crons: ["* * * * *"] },
        assets: {
            directory: input.assetsDir,
            binding: "CDB_DASHBOARD",
            run_worker_first: ["/_chardb/api/*", "/q", "/ws", "/f", "/p", "/s"],
        },
        tail_consumers: [{ service: "chardb-tail" }],
        observability: {
            logs: { enabled: true },
            traces: { enabled: true },
        },
    };
    return JSON.stringify(cfg, null, 2);
}

const REQUIRED_DO_BINDINGS = [
    "CDB_CATALOG",
    "CDB_SHARD",
    "CDB_GATEWAY",
    "CDB_BLOBMETA",
    "CDB_RESHARDER",
    "CDB_GSI",
] as const;

const REQUIRED_DO_CLASSES = ["Cdb", "Catalog", "Gateway", "BlobMeta", "Resharder", "GsiShard"] as const;

export interface DoctorResult {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}

export function checkWrangler(rawJsonc: string): DoctorResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let cfg: {
        durable_objects?: { bindings?: { name: string; class_name: string }[] };
        migrations?: { new_sqlite_classes?: string[] }[];
        observability?: { traces?: { enabled?: boolean } };
        assets?: { run_worker_first?: string[] };
    };
    try {
        cfg = JSON.parse(stripJsoncComments(rawJsonc)) as typeof cfg;
    } catch (e) {
        return {
            ok: false,
            errors: [`wrangler.jsonc is not valid JSON: ${(e as Error).message}`],
            warnings,
        };
    }
    const bindings = cfg.durable_objects?.bindings ?? [];
    for (const name of REQUIRED_DO_BINDINGS) {
        if (!bindings.some(b => b.name === name)) {
            errors.push(`durable_objects.bindings missing entry for ${name}`);
        }
    }
    const classes = new Set(bindings.map(b => b.class_name));
    for (const klass of REQUIRED_DO_CLASSES) {
        if (!classes.has(klass)) errors.push(`durable_objects.bindings missing class_name="${klass}"`);
    }
    if (cfg.observability?.traces?.enabled !== true) {
        warnings.push("observability.traces.enabled is not true (G19 region observability)");
    }
    if (!cfg.assets?.run_worker_first?.includes("/q")) {
        warnings.push("assets.run_worker_first should include reserved chardb routes (/q,/ws,/f,/p,/s)");
    }
    return { ok: errors.length === 0, errors, warnings };
}

function stripJsoncComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1");
}
