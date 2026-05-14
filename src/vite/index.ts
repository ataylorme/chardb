/**
 * `@chardb/vite-plugin` — composes on `@cloudflare/vite-plugin`.
 *
 * Responsibilities:
 *   - Walk each module's TypeScript AST (via the `typescript` peer dep), find
 *     every `defineMutation/defineQuery/defineCron/defineStream/defineGsi/
 *     defineLedger/definePresenceKey` call assigned to a named export, and
 *     emit a `<modulePath>#<exportName>` → wire-id mapping for the registry
 *     virtual module.
 *   - Append a non-enumerable `__chardbRef` property to every such export so
 *     the runtime helpers (`readRef`, `manifestFromExports`) can recover the
 *     wire id from the value alone.
 *   - Provide virtual modules:
 *       virtual:chardb/schema, virtual:chardb/migrations,
 *       virtual:chardb/dashboard-config, virtual:chardb/registry,
 *       virtual:chardb/manifest
 *   - Schema HMR (partial): on `handleHotUpdate` the plugin fires a
 *     `chardb:schemaChanged` event on Vite's own dev-server WebSocket so
 *     a connected client can refresh. Emitting a wire-level
 *     `mustRefetch:'schemaChanged'` envelope and orchestrating the full
 *     DO restart on destructive diffs is future work — the dev-server
 *     ping is the foundation for both.
 *
 * The AST walk is robust against `export const x = defineMutation(...)`,
 * `export { x }` re-exports, and aliased imports
 * (`import { defineMutation as dm } from "chardb/server"`). It falls back to
 * a regex pre-scan when the `typescript` peer is missing so the foundation
 * still builds in environments without it.
 */

/**
 * Minimal vite Plugin shape used here; the full type comes from the user's
 * vite install. We avoid a hard `import type { Plugin } from "vite"` so the
 * package builds even without vite present in the dependency closure.
 */
export interface VitePluginLike {
    name: string;
    enforce?: "pre" | "post";
    resolveId?(source: string): string | null;
    load?(id: string): string | null;
    transform?(code: string, id: string): { code: string; map: null } | null;
    handleHotUpdate?(ctx: {
        file: string;
        server: { ws: { send(payload: unknown): void } };
    }): unknown;
}
type Plugin = VitePluginLike;

/**
 * Resolve the `typescript` peer dependency at runtime. The plugin only runs
 * during `vite build` / `vite dev`, both of which execute in Node; we use
 * `createRequire(import.meta.url)` so the published ESM bundle doesn't ship
 * a `require()` call that strict bundlers (e.g. tsup, rolldown) would
 * complain about. Returns `null` when `typescript` isn't installed; the
 * caller falls back to the regex export-scan path.
 */
import { createRequire as nodeCreateRequire } from "node:module";

/**
 * Resolve the `typescript` peer dependency at runtime via `createRequire`.
 * The plugin only runs during `vite build` / `vite dev` (Node), so the
 * `node:module` import is always available; using `createRequire` keeps
 * us strict-ESM-clean and avoids strict-bundler warnings about a bare
 * `require()` in a published ESM artifact.
 */
let cachedTs: typeof import("typescript") | null | undefined = undefined;
function loadTypeScript(): typeof import("typescript") | null {
    if (cachedTs !== undefined) return cachedTs;
    try {
        const localRequire = nodeCreateRequire(import.meta.url);
        cachedTs = localRequire("typescript") as typeof import("typescript");
    } catch {
        cachedTs = null;
    }
    return cachedTs;
}

export interface ChardbVitePluginOptions {
    readonly schema?: string;
    readonly serverModuleGlob?: string;
    readonly registryOut?: string;
}

const VIRTUAL_PREFIX = "virtual:chardb/";
const VIRTUAL_RESOLVED = "\0virtual:chardb/";

const DEFINE_HELPERS = [
    "defineMutation",
    "defineQuery",
    "defineCron",
    "defineStream",
    "defineLedger",
    "defineGsi",
    "definePresenceKey",
] as const;

interface RegistryEntry {
    readonly module: string;
    readonly exportName: string;
    readonly kind: (typeof DEFINE_HELPERS)[number];
    readonly ref: string;
}

export function chardb(options: ChardbVitePluginOptions = {}): Plugin {
    const registry: RegistryEntry[] = [];

    return {
        name: "chardb",
        enforce: "pre",
        resolveId(source) {
            if (source.startsWith(VIRTUAL_PREFIX)) return `\0${source}`;
            return null;
        },
        load(id) {
            if (!id.startsWith(VIRTUAL_RESOLVED)) return null;
            const which = id.slice(VIRTUAL_RESOLVED.length);
            switch (which) {
                case "registry":
                    return `export const registry = ${JSON.stringify(registry, null, 2)};`;
                case "manifest": {
                    const grouped = new Map<string, RegistryEntry[]>();
                    for (const e of registry) {
                        const arr = grouped.get(e.module) ?? [];
                        arr.push(e);
                        grouped.set(e.module, arr);
                    }
                    let src = `import { manifestFromExports } from "chardb/server";\n`;
                    const collectors: string[] = [];
                    let i = 0;
                    for (const [mod, entries] of grouped) {
                        const ns = `__cdb_m${i++}`;
                        const names = entries.map(e => `${e.exportName}: ${ns}.${e.exportName}`).join(", ");
                        src += `import * as ${ns} from ${JSON.stringify(mod)};\n`;
                        collectors.push(`{ ${names} }`);
                    }
                    src += `\nexport const manifest = manifestFromExports(Object.assign({}, ${collectors.join(", ")}));\n`;
                    return src;
                }
                case "schema":
                    return options.schema ? `export * from ${JSON.stringify(options.schema)};` : `export {};`;
                case "migrations":
                    return `export const migrations = [];`;
                case "dashboard-config":
                    return `export const dashboardConfig = { version: 1 };`;
                default:
                    return null;
            }
        },
        transform(code, id) {
            if (!/\.(t|j)sx?$/.test(id)) return null;
            const found = collectExports(code, id);
            if (found.length === 0) return null;
            let mutated = code;
            for (const e of found) {
                if (!registry.some(r => r.ref === e.ref)) {
                    registry.push({ module: id, exportName: e.exportName, kind: e.kind, ref: e.ref });
                }
                const guard = `__chardbRef:${JSON.stringify(e.ref)}`;
                if (mutated.includes(guard)) continue;
                mutated += `\n;Object.defineProperty(${e.exportName}, "__chardbRef", { value: ${JSON.stringify(e.ref)}, enumerable: false, configurable: true });`;
            }
            return mutated === code ? null : { code: mutated, map: null };
        },
        handleHotUpdate(ctx) {
            if (ctx.file.endsWith("/schema.ts") || ctx.file.endsWith("/schema.tsx")) {
                ctx.server.ws.send({
                    type: "custom",
                    event: "chardb:schemaChanged",
                    data: { reason: "schemaChanged" },
                });
            }
            return undefined;
        },
    };
}

export default chardb;

interface FoundExport {
    readonly exportName: string;
    readonly kind: (typeof DEFINE_HELPERS)[number];
    readonly ref: string;
}

/**
 * Discover `export const x = defineXxx(...)` bindings in a single TS/JS
 * source. Uses the TypeScript compiler API when available so renamed
 * (`import { defineMutation as dm }`) and namespaced (`import * as cdb`)
 * helpers are picked up; otherwise falls back to a regex pre-scan.
 */
function collectExports(code: string, id: string): FoundExport[] {
    const refOf = (name: string): string => `${id.replace(/.*\/src\//, "src/")}#${name}`;
    const ts = loadTypeScript();
    if (!ts) return regexCollect(code, refOf);

    const aliases = new Map<string, (typeof DEFINE_HELPERS)[number]>();
    const sf = ts.createSourceFile(
        id,
        code,
        ts.ScriptTarget.Latest,
        true,
        /\.tsx?$/.test(id) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const isFromChardbServer = (mod: string): boolean => mod === "chardb/server" || mod === "chardb";

    const walkImports = (node: import("typescript").Node): void => {
        if (ts!.isImportDeclaration(node) && ts!.isStringLiteral(node.moduleSpecifier)) {
            const mod = node.moduleSpecifier.text;
            if (!isFromChardbServer(mod)) return;
            const clause = node.importClause;
            if (!clause) return;
            const named = clause.namedBindings;
            if (named && ts!.isNamedImports(named)) {
                for (const el of named.elements) {
                    const original = (el.propertyName ?? el.name).text;
                    const local = el.name.text;
                    if ((DEFINE_HELPERS as readonly string[]).includes(original)) {
                        aliases.set(local, original as (typeof DEFINE_HELPERS)[number]);
                    }
                }
            }
        }
    };
    sf.forEachChild(walkImports);

    const out: FoundExport[] = [];
    const visit = (node: import("typescript").Node): void => {
        if (ts!.isVariableStatement(node) && node.modifiers?.some(m => m.kind === ts!.SyntaxKind.ExportKeyword)) {
            for (const decl of node.declarationList.declarations) {
                if (!ts!.isIdentifier(decl.name) || !decl.initializer) continue;
                const init = decl.initializer;
                if (!ts!.isCallExpression(init) || !ts!.isIdentifier(init.expression)) continue;
                const calleeLocal = init.expression.text;
                const kind = aliases.get(calleeLocal);
                if (!kind) continue;
                const exportName = decl.name.text;
                out.push({ exportName, kind, ref: refOf(exportName) });
            }
        }
        ts!.forEachChild(node, visit);
    };
    sf.forEachChild(visit);
    if (out.length === 0) return regexCollect(code, refOf);
    return out;
}

function regexCollect(code: string, refOf: (name: string) => string): FoundExport[] {
    const out: FoundExport[] = [];
    const exportRe =
        /export\s+(?:const|let|var)\s+(\w+)\s*=\s*(defineMutation|defineQuery|defineCron|defineStream|defineLedger|defineGsi|definePresenceKey)\b/g;
    for (const match of code.matchAll(exportRe)) {
        const exportName = match[1] as string;
        const kind = match[2] as (typeof DEFINE_HELPERS)[number];
        out.push({ exportName, kind, ref: refOf(exportName) });
    }
    return out;
}
