/**
 * `@chardb/vite-plugin` — composes on `@cloudflare/vite-plugin`.
 *
 * Responsibilities:
 *   - Walk each module's TypeScript AST (via the `typescript` peer dep), find
 *     every direct `defineMutation/defineQuery/defineCron/defineStream/
 *     defineGsi/defineLedger/definePresenceKey` call, plus `api.mutation`
 *     and `api.query`, assigned to a named export, and
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
 * The AST walk handles `export const x = defineMutation(...)`, API objects
 * returned by `createApi()`, namespace imports, and aliased imports
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
                    return options.schema ? `export * from ${JSON.stringify(options.schema)};` : "export {};";
                case "migrations":
                    return "export const migrations = [];";
                case "dashboard-config":
                    return "export const dashboardConfig = { version: 1 };";
                default:
                    return null;
            }
        },
        transform(code, id) {
            const moduleId = cleanModuleId(id);
            if (!/\.(t|j)sx?$/.test(moduleId)) return null;
            const found = collectExports(code, moduleId);
            const nextRegistry = registry.filter(entry => entry.module !== moduleId);
            if (found.length === 0) {
                registry.splice(0, registry.length, ...nextRegistry);
                return null;
            }
            const refsInModule = new Set<string>();
            for (const entry of found) {
                if (refsInModule.has(entry.ref)) {
                    throw new Error(
                        `[chardb/vite] Duplicate stable ref ${JSON.stringify(entry.ref)} in ${JSON.stringify(moduleId)}`
                    );
                }
                refsInModule.add(entry.ref);
                const duplicate = nextRegistry.find(candidate => candidate.ref === entry.ref);
                if (duplicate) {
                    throw new Error(
                        `[chardb/vite] Duplicate stable ref ${JSON.stringify(entry.ref)} from ` +
                            `${JSON.stringify(duplicate.module)}#${duplicate.exportName} and ` +
                            `${JSON.stringify(moduleId)}#${entry.exportName}`
                    );
                }
                nextRegistry.push({
                    module: moduleId,
                    exportName: entry.exportName,
                    kind: entry.kind,
                    ref: entry.ref,
                });
            }
            registry.splice(0, registry.length, ...nextRegistry);
            let mutated = code;
            for (const e of found) {
                const stamp = `;if (!${e.exportName}.__chardbExplicitRef) Object.defineProperty(${e.exportName}, "__chardbRef", { value: ${JSON.stringify(e.ref)}, enumerable: false, configurable: true });`;
                if (mutated.includes(stamp)) continue;
                mutated += `\n${stamp}`;
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
    const refOf = (name: string): string => `${modulePath(id)}#${name}`;
    const ts = loadTypeScript();
    if (!ts) return regexCollect(code, refOf);

    const aliases = new Map<string, (typeof DEFINE_HELPERS)[number]>();
    const apiObjects = new Set<string>();
    const createApiAliases = new Set<string>();
    const namespaceAliases = new Set<string>();
    const sf = ts.createSourceFile(
        id,
        code,
        ts.ScriptTarget.Latest,
        true,
        /\.tsx?$/.test(id) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const isFromChardbServer = (mod: string): boolean => mod === "chardb/server" || mod === "chardb";

    const walkImports = (node: import("typescript").Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const mod = node.moduleSpecifier.text;
            if (!isFromChardbServer(mod)) return;
            const clause = node.importClause;
            if (!clause) return;
            const named = clause.namedBindings;
            if (named && ts.isNamedImports(named)) {
                for (const el of named.elements) {
                    const original = (el.propertyName ?? el.name).text;
                    const local = el.name.text;
                    if ((DEFINE_HELPERS as readonly string[]).includes(original)) {
                        aliases.set(local, original as (typeof DEFINE_HELPERS)[number]);
                    } else if (original === "api") {
                        apiObjects.add(local);
                    } else if (original === "createApi") {
                        createApiAliases.add(local);
                    }
                }
            } else if (named && ts.isNamespaceImport(named)) {
                namespaceAliases.add(named.name.text);
            }
        }
    };
    sf.forEachChild(walkImports);

    const walkApiBindings = (node: import("typescript").Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            const init = node.initializer;
            if (ts.isCallExpression(init)) {
                const callee = init.expression;
                const directFactory = ts.isIdentifier(callee) && createApiAliases.has(callee.text);
                const namespaceFactory =
                    ts.isPropertyAccessExpression(callee) &&
                    ts.isIdentifier(callee.expression) &&
                    namespaceAliases.has(callee.expression.text) &&
                    callee.name.text === "createApi";
                if (directFactory || namespaceFactory) apiObjects.add(node.name.text);
            }
        }
        ts.forEachChild(node, walkApiBindings);
    };
    sf.forEachChild(walkApiBindings);

    const kindOf = (expression: import("typescript").LeftHandSideExpression) => {
        if (ts.isIdentifier(expression)) return aliases.get(expression.text);
        if (!ts.isPropertyAccessExpression(expression)) return undefined;
        const property = expression.name.text;
        if (ts.isIdentifier(expression.expression)) {
            const objectName = expression.expression.text;
            if (namespaceAliases.has(objectName) && (DEFINE_HELPERS as readonly string[]).includes(property)) {
                return property as (typeof DEFINE_HELPERS)[number];
            }
            if (apiObjects.has(objectName)) {
                if (property === "mutation") return "defineMutation";
                if (property === "query") return "defineQuery";
            }
        }
        if (
            (property === "mutation" || property === "query") &&
            ts.isPropertyAccessExpression(expression.expression) &&
            ts.isIdentifier(expression.expression.expression) &&
            namespaceAliases.has(expression.expression.expression.text) &&
            expression.expression.name.text === "api"
        ) {
            return property === "mutation" ? "defineMutation" : "defineQuery";
        }
        return undefined;
    };

    const isApiFactoryCall = (expression: import("typescript").LeftHandSideExpression): boolean => {
        if (!ts.isPropertyAccessExpression(expression)) return false;
        if (ts.isIdentifier(expression.expression) && apiObjects.has(expression.expression.text)) return true;
        return (
            ts.isPropertyAccessExpression(expression.expression) &&
            ts.isIdentifier(expression.expression.expression) &&
            namespaceAliases.has(expression.expression.expression.text) &&
            expression.expression.name.text === "api"
        );
    };

    const explicitConfigRef = (
        call: import("typescript").CallExpression,
        kind: (typeof DEFINE_HELPERS)[number],
        exportName: string,
        apiFactoryCall: boolean
    ): string | undefined => {
        if (kind !== "defineMutation" && kind !== "defineQuery") return undefined;
        const first = call.arguments[0];
        const positional = kind === "defineMutation" && first && !ts.isObjectLiteralExpression(first);
        if (
            apiFactoryCall &&
            positional &&
            !call.arguments[1] &&
            !ts.isArrowFunction(first) &&
            !ts.isFunctionExpression(first)
        ) {
            throw new Error(`[chardb/vite] ${exportName} must use an inline config object`);
        }
        const config = positional ? call.arguments[1] : first;
        if (!config || !ts.isObjectLiteralExpression(config)) return undefined;
        if (config.properties.some(property => ts.isSpreadAssignment(property))) {
            throw new Error(`[chardb/vite] ${exportName} config cannot spread ref metadata`);
        }
        const namedProperty = (name: string) =>
            config.properties.find(
                candidate =>
                    ((ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
                        ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
                            (ts.isStringLiteral(candidate.name) && candidate.name.text === name))) ||
                    (ts.isPropertyAssignment(candidate) && ts.isComputedPropertyName(candidate.name))
            );
        const refProperty = namedProperty("ref");
        const authorityProperty = namedProperty("authority");
        let organizationAuthority = false;
        if (authorityProperty) {
            if (
                !ts.isPropertyAssignment(authorityProperty) ||
                ts.isComputedPropertyName(authorityProperty.name) ||
                !ts.isStringLiteralLike(authorityProperty.initializer)
            ) {
                throw new Error(`[chardb/vite] Authority for ${exportName} must be a string literal`);
            }
            organizationAuthority = authorityProperty.initializer.text === "organization";
        }
        if (!refProperty) {
            if (organizationAuthority) {
                throw new Error(
                    `[chardb/vite] Organization ${kind === "defineMutation" ? "mutation" : "query"} ${exportName} requires a literal ref`
                );
            }
            return undefined;
        }
        const property = config.properties.find(
            candidate =>
                ((ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
                    ((ts.isIdentifier(candidate.name) && candidate.name.text === "ref") ||
                        (ts.isStringLiteral(candidate.name) && candidate.name.text === "ref"))) ||
                (ts.isPropertyAssignment(candidate) && ts.isComputedPropertyName(candidate.name))
        );
        if (!property) return undefined;
        if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) {
            throw new Error(`[chardb/vite] Explicit ref for ${exportName} must be a string literal`);
        }
        if (!ts.isStringLiteralLike(property.initializer)) {
            throw new Error(`[chardb/vite] Explicit ref for ${exportName} must be a string literal`);
        }
        return validExplicitRef(property.initializer.text, exportName);
    };

    const out: FoundExport[] = [];
    const visit = (node: import("typescript").Node): void => {
        if (ts.isVariableStatement(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
            for (const decl of node.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
                const init = decl.initializer;
                if (!ts.isCallExpression(init)) continue;
                const kind = kindOf(init.expression);
                if (!kind) continue;
                const exportName = decl.name.text;
                out.push({
                    exportName,
                    kind,
                    ref:
                        explicitConfigRef(init, kind, exportName, isApiFactoryCall(init.expression)) ??
                        refOf(exportName),
                });
            }
        }
        ts.forEachChild(node, visit);
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
        out.push({
            exportName,
            kind,
            ref:
                regexExplicitConfigRef(code, (match.index ?? 0) + match[0].length, exportName, kind, false) ??
                refOf(exportName),
        });
    }
    const apiExportRe = /export\s+(?:const|let|var)\s+(\w+)\s*=\s*api\.(mutation|query)\b/g;
    for (const match of code.matchAll(apiExportRe)) {
        const exportName = match[1] as string;
        const method = match[2] as "mutation" | "query";
        const kind = method === "mutation" ? "defineMutation" : "defineQuery";
        out.push({
            exportName,
            kind,
            ref:
                regexExplicitConfigRef(code, (match.index ?? 0) + match[0].length, exportName, kind, true) ??
                refOf(exportName),
        });
    }
    return out;
}

function validExplicitRef(ref: string, exportName: string): string {
    if (ref.length === 0 || !ref.includes("#")) {
        throw new Error(`[chardb/vite] Explicit ref for ${exportName} must be a nonempty string containing #`);
    }
    return ref;
}

function regexExplicitConfigRef(
    code: string,
    callEnd: number,
    exportName: string,
    kind: (typeof DEFINE_HELPERS)[number],
    apiFactoryCall: boolean
): string | undefined {
    let cursor = callEnd;
    while (/\s/.test(code[cursor] ?? "")) cursor++;
    if (code[cursor] !== "(") return undefined;
    const args: string[] = [];
    let start = cursor + 1;
    let parens = 1;
    let braces = 0;
    let brackets = 0;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;
    for (cursor++; cursor < code.length; cursor++) {
        const character = code[cursor] as string;
        if (quote) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'" || character === "`") {
            quote = character;
            continue;
        }
        if (character === "(") parens++;
        else if (character === ")") {
            parens--;
            if (parens === 0) {
                args.push(code.slice(start, cursor).trim());
                break;
            }
        } else if (character === "{") braces++;
        else if (character === "}") braces--;
        else if (character === "[") brackets++;
        else if (character === "]") brackets--;
        else if (character === "," && parens === 1 && braces === 0 && brackets === 0) {
            args.push(code.slice(start, cursor).trim());
            start = cursor + 1;
        }
    }
    const firstIsConfig = args[0]?.startsWith("{") === true;
    if (
        apiFactoryCall &&
        !firstIsConfig &&
        !args[1] &&
        !/^(?:async\s*)?(?:function\b|\(?[\w\s,:{}<>?\[\]|&.]*\)?\s*=>)/.test(args[0] ?? "")
    ) {
        throw new Error(`[chardb/vite] ${exportName} must use an inline config object`);
    }
    const config = kind === "defineMutation" && !firstIsConfig ? args[1] : args[0];
    if (!config?.startsWith("{")) return undefined;
    if (/\.\.\./.test(config)) {
        throw new Error(`[chardb/vite] ${exportName} config cannot spread ref metadata`);
    }
    const hasAuthority = /\bauthority\s*:/.test(config);
    const organizationAuthority = /\bauthority\s*:\s*(["'])organization\1/.test(config);
    if (hasAuthority && !organizationAuthority) {
        const literalAuthority = /\bauthority\s*:\s*(["'])[^"'\\]*\1/.test(config);
        if (!literalAuthority) throw new Error(`[chardb/vite] Authority for ${exportName} must be a string literal`);
    }
    if (!/\bref\s*:/.test(config)) {
        if (organizationAuthority) {
            throw new Error(
                `[chardb/vite] Organization ${kind === "defineMutation" ? "mutation" : "query"} ${exportName} requires a literal ref`
            );
        }
        return undefined;
    }
    const literal = /\bref\s*:\s*(["'])([^"'\\]*)\1/.exec(config);
    if (!literal?.[2]) throw new Error(`[chardb/vite] Explicit ref for ${exportName} must be a string literal`);
    return validExplicitRef(literal[2], exportName);
}

function cleanModuleId(id: string): string {
    return id.replace(/[?#].*$/, "").replaceAll("\\", "/");
}

function modulePath(id: string): string {
    const clean = cleanModuleId(id);
    const srcIndex = clean.lastIndexOf("/src/");
    return srcIndex === -1 ? clean : clean.slice(srcIndex + 1);
}
