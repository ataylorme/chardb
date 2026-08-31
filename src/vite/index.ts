/**
 * Keep Chardb query and mutation handles safe to import from browser code.
 *
 * Browser builds receive ref-only handles. Query callbacks, mutation
 * handlers, validators, schema imports, and every other server dependency
 * disappear from the emitted module. Server builds keep the original module.
 * The transform also stamps stable refs on older definitions that omit one
 * and rejects duplicate refs seen during a build.
 */

/**
 * Minimal vite Plugin shape used here; the full type comes from the user's
 * vite install. We avoid a hard `import type { Plugin } from "vite"` so the
 * package builds even without vite present in the dependency closure.
 */
interface VitePluginLike {
    name: string;
    enforce?: "pre" | "post";
    transform?(
        this: ViteTransformContextLike,
        code: string,
        id: string,
        options?: ViteTransformOptionsLike
    ): { code: string; map: null } | null;
}
type Plugin = VitePluginLike;

interface ViteTransformContextLike {
    readonly environment?: { readonly name?: string };
}

interface ViteTransformOptionsLike {
    readonly ssr?: boolean;
}

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

const DEFINE_HELPERS = ["defineMutation", "defineQuery"] as const;

interface SeenExport {
    readonly module: string;
    readonly exportName: string;
    readonly kind: (typeof DEFINE_HELPERS)[number];
    readonly ref: string;
}

export function chardb(): Plugin {
    const seenExports: SeenExport[] = [];

    return {
        name: "chardb",
        enforce: "pre",
        transform(code, id, transformOptions) {
            const moduleId = cleanModuleId(id);
            if (!/\.(t|j)sx?$/.test(moduleId)) return null;
            const found = collectExports(code, moduleId);
            const nextSeenExports = seenExports.filter(entry => entry.module !== moduleId);
            if (found.length === 0) {
                seenExports.splice(0, seenExports.length, ...nextSeenExports);
                return null;
            }
            const refsInModule = new Set<string>();
            for (const entry of found) {
                if (refsInModule.has(entry.ref)) {
                    throw new Error(
                        `[@chardb/core/vite] Duplicate stable ref ${JSON.stringify(entry.ref)} in ${JSON.stringify(moduleId)}`
                    );
                }
                refsInModule.add(entry.ref);
                const duplicate = nextSeenExports.find(candidate => candidate.ref === entry.ref);
                if (duplicate) {
                    throw new Error(
                        `[@chardb/core/vite] Duplicate stable ref ${JSON.stringify(entry.ref)} from ` +
                            `${JSON.stringify(duplicate.module)}#${duplicate.exportName} and ` +
                            `${JSON.stringify(moduleId)}#${entry.exportName}`
                    );
                }
                nextSeenExports.push({
                    module: moduleId,
                    exportName: entry.exportName,
                    kind: entry.kind,
                    ref: entry.ref,
                });
            }
            seenExports.splice(0, seenExports.length, ...nextSeenExports);
            const hasPlannedQuery = found.some(entry => entry.plannedQuery);
            const hasApiMutation = found.some(entry => entry.apiMutation);
            if (hasPlannedQuery || hasApiMutation) {
                const target = viteTransformTarget(this, transformOptions);
                if (target === "unknown") {
                    const description = hasApiMutation ? "api.mutation" : "planned-query";
                    throw new Error(
                        `[@chardb/core/vite] Cannot determine the Vite environment for ${description} module ${JSON.stringify(moduleId)}`
                    );
                }
                if (target === "browser") {
                    return { code: eraseBrowserHandleModule(code, moduleId, found), map: null };
                }
            }
            let mutated = code;
            for (const e of found) {
                const stamp = `;if (!${e.exportName}.__chardbExplicitRef) Object.defineProperty(${e.exportName}, "__chardbRef", { value: ${JSON.stringify(e.ref)}, enumerable: false, configurable: true });`;
                if (mutated.includes(stamp)) continue;
                mutated += `\n${stamp}`;
            }
            return mutated === code ? null : { code: mutated, map: null };
        },
    };
}

export default chardb;

interface FoundExport {
    readonly exportName: string;
    readonly kind: (typeof DEFINE_HELPERS)[number];
    readonly ref: string;
    readonly explicitRef: boolean;
    readonly plannedQuery: boolean;
    readonly apiMutation: boolean;
    readonly browserErasableMutation: boolean;
}

/**
 * Discover `export const x = defineXxx(...)` bindings in a single TS/JS
 * source. Uses the TypeScript compiler API when available so renamed
 * (`import { defineMutation as dm }`) and namespaced (`import * as cdb`)
 * helpers are picked up. If TypeScript is unavailable, the transform fails
 * closed instead of stamping lookalike local functions by name.
 */
function collectExports(code: string, id: string): FoundExport[] {
    const refOf = (name: string): string => `${modulePath(id)}#${name}`;
    const ts = loadTypeScript();
    if (!ts) return [];

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
    const isFromChardbServer = (mod: string): boolean => mod === "@chardb/core/server" || mod === "@chardb/core";

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

    const isPlannedQueryCall = (
        call: import("typescript").CallExpression,
        kind: (typeof DEFINE_HELPERS)[number]
    ): boolean => {
        if (kind !== "defineQuery") return false;
        const config = call.arguments[0];
        if (!config || !ts.isObjectLiteralExpression(config)) return false;
        return config.properties.some(candidate => {
            if (!("name" in candidate) || !candidate.name) return false;
            return (
                (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
                candidate.name.text === "query"
            );
        });
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
            throw new Error(`[@chardb/core/vite] ${exportName} must use an inline config object`);
        }
        const config = positional ? call.arguments[1] : first;
        if (!config || !ts.isObjectLiteralExpression(config)) return undefined;
        if (config.properties.some(property => ts.isSpreadAssignment(property))) {
            throw new Error(`[@chardb/core/vite] ${exportName} config cannot spread ref metadata`);
        }
        const exactNamedProperty = (name: string) =>
            config.properties.find(candidate => {
                if (!("name" in candidate) || !candidate.name) return false;
                return (
                    (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
                    candidate.name.text === name
                );
            });
        const computedProperty = config.properties.find(
            candidate => "name" in candidate && candidate.name && ts.isComputedPropertyName(candidate.name)
        );
        // Preserve the legacy fail-closed handling of computed metadata. A
        // computed key could otherwise hide ref or placement fields from the
        // build transform.
        const namedProperty = (name: string) => exactNamedProperty(name) ?? computedProperty;
        const plannedQuery = kind === "defineQuery" && exactNamedProperty("query") !== undefined;
        if (plannedQuery) {
            if (computedProperty) {
                throw new Error(
                    `[@chardb/core/vite] Planned query ${exportName} config cannot use computed properties`
                );
            }
            const mixed = ["handler", "authority", "partitionKey", "intent"].filter(
                name => exactNamedProperty(name) !== undefined
            );
            if (mixed.length > 0) {
                throw new Error(
                    `[@chardb/core/vite] Planned query ${exportName} cannot mix query with ${mixed.join(", ")}`
                );
            }
        }
        const refProperty = namedProperty("ref");
        const authorityProperty = namedProperty("authority");
        let declaredAuthority: string | undefined;
        if (authorityProperty) {
            if (
                !ts.isPropertyAssignment(authorityProperty) ||
                ts.isComputedPropertyName(authorityProperty.name) ||
                !ts.isStringLiteralLike(authorityProperty.initializer)
            ) {
                throw new Error(`[@chardb/core/vite] Authority for ${exportName} must be a string literal`);
            }
            declaredAuthority = authorityProperty.initializer.text;
        }
        const stableAuthority =
            declaredAuthority === "organization" || declaredAuthority === "user" || declaredAuthority === "global"
                ? declaredAuthority
                : undefined;
        const authorityLabel = stableAuthority
            ? `${stableAuthority[0]?.toUpperCase()}${stableAuthority.slice(1)}`
            : undefined;
        if (!refProperty) {
            if (plannedQuery) {
                throw new Error(`[@chardb/core/vite] Planned query ${exportName} requires a literal ref`);
            }
            if (authorityLabel) {
                throw new Error(
                    `[@chardb/core/vite] ${authorityLabel} ${kind === "defineMutation" ? "mutation" : "query"} ${exportName} requires a literal ref`
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
            throw new Error(`[@chardb/core/vite] Explicit ref for ${exportName} must be a string literal`);
        }
        if (!ts.isStringLiteralLike(property.initializer)) {
            throw new Error(`[@chardb/core/vite] Explicit ref for ${exportName} must be a string literal`);
        }
        const explicitRef = validExplicitRef(property.initializer.text, exportName);
        if (stableAuthority === "global" && !namedProperty("partitionKey")) {
            throw new Error(
                `[@chardb/core/vite] Global ${kind === "defineMutation" ? "mutation" : "query"} ${exportName} requires an explicit partitionKey extractor`
            );
        }
        if (stableAuthority === "global" && kind === "defineQuery" && !namedProperty("intent")) {
            throw new Error(`[@chardb/core/vite] Global query ${exportName} requires an explicit intent extractor`);
        }
        return explicitRef;
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
                const apiFactoryCall = isApiFactoryCall(init.expression);
                const explicitRef = explicitConfigRef(init, kind, exportName, apiFactoryCall);
                out.push({
                    exportName,
                    kind,
                    plannedQuery: isPlannedQueryCall(init, kind),
                    apiMutation: kind === "defineMutation" && apiFactoryCall,
                    browserErasableMutation:
                        kind === "defineMutation" &&
                        apiFactoryCall &&
                        init.arguments[0] !== undefined &&
                        ts.isObjectLiteralExpression(init.arguments[0]),
                    ref: explicitRef ?? refOf(exportName),
                    explicitRef: explicitRef !== undefined,
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    sf.forEachChild(visit);
    return out;
}

function validExplicitRef(ref: string, exportName: string): string {
    if (ref.length === 0 || !ref.includes("#")) {
        throw new Error(`[@chardb/core/vite] Explicit ref for ${exportName} must be a nonempty string containing #`);
    }
    return ref;
}

type ViteTransformTarget = "browser" | "server" | "unknown";

function viteTransformTarget(
    context: ViteTransformContextLike,
    options: ViteTransformOptionsLike | undefined
): ViteTransformTarget {
    const environmentName = context.environment?.name;
    if (environmentName === "client") return "browser";
    if (environmentName !== undefined || options?.ssr === true) return "server";
    // `ssr: false` also describes Worker transforms. Erasing on that signal
    // alone would remove the callback from Cloudflare's server bundle.
    return "unknown";
}

function eraseBrowserHandleModule(code: string, id: string, found: readonly FoundExport[]): string {
    const handles = found.filter(entry => entry.plannedQuery || entry.browserErasableMutation);
    const hasMutation = handles.some(entry => entry.browserErasableMutation);
    const handleNames = new Set(handles.map(entry => entry.exportName));
    if (found.some(entry => entry.apiMutation && !entry.browserErasableMutation)) {
        throw new Error(
            `[@chardb/core/vite] Browser mutation module ${JSON.stringify(id)} supports only inline api.mutation({ ... }) exports`
        );
    }
    const implicit = handles.find(entry => !entry.explicitRef);
    if (implicit) {
        throw new Error(
            `[@chardb/core/vite] Browser ${implicit.kind === "defineMutation" ? "mutation" : "query"} ${implicit.exportName} requires a literal ref because Wrangler builds the Worker separately from Vite`
        );
    }
    if (handles.length === 0) return code;
    if (found.some(entry => !entry.plannedQuery && !entry.browserErasableMutation)) {
        const message = hasMutation
            ? `[@chardb/core/vite] Browser handle module ${JSON.stringify(id)} cannot mix erased and runtime exports`
            : `[@chardb/core/vite] Browser planned-query module ${JSON.stringify(id)} cannot mix planned and legacy runtime exports`;
        throw new Error(message);
    }

    const ts = loadTypeScript();
    if (!ts) {
        throw new Error(`[@chardb/core/vite] Browser handle erasure for ${JSON.stringify(id)} requires TypeScript`);
    }
    const sf = ts.createSourceFile(
        id,
        code,
        ts.ScriptTarget.Latest,
        true,
        /\.tsx?$/.test(id) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const hasExportModifier = (statement: import("typescript").Statement): boolean =>
        ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    const typeOnlyExport = (statement: import("typescript").ExportDeclaration): boolean =>
        statement.isTypeOnly ||
        (statement.exportClause !== undefined &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.every(element => element.isTypeOnly));
    const exportFailure = (): Error =>
        new Error(
            hasMutation
                ? `[@chardb/core/vite] Browser handle module ${JSON.stringify(id)} may export only erased handles and types`
                : `[@chardb/core/vite] Browser planned-query module ${JSON.stringify(id)} may export only planned queries and types`
        );

    for (const statement of sf.statements) {
        if (ts.isExportDeclaration(statement)) {
            if (typeOnlyExport(statement)) continue;
            throw exportFailure();
        }
        if (ts.isExportAssignment(statement)) {
            throw exportFailure();
        }
        if (!hasExportModifier(statement)) continue;
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
        if (ts.isVariableStatement(statement)) {
            const names = statement.declarationList.declarations.map(declaration =>
                ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
            );
            if (names.length > 0 && names.every(name => name !== undefined && handleNames.has(name))) continue;
        }
        throw exportFailure();
    }

    const definitions = handles
        .map(entry => {
            const kind = entry.plannedQuery ? "query" : "mutation";
            return `export const ${entry.exportName} = __chardbBrowserHandle(${JSON.stringify(kind)}, ${JSON.stringify(entry.ref)});`;
        })
        .join("\n");
    return [
        "const __chardbBrowserHandle = (kind, ref) => Object.defineProperties(",
        "  function chardbBrowserHandle() {",
        "    throw new Error(`Chardb ${kind} handles cannot execute in the browser; pass the handle to the Chardb client or React hook`);",
        "  },",
        "  {",
        "    __chardbKind: { value: kind, enumerable: false, configurable: true },",
        "    __chardbRef: { value: ref, enumerable: false, configurable: true },",
        "    __chardbExplicitRef: { value: true, enumerable: false, configurable: true }",
        "  }",
        ");",
        definitions,
        "",
    ].join("\n");
}

function cleanModuleId(id: string): string {
    return id.replace(/[?#].*$/, "").replaceAll("\\", "/");
}

function modulePath(id: string): string {
    const clean = cleanModuleId(id);
    const srcIndex = clean.lastIndexOf("/src/");
    return srcIndex === -1 ? clean : clean.slice(srcIndex + 1);
}
