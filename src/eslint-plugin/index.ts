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
 *   check the `chardb explain --strict` CLI emits, but at editor-time so
 *   problem queries never reach a deploy.
 *
 * The plugin is published as a separate package; the source ships here so it
 * stays in lockstep with the helper signatures in `chardb/server`. The shape
 * follows the standard ESLint flat-config plugin contract.
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

export const rules = { "explain-strict": explainStrict } as const;

export const configs = {
    recommended: {
        plugins: ["chardb"],
        rules: {
            "chardb/explain-strict": "warn",
        },
    },
} as const;

export default { rules, configs };
