const PROBE_ROUTE = `app.get("/__chardb_loopback_probe", (c) => {
  const shape = (value: any) => ({
    type: typeof value,
    get: typeof value?.get,
    idFromName: typeof value?.idFromName,
    idFromString: typeof value?.idFromString,
  });
  const execution = c.executionCtx as ExecutionContext & { exports?: Record<string, unknown> };
  return c.json({
    envCatalog: shape((c.env as unknown as Record<string, unknown>).Catalog),
    resolvedCatalog: shape((c.env as unknown as Record<string, unknown>).CDB_CATALOG),
    exportCatalog: shape(execution.exports?.Catalog),
  });
});`;

const DEV_INSPECTOR_ANCHOR = `    "--port",
    origin.port || "8787",
    "--persist-to",`;

export function injectGeneratedLoopbackProbe(source) {
    if (typeof source !== "string") throw new TypeError("generated Worker source must be a string");
    if (!/app\.get\(\s*["']\/health["']\s*,/.test(source)) {
        throw new Error("generated Worker health route is missing");
    }
    if (source.includes('app.get("/__chardb_loopback_probe"')) {
        throw new Error("generated Worker already contains the loopback probe");
    }
    const exportMatches = [...source.matchAll(/^export default app;[ \t]*$/gm)];
    if (exportMatches.length !== 1 || exportMatches[0]?.index === undefined) {
        throw new Error("generated Worker must contain exactly one default app export");
    }
    const insertion = exportMatches[0].index;
    return `${source.slice(0, insertion)}${PROBE_ROUTE}\n\n${source.slice(insertion)}`;
}

export function injectGeneratedDevInspectorPort(source, port) {
    if (typeof source !== "string") throw new TypeError("generated dev source must be a string");
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError("generated dev inspector port must be an integer from 1 through 65535");
    }
    if (source.includes('"--inspector-port"')) {
        throw new Error("generated dev command already sets an inspector port");
    }
    const matches = source.split(DEV_INSPECTOR_ANCHOR).length - 1;
    if (matches !== 1) {
        throw new Error("generated dev command must contain exactly one Wrangler port and persistence boundary");
    }
    return source.replace(
        DEV_INSPECTOR_ANCHOR,
        `    "--port",
    origin.port || "8787",
    "--inspector-port",
    ${JSON.stringify(String(port))},
    "--persist-to",`
    );
}
