declare module "eslint" {
    export namespace Rule {
        interface RuleModule {
            meta?: unknown;
            create(context: RuleContext): Record<string, (node: never) => void>;
        }
        interface RuleContext {
            report(descriptor: { node: unknown; messageId: string }): void;
        }
    }
}

declare module "@typescript-eslint/utils" {
    export namespace TSESTree {
        export interface Node {
            readonly type: string;
            readonly [key: string]: unknown;
        }
        export interface CallExpression extends Node {
            readonly type: "CallExpression";
            readonly callee: Node;
            readonly arguments: readonly Node[];
        }
    }
}
