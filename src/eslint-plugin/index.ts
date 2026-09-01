/**
 * `@chardb/eslint-plugin` — opt-in lints for chardb apps.
 *
 * Currently exposes one rule:
 *
 *   `chardb/explain-strict` — fails the lint when a `defineMutation` body is
 *   missing a `partitionKey` extractor (the gateway then has to re-evaluate
 *   the closure to route, defeating the manifest design), or when a
 *   `defineQuery` handler reaches for `db.execute(sql\`...\`)` (the static
 *   walker can't lower raw SQL into a `CdbIntent`). Mirrors the runtime
 *   restrictions enforced by the runtime planner, but at editor time so
 *   problem queries never reach a deploy.
 *
 * This is not a package entry. The source stays beside the server helper
 * signatures and its tests so it can be extracted into a standalone plugin.
 * The shape follows the standard ESLint flat-config plugin contract.
 */

import type { TSESTree } from "@typescript-eslint/utils";
import type { Rule } from "eslint";

interface NodeLike {
    readonly type: string;
    readonly [key: string]: unknown;
}

function isNode(v: unknown): v is NodeLike {
    return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

function isIdent(v: unknown, name?: string): v is { type: "Identifier"; name: string } {
    return isNode(v) && v.type === "Identifier" && (name === undefined || (v as { name?: string }).name === name);
}

function calleeName(node: TSESTree.CallExpression): string | null {
    const c = node.callee;
    if (isIdent(c)) return c.name;
    return null;
}

function hasPartitionKey(opts: unknown): boolean {
    if (!isNode(opts) || opts.type !== "ObjectExpression") return false;
    const props = (opts as { properties?: unknown }).properties;
    if (!Array.isArray(props)) return false;
    return props.some(p => {
        if (!isNode(p) || p.type !== "Property") return false;
        const key = (p as { key?: unknown }).key;
        return isIdent(key, "partitionKey");
    });
}

function containsRawSqlExecute(node: unknown): boolean {
    let found = false;
    const visit = (n: unknown): void => {
        if (found || !isNode(n)) return;
        if (n.type === "CallExpression") {
            const callee = (n as { callee?: unknown }).callee;
            if (isNode(callee) && callee.type === "MemberExpression") {
                const prop = (callee as { property?: unknown }).property;
                if (isIdent(prop, "execute")) {
                    const args = (n as { arguments?: unknown }).arguments;
                    if (Array.isArray(args)) {
                        for (const a of args) {
                            if (isNode(a) && a.type === "TaggedTemplateExpression") {
                                const tag = (a as { tag?: unknown }).tag;
                                if (isIdent(tag, "sql")) {
                                    found = true;
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        }
        for (const k of Object.keys(n)) {
            const child = (n as Record<string, unknown>)[k];
            if (Array.isArray(child)) {
                for (const c of child) visit(c);
            } else {
                visit(child);
            }
        }
    };
    visit(node);
    return found;
}

const explainStrict: Rule.RuleModule = {
    meta: {
        type: "problem",
        docs: {
            description:
                "Require defineMutation({ partitionKey }) and reject raw-SQL closures the chardb planner cannot route.",
            recommended: false,
            url: "https://chardb.dev/eslint/explain-strict",
        },
        schema: [],
        messages: {
            missingPartitionKey:
                "defineMutation must declare `partitionKey` so the gateway can route without re-running the closure.",
            rawSqlInQuery:
                "defineQuery handlers may not call `db.execute(sql\u200B`...`)`; use Drizzle conditions so the static walker can lower them.",
        },
    },
    create(context) {
        return {
            CallExpression(raw): void {
                const node = raw as unknown as TSESTree.CallExpression;
                const name = calleeName(node);
                if (name === "defineMutation" && !hasPartitionKey(node.arguments[1])) {
                    context.report({ node: raw, messageId: "missingPartitionKey" });
                } else if (name === "defineQuery" && containsRawSqlExecute(node.arguments[0])) {
                    context.report({ node: raw, messageId: "rawSqlInQuery" });
                }
            },
        };
    },
};

/**
 * `chardb/no-raw-sqlite-table` — flag any direct `sqliteTable(...)`
 * call in app schema files. cdbTable's metadata + RLS/CLS surface only
 * fires when the user obtains `cdbTable` via one of the ownership
 * factories (`forOrg(auth)`, `forOrgUser(auth)`, or `forUser(auth)`); a stray
 * `sqliteTable(...)` call drops every chardb-specific guarantee
 * silently. The rule fires on the call itself, not the import, so
 * test fixtures and one-off scripts that opt out can do so locally.
 */
const noRawSqliteTable: Rule.RuleModule = {
    meta: {
        type: "problem",
        docs: {
            description: "Disallow direct `sqliteTable(...)` calls in chardb app schemas; use an ownership factory.",
            recommended: false,
            url: "https://chardb.dev/eslint/no-raw-sqlite-table",
        },
        schema: [],
        messages: {
            rawSqliteTable:
                "Use `forOrg(auth)`, `forOrgUser(auth)`, or `forUser(auth)` to obtain an ownership-bound `cdbTable`. Raw sqliteTable rows do not have chardb policy metadata.",
        },
    },
    create(context) {
        return {
            CallExpression(raw): void {
                const node = raw as unknown as TSESTree.CallExpression;
                if (calleeName(node) === "sqliteTable") {
                    context.report({ node: raw, messageId: "rawSqliteTable" });
                }
            },
        };
    },
};

/**
 * `chardb/no-direct-cdb-table-import` — flag `cdbTable` imported from
 * `@chardb/core/server`. The cdbTable export does not exist; users must
 * destructure it from a tenancy factory call. This rule catches the
 * mistake at editor time before it surfaces as a TypeScript error.
 */
const noDirectCdbTableImport: Rule.RuleModule = {
    meta: {
        type: "problem",
        docs: {
            description: "Disallow importing `cdbTable` directly; obtain it from an ownership factory.",
            recommended: false,
            url: "https://chardb.dev/eslint/no-direct-cdb-table-import",
        },
        schema: [],
        messages: {
            directImport:
                "`cdbTable` is not exported from @chardb/core/server. Obtain it from `forOrg(auth)`, `forOrgUser(auth)`, or `forUser(auth)`.",
        },
    },
    create(context) {
        return {
            ImportDeclaration(raw): void {
                const node = raw as unknown as { source: { value?: unknown }; specifiers?: readonly unknown[] };
                const src = node.source.value;
                if (typeof src !== "string") return;
                if (src !== "@chardb/core" && !src.startsWith("@chardb/core/")) return;
                for (const spec of node.specifiers ?? []) {
                    if (!isNode(spec) || spec.type !== "ImportSpecifier") continue;
                    const imported = (spec as { imported?: { name?: string } }).imported;
                    if (imported?.name === "cdbTable") {
                        context.report({ node: raw, messageId: "directImport" });
                    }
                }
            },
        };
    },
};

export const rules = {
    "explain-strict": explainStrict,
    "no-raw-sqlite-table": noRawSqliteTable,
    "no-direct-cdb-table-import": noDirectCdbTableImport,
} as const;

export const configs = {
    recommended: {
        plugins: ["chardb"],
        rules: {
            "chardb/explain-strict": "warn",
            "chardb/no-raw-sqlite-table": "error",
            "chardb/no-direct-cdb-table-import": "error",
        },
    },
} as const;

export default { rules, configs };
