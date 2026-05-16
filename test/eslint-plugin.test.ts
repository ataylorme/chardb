import { describe, expect, test } from "bun:test";
import { rules } from "../src/eslint-plugin/index.ts";

interface CtxRecord {
    reports: { messageId: string }[];
}

function runRule(rule: (typeof rules)["explain-strict"], code: string): CtxRecord {
    const reports: { messageId: string }[] = [];
    const ctx = {
        report({ messageId }: { messageId: string }) {
            reports.push({ messageId });
        },
    };
    const visitor = rule.create(ctx as never) as { CallExpression(node: unknown): void };
    // Hand-rolled tokenizer would be heavy; we lean on the TS compiler's parser
    // available in the repo for the Vite plugin tests and traverse its tree.
    const ts = require("typescript") as typeof import("typescript");
    const sf = ts.createSourceFile("inline.ts", code, ts.ScriptTarget.Latest, true);
    const visit = (n: import("typescript").Node): void => {
        if (ts.isCallExpression(n)) {
            const estree = tsToEstreeCall(n);
            visitor.CallExpression(estree);
        }
        n.forEachChild(visit);
    };
    sf.forEachChild(visit);
    return { reports };
}

function tsToEstreeCall(n: import("typescript").CallExpression): unknown {
    const ts = require("typescript") as typeof import("typescript");
    const callee = n.expression;
    const calleeOut = ts.isIdentifier(callee)
        ? { type: "Identifier", name: callee.text }
        : ts.isPropertyAccessExpression(callee)
          ? {
                type: "MemberExpression",
                object: ts.isIdentifier(callee.expression)
                    ? { type: "Identifier", name: callee.expression.text }
                    : { type: "Unknown" },
                property: { type: "Identifier", name: callee.name.text },
            }
          : { type: "Unknown" };
    return {
        type: "CallExpression",
        callee: calleeOut,
        arguments: n.arguments.map(a => convertExpr(a)),
    };
}

function convertExpr(n: import("typescript").Node): unknown {
    const ts = require("typescript") as typeof import("typescript");
    if (ts.isObjectLiteralExpression(n)) {
        return {
            type: "ObjectExpression",
            properties: n.properties.map(p =>
                ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)
                    ? {
                          type: "Property",
                          key: { type: "Identifier", name: p.name.text },
                          value: { type: "Unknown" },
                      }
                    : { type: "Unknown" }
            ),
        };
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
        const body = n.body;
        return {
            type: "ArrowFunctionExpression",
            body: ts.isBlock(body)
                ? { type: "BlockStatement", body: body.statements.map(convertExpr) }
                : convertExpr(body),
        };
    }
    if (ts.isExpressionStatement(n)) return { type: "ExpressionStatement", expression: convertExpr(n.expression) };
    if (ts.isReturnStatement(n))
        return { type: "ReturnStatement", argument: n.expression ? convertExpr(n.expression) : null };
    if (ts.isAwaitExpression(n)) return { type: "AwaitExpression", argument: convertExpr(n.expression) };
    if (ts.isCallExpression(n)) return tsToEstreeCall(n);
    if (ts.isTaggedTemplateExpression(n)) {
        return {
            type: "TaggedTemplateExpression",
            tag: ts.isIdentifier(n.tag) ? { type: "Identifier", name: n.tag.text } : { type: "Unknown" },
        };
    }
    return { type: "Unknown" };
}

describe("chardb/explain-strict", () => {
    test("flags defineMutation without partitionKey", () => {
        const code = `defineMutation(async (ctx, args) => ({}));`;
        const { reports } = runRule(rules["explain-strict"], code);
        expect(reports).toHaveLength(1);
        expect(reports[0]?.messageId).toBe("missingPartitionKey");
    });

    test("accepts defineMutation with partitionKey", () => {
        const code = `defineMutation(async (ctx, args) => ({}), { partitionKey: (a) => a.id });`;
        const { reports } = runRule(rules["explain-strict"], code);
        expect(reports).toHaveLength(0);
    });

    test("flags defineQuery using db.execute(sql`...`)", () => {
        const code = `defineQuery(async (ctx) => { return await ctx.db.execute(sql\`SELECT 1\`); });`;
        const { reports } = runRule(rules["explain-strict"], code);
        expect(reports.some(r => r.messageId === "rawSqlInQuery")).toBe(true);
    });

    test("accepts defineQuery using Drizzle conditions only", () => {
        const code = `defineQuery(async (ctx) => { return await ctx.db.select().from(users); });`;
        const { reports } = runRule(rules["explain-strict"], code);
        expect(reports.some(r => r.messageId === "rawSqlInQuery")).toBe(false);
    });
});

describe("chardb/no-raw-sqlite-table", () => {
    test("flags direct sqliteTable() calls", () => {
        const code = `export const t = sqliteTable("t", { id: text("id") });`;
        const { reports } = runRule(rules["no-raw-sqlite-table"], code);
        expect(reports.some(r => r.messageId === "rawSqliteTable")).toBe(true);
    });

    test("does not flag cdbTable() calls (those flow through forOrg/forUser/globalScope)", () => {
        const code = `export const t = cdbTable("t", { id: text("id") }, { roles: { admin: "*" } });`;
        const { reports } = runRule(rules["no-raw-sqlite-table"], code);
        expect(reports.some(r => r.messageId === "rawSqliteTable")).toBe(false);
    });
});
