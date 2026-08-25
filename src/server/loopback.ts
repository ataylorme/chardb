const SOURCE_ENV = Symbol("chardb.sourceEnv");

const LOOPBACK_BINDINGS = {
    CDB_CATALOG: "Catalog",
    CDB_SHARD: "Cdb",
    CDB_GATEWAY: "Gateway",
    CDB_BLOBMETA: "BlobMeta",
    CDB_RESHARDER: "Resharder",
    CDB_GSI: "GsiShard",
} as const;

type LoopbackExportName = (typeof LOOPBACK_BINDINGS)[keyof typeof LOOPBACK_BINDINGS];
type ChardbBindingName = keyof typeof LOOPBACK_BINDINGS;

interface ContextWithExports {
    readonly exports?: Partial<Record<LoopbackExportName, unknown>>;
}

type EnvWithSource = {
    readonly [SOURCE_ENV]?: object;
};

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
    const namespace = value as unknown as Partial<DurableObjectNamespace>;
    return (
        typeof namespace.get === "function" &&
        typeof namespace.idFromName === "function" &&
        typeof namespace.idFromString === "function"
    );
}

/**
 * Add same-Worker Durable Object namespaces from Cloudflare's native
 * `ctx.exports` collection. Miniflare's programmatic API provisions the same
 * classes as exported-name environment bindings, so those are accepted too.
 * Explicit Wrangler bindings still win for split-Worker deployments.
 */
export function withChardbLoopbacks<TEnv extends object>(env: TEnv, context: unknown): TEnv {
    const exports = (context as ContextWithExports | null | undefined)?.exports ?? {};

    const additions: Partial<Record<ChardbBindingName, DurableObjectNamespace>> = {};
    for (const [bindingName, exportName] of Object.entries(LOOPBACK_BINDINGS) as [
        ChardbBindingName,
        LoopbackExportName,
    ][]) {
        if (isDurableObjectNamespace((env as Record<string, unknown>)[bindingName])) continue;
        const exportedNamespace = exports[exportName];
        const namespace = isDurableObjectNamespace(exportedNamespace)
            ? exportedNamespace
            : (env as Record<string, unknown>)[exportName];
        if (isDurableObjectNamespace(namespace)) additions[bindingName] = namespace;
    }
    if (Object.keys(additions).length === 0) return env;

    const resolved = Object.assign(Object.create(env) as TEnv & EnvWithSource, additions);
    Object.defineProperty(resolved, SOURCE_ENV, {
        value: sourceChardbEnv(env),
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return resolved;
}

/** Return the stable Wrangler environment identity behind a loopback overlay. */
export function sourceChardbEnv(env: object): object {
    return (env as EnvWithSource)[SOURCE_ENV] ?? env;
}
