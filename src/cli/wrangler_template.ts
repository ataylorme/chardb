/** Canonical Wrangler template emitted by `chardb init` and enforced by `chardb doctor`. */

export interface WranglerTemplateInput {
    readonly name: string;
    readonly compatibilityDate: string;
    readonly assetsDir: string;
    /** Private file-slice opt-in. TOML remains the canonical generated format. */
    readonly filesBucket?: string;
}

export function renderWrangler(input: WranglerTemplateInput): string {
    return `name = ${tomlString(input.name)}
main = "src/worker.ts"
compatibility_date = ${tomlString(input.compatibilityDate)}
compatibility_flags = ["nodejs_compat"]

[[migrations]]
tag = "init"
new_sqlite_classes = ["Cdb", "Catalog", "Gateway", "Resharder"]

[[durable_objects.bindings]]
name = "CDB_CATALOG"
class_name = "Catalog"

[[durable_objects.bindings]]
name = "CDB_SHARD"
class_name = "Cdb"

[[durable_objects.bindings]]
name = "CDB_GATEWAY"
class_name = "Gateway"

[[durable_objects.bindings]]
name = "CDB_RESHARD"
class_name = "Resharder"
${
    input.filesBucket
        ? `
[[r2_buckets]]
binding = "CDB_FILES"
bucket_name = ${tomlString(input.filesBucket)}
`
        : ""
}

[assets]
directory = ${tomlString(input.assetsDir)}
binding = "CDB_DASHBOARD"
run_worker_first = ["/_chardb/*", "/api/*", "/health", "/ws"]

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
                    new_sqlite_classes: ["Cdb", "Catalog", "Gateway", "Resharder"],
                },
            ],
            durable_objects: {
                bindings: [
                    { name: "CDB_CATALOG", class_name: "Catalog" },
                    { name: "CDB_SHARD", class_name: "Cdb" },
                    { name: "CDB_GATEWAY", class_name: "Gateway" },
                    { name: "CDB_RESHARD", class_name: "Resharder" },
                ],
            },
            ...(input.filesBucket ? { r2_buckets: [{ binding: "CDB_FILES", bucket_name: input.filesBucket }] } : {}),
            assets: {
                directory: input.assetsDir,
                binding: "CDB_DASHBOARD",
                run_worker_first: ["/_chardb/*", "/api/*", "/health", "/ws"],
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

const REQUIRED_DO_CLASSES = ["Cdb", "Catalog", "Gateway", "Resharder"] as const;
const REQUIRED_DO_BINDINGS = [
    ["CDB_CATALOG", "Catalog"],
    ["CDB_SHARD", "Cdb"],
    ["CDB_GATEWAY", "Gateway"],
    ["CDB_RESHARD", "Resharder"],
] as const;
const CTX_EXPORTS_DEFAULT_DATE = "2025-11-17";

export interface DoctorResult {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}

export interface CheckWranglerOptions {
    /** Require the fixed native bucket when a schema contains a private file descriptor. */
    readonly requireFilesBinding?: boolean;
    /** Require each internal vector resource binding without enabling vector runtime support. */
    readonly requiredVectorBindings?: readonly string[];
}

/** Read the unique native Vectorize index names from one validated Wrangler config. */
export function configuredVectorizeIndexNames(rawConfig: string): readonly string[] {
    const parsed = parseWrangler(rawConfig);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("Wrangler config must be an object");
    }
    const vectorize = (parsed as { readonly vectorize?: unknown }).vectorize;
    if (vectorize === undefined) return Object.freeze([]);
    if (!Array.isArray(vectorize)) throw new TypeError("vectorize must be an array of binding entries");
    const bindings = new Set<string>();
    const indexes = new Set<string>();
    for (const entry of vectorize) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new TypeError("vectorize entries must be objects");
        }
        const binding = (entry as { readonly binding?: unknown }).binding;
        const indexName = (entry as { readonly index_name?: unknown }).index_name;
        const remote = (entry as { readonly remote?: unknown }).remote;
        if (typeof binding !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding)) {
            throw new TypeError("vectorize entries require a valid Worker binding name");
        }
        if (bindings.has(binding)) {
            throw new TypeError(`vectorize must contain only one ${JSON.stringify(binding)} binding`);
        }
        bindings.add(binding);
        if (typeof indexName !== "string" || indexName.trim().length === 0) {
            throw new TypeError(`the ${JSON.stringify(binding)} vectorize binding requires a nonempty index_name`);
        }
        if (remote !== undefined && typeof remote !== "boolean") {
            throw new TypeError(`the ${JSON.stringify(binding)} vectorize binding remote field must be boolean`);
        }
        if (remote !== true) {
            throw new TypeError(
                `Vectorize does not support local development; set remote = true for binding ${JSON.stringify(binding)}`
            );
        }
        indexes.add(indexName);
    }
    return Object.freeze([...indexes].sort());
}

export function checkWrangler(rawConfig: string, options: CheckWranglerOptions = {}): DoctorResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let parsed: unknown;
    try {
        parsed = parseWrangler(rawConfig);
    } catch (e) {
        return {
            ok: false,
            errors: [`Wrangler config is not valid TOML or JSONC: ${(e as Error).message}`],
            warnings,
        };
    }
    if (!isRecord(parsed)) {
        return { ok: false, errors: ["Wrangler config must be an object"], warnings };
    }
    const cfg = parsed;
    const flagsValue = cfg.compatibility_flags;
    const flags =
        flagsValue === undefined
            ? []
            : Array.isArray(flagsValue) && flagsValue.every(flag => typeof flag === "string")
              ? flagsValue
              : [];
    if (flagsValue !== undefined && flags.length !== (Array.isArray(flagsValue) ? flagsValue.length : -1)) {
        errors.push("compatibility_flags must be an array of strings");
    }
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
    const classes = new Set<string>();
    if (cfg.migrations !== undefined && !Array.isArray(cfg.migrations)) {
        errors.push("migrations must be an array");
    } else {
        for (const [index, migration] of (cfg.migrations ?? []).entries()) {
            if (!isRecord(migration)) {
                errors.push(`migrations[${index}] must be an object`);
                continue;
            }
            const added = migration.new_sqlite_classes;
            if (added === undefined) continue;
            if (!Array.isArray(added) || added.some(klass => typeof klass !== "string")) {
                errors.push(`migrations[${index}].new_sqlite_classes must be an array of strings`);
                continue;
            }
            for (const klass of added) classes.add(klass);
        }
    }
    for (const klass of REQUIRED_DO_CLASSES) {
        if (!classes.has(klass)) errors.push(`migrations missing new_sqlite_classes entry for "${klass}"`);
    }
    let durableObjectBindings: readonly unknown[] = [];
    if (!isRecord(cfg.durable_objects)) {
        errors.push("durable_objects must be an object with a bindings array");
    } else {
        const bindings = cfg.durable_objects.bindings;
        if (!Array.isArray(bindings)) errors.push("durable_objects.bindings must be an array");
        else {
            durableObjectBindings = bindings;
            for (const [index, binding] of bindings.entries()) {
                if (!isRecord(binding)) errors.push(`durable_objects.bindings[${index}] must be an object`);
            }
        }
    }
    for (const [bindingName, className] of REQUIRED_DO_BINDINGS) {
        const matches = durableObjectBindings.filter(
            binding =>
                typeof binding === "object" &&
                binding !== null &&
                !Array.isArray(binding) &&
                (binding as { readonly name?: unknown }).name === bindingName
        );
        if (matches.length === 0) {
            errors.push(`durable_objects.bindings must contain exactly one "${bindingName}" binding`);
            continue;
        }
        if (matches.length > 1) {
            errors.push(`durable_objects.bindings must contain only one "${bindingName}" binding`);
            continue;
        }
        if ((matches[0] as { readonly class_name?: unknown }).class_name !== className) {
            errors.push(`the "${bindingName}" Durable Object binding must use class_name "${className}"`);
            continue;
        }
        if (
            Object.keys(matches[0] as Record<string, unknown>)
                .sort()
                .join(",") !== "class_name,name"
        ) {
            errors.push(
                `the "${bindingName}" Durable Object binding must be same-Worker and contain only name and class_name`
            );
        }
    }
    const r2Buckets: Record<string, unknown>[] = [];
    if (cfg.r2_buckets !== undefined && !Array.isArray(cfg.r2_buckets)) {
        errors.push("r2_buckets must be an array of binding entries");
    } else {
        for (const [index, bucket] of (cfg.r2_buckets ?? []).entries()) {
            if (!isRecord(bucket)) {
                errors.push(`r2_buckets[${index}] must be an object`);
                continue;
            }
            r2Buckets.push(bucket);
        }
    }
    const filesBindings = r2Buckets.filter(bucket => bucket.binding === "CDB_FILES");
    if (filesBindings.length > 1) errors.push('r2_buckets must contain only one "CDB_FILES" binding');
    if (options.requireFilesBinding && filesBindings.length === 0) {
        errors.push('file columns require an r2_buckets binding named "CDB_FILES"');
    }
    if (filesBindings.some(bucket => typeof bucket.bucket_name !== "string" || bucket.bucket_name.length === 0)) {
        errors.push('the "CDB_FILES" binding requires a nonempty bucket_name');
    }
    const vectorBindings: unknown[] = [];
    const vectorIndexNames = new Set<string>();
    if (cfg.vectorize !== undefined) {
        if (!Array.isArray(cfg.vectorize)) errors.push("vectorize must be an array of binding entries");
        else vectorBindings.push(...cfg.vectorize);
    }
    const seenVectorBindings = new Set<string>();
    for (const entry of vectorBindings) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            errors.push("vectorize entries must be objects");
            continue;
        }
        const binding = (entry as { readonly binding?: unknown }).binding;
        const indexName = (entry as { readonly index_name?: unknown }).index_name;
        const remote = (entry as { readonly remote?: unknown }).remote;
        if (typeof binding !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding)) {
            errors.push("vectorize entries require a valid Worker binding name");
            continue;
        }
        if (seenVectorBindings.has(binding)) {
            errors.push(`vectorize must contain only one ${JSON.stringify(binding)} binding`);
        }
        seenVectorBindings.add(binding);
        if (typeof indexName !== "string" || indexName.trim().length === 0) {
            errors.push(`the ${JSON.stringify(binding)} vectorize binding requires a nonempty index_name`);
        } else {
            vectorIndexNames.add(indexName);
            if (remote === true) {
                warnings.push(
                    `Vectorize binding ${JSON.stringify(binding)} uses the real remote Cloudflare index ${JSON.stringify(indexName)} during wrangler dev; Miniflare does not emulate Vectorize and provider usage may be billed`
                );
            } else if (remote === false || remote === undefined) {
                errors.push(
                    `Vectorize does not support local development; set remote = true for binding ${JSON.stringify(binding)}`
                );
            } else {
                errors.push(`the ${JSON.stringify(binding)} vectorize binding remote field must be boolean`);
            }
        }
    }
    const requiredVectorBindings = [...new Set(options.requiredVectorBindings ?? [])];
    if (
        requiredVectorBindings.length !== (options.requiredVectorBindings?.length ?? 0) ||
        requiredVectorBindings.some(binding => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding))
    ) {
        errors.push("required vector bindings must be unique valid Worker binding names");
    } else {
        for (const binding of requiredVectorBindings) {
            if (!seenVectorBindings.has(binding)) {
                errors.push(`vector resources require a vectorize binding named ${JSON.stringify(binding)}`);
            }
        }
    }
    for (const indexName of vectorIndexNames) {
        warnings.push(
            `Vectorize index ${JSON.stringify(indexName)} requires the string metadata index "cdb_resource"; run \`chardb vectorize prepare\` to create or verify it`
        );
    }
    const observability = isRecord(cfg.observability) ? cfg.observability : undefined;
    const traces = isRecord(observability?.traces) ? observability.traces : undefined;
    if (traces?.enabled !== true) {
        warnings.push("observability.traces.enabled is not true (G19 region observability)");
    }
    let runWorkerFirst: readonly string[] = [];
    if (cfg.assets !== undefined && !isRecord(cfg.assets)) {
        errors.push("assets must be an object");
    } else if (isRecord(cfg.assets) && cfg.assets.run_worker_first !== undefined) {
        if (
            !Array.isArray(cfg.assets.run_worker_first) ||
            cfg.assets.run_worker_first.some(route => typeof route !== "string")
        ) {
            errors.push("assets.run_worker_first must be an array of strings");
        } else {
            runWorkerFirst = cfg.assets.run_worker_first;
        }
    }
    const missingReservedRoutes = ["/_chardb/*", "/api/*", "/health", "/ws"].filter(
        route => !runWorkerFirst.includes(route)
    );
    if (missingReservedRoutes.length > 0) {
        warnings.push(
            `assets.run_worker_first should include reserved chardb routes (${missingReservedRoutes.join(",")})`
        );
    }
    return { ok: errors.length === 0, errors, warnings };
}

function parseWrangler(source: string): unknown {
    const trimmed = source.trimStart();
    // A leading `[` is ambiguous: it can be a JSON array or a TOML table.
    // Accept a JSON array only when it parses completely; otherwise let the
    // TOML parser handle `[assets]` and `[[vectorize]]`.
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
        const jsonc = stripJsoncComments(source);
        const uncommented = jsonc.trimStart();
        if (uncommented.startsWith("{")) {
            return JSON.parse(removeJsoncTrailingCommas(jsonc));
        }
        if (uncommented.startsWith("[") && !uncommented.startsWith("[[")) {
            try {
                return JSON.parse(removeJsoncTrailingCommas(jsonc));
            } catch {
                // Valid TOML table headers also start with one `[`. Fall through.
            }
        }
    }
    return Bun.TOML.parse(source);
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

function stripJsoncComments(src: string): string {
    let output = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < src.length; index++) {
        const current = src[index];
        const next = src[index + 1];
        if (inString) {
            output += current;
            if (escaped) escaped = false;
            else if (current === "\\") escaped = true;
            else if (current === '"') inString = false;
            continue;
        }
        if (current === '"') {
            inString = true;
            output += current;
            continue;
        }
        if (current === "/" && next === "/") {
            output += "  ";
            index += 2;
            while (index < src.length && src[index] !== "\n" && src[index] !== "\r") {
                output += " ";
                index++;
            }
            if (index < src.length) output += src[index];
            continue;
        }
        if (current === "/" && next === "*") {
            output += "  ";
            index += 2;
            let closed = false;
            while (index < src.length) {
                if (src[index] === "*" && src[index + 1] === "/") {
                    output += "  ";
                    index++;
                    closed = true;
                    break;
                }
                output += src[index] === "\n" || src[index] === "\r" ? src[index] : " ";
                index++;
            }
            if (!closed) throw new SyntaxError("unterminated JSONC block comment");
            continue;
        }
        output += current;
    }
    return output;
}

function removeJsoncTrailingCommas(src: string): string {
    let output = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < src.length; index++) {
        const current = src[index];
        if (inString) {
            output += current;
            if (escaped) escaped = false;
            else if (current === "\\") escaped = true;
            else if (current === '"') inString = false;
            continue;
        }
        if (current === '"') {
            inString = true;
            output += current;
            continue;
        }
        if (current === ",") {
            let lookahead = index + 1;
            while (lookahead < src.length && /\s/.test(src[lookahead] ?? "")) lookahead++;
            if (src[lookahead] === "}" || src[lookahead] === "]") continue;
        }
        output += current;
    }
    return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
