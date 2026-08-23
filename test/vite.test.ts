import { describe, expect, test } from "bun:test";
import { chardb } from "../src/vite/index.ts";

interface PluginShape {
    name: string;
    resolveId: (s: string) => string | null;
    load: (id: string) => string | null;
    transform: (code: string, id: string) => { code: string; map: null } | null;
}

function makePlugin(): PluginShape {
    return chardb({}) as unknown as PluginShape;
}

function transform(p: PluginShape, code: string, id: string): { code: string; map: null } {
    const out = p.transform(code, id);
    expect(out).not.toBeNull();
    if (!out) throw new Error(`Expected ${id} to be transformed`);
    return out;
}

describe("@chardb/vite-plugin", () => {
    test("rewrites exported defineMutation to set __chardbRef", () => {
        const p = makePlugin();
        const code = `
      import { defineMutation } from "chardb/server";
      export const createPost = defineMutation(async () => ({}));
    `;
        const out = transform(p, code, "/abs/proj/src/mutations/post.ts");
        expect(out.code).toContain("__chardbRef");
        expect(out.code).toContain("src/mutations/post.ts#createPost");
    });

    test("AST mode picks up aliased imports", () => {
        const p = makePlugin();
        const code = `
      import { defineMutation as dm } from "chardb/server";
      export const fancy = dm(async () => ({}));
    `;
        const out = transform(p, code, "/abs/proj/src/aliased.ts");
        expect(out.code).toContain("src/aliased.ts#fancy");
        expect(out.code).toContain("__chardbRef");
    });

    test("stamps distinct module-and-export refs for config-form api mutations and queries", () => {
        const p = makePlugin();
        const code = `
      import { createApi } from "chardb/server";
      const api = createApi();
      export const createPost = api.mutation({ handler: () => ({}) });
      export const deletePost = api.mutation({ handler: () => ({}) });
      export const listPosts = api.query({ handler: async () => [] });
      export const getPost = api.query({ handler: async () => null });
    `;
        const out = transform(p, code, "/abs/proj/src/routes/posts.ts?worker");
        const refs = Array.from(out.code.matchAll(/value: "(src\/routes\/posts\.ts#[^"]+)"/g), match => match[1]);
        expect(refs).toEqual([
            "src/routes/posts.ts#createPost",
            "src/routes/posts.ts#deletePost",
            "src/routes/posts.ts#listPosts",
            "src/routes/posts.ts#getPost",
        ]);
        expect(new Set(refs).size).toBe(4);

        const registry = p.load("\0virtual:chardb/registry");
        expect(registry).toContain('"kind": "defineMutation"');
        expect(registry).toContain('"kind": "defineQuery"');
        for (const ref of refs) expect(registry).toContain(`"ref": "${ref}"`);
    });

    test("preserves explicit config refs for two mutations and a query", () => {
        const p = makePlugin();
        const code = `
      import { api } from "chardb/server";
      export const createPost = api.mutation({ ref: "api/posts#create", handler: () => ({}) });
      export const deletePost = api.mutation({ ref: "api/posts#delete", handler: () => ({}) });
      export const listPosts = api.query({ ref: "api/posts#list", handler: async () => [] });
    `;
        const out = transform(p, code, "/abs/proj/src/routes/posts.ts");
        const refs = Array.from(out.code.matchAll(/value: "([^"]+)"/g), match => match[1]);
        expect(refs).toEqual(["api/posts#create", "api/posts#delete", "api/posts#list"]);
        expect(out.code).not.toContain("src/routes/posts.ts#createPost");
    });

    test("preserves a positional mutation ref from its options object", () => {
        const p = makePlugin();
        const out = transform(
            p,
            `
      import { defineMutation } from "chardb/server";
      export const save = defineMutation((_ctx, args) => args, { ref: "api/items#save" });
    `,
            "/abs/proj/src/items.ts"
        );
        expect(out.code).toContain('value: "api/items#save"');
        expect(out.code).not.toContain("src/items.ts#save");
    });

    test("preserves positional api mutation authority and ref options", () => {
        const p = makePlugin();
        const out = transform(
            p,
            `
      import { api } from "chardb/server";
      export const save = api.mutation((_ctx, args) => args, {
        authority: "organization",
        ref: "api/items#save",
        partitionKey: args => args.organizationId,
      });
    `,
            "/abs/proj/src/items.ts"
        );
        expect(out.code).toContain('value: "api/items#save"');
    });

    test("rejects an organization mutation without a literal ref", () => {
        const p = makePlugin();
        expect(() =>
            p.transform(
                `
          import { api } from "chardb/server";
          export const save = api.mutation({
            authority: "organization",
            partitionKey: "organizationId",
            handler: () => null,
          });
        `,
                "/abs/proj/src/authority.ts"
            )
        ).toThrow("Organization mutation save requires a literal ref");
    });

    test("rejects duplicate and nonliteral explicit refs", () => {
        const duplicate = makePlugin();
        expect(() =>
            duplicate.transform(
                `
          import { api } from "chardb/server";
          export const first = api.mutation({ ref: "api/posts#same", handler: () => null });
          export const second = api.mutation({ ref: "api/posts#same", handler: () => null });
        `,
                "/abs/proj/src/duplicate.ts"
            )
        ).toThrow('Duplicate stable ref "api/posts#same"');

        const dynamic = makePlugin();
        expect(() =>
            dynamic.transform(
                `
          import { api } from "chardb/server";
          const ref = "api/posts#dynamic";
          export const save = api.mutation({ ref, handler: () => null });
        `,
                "/abs/proj/src/dynamic.ts"
            )
        ).toThrow("must be a string literal");
    });

    test("explicit refs survive moving the source module", () => {
        const code = `
      import { api } from "chardb/server";
      export const save = api.mutation({ ref: "api/items#save", handler: () => null });
    `;
        const first = transform(makePlugin(), code, "/first/src/items.ts");
        const moved = transform(makePlugin(), code, "/moved/src/domain/items.ts");
        expect(first.code).toContain('value: "api/items#save"');
        expect(moved.code).toContain('value: "api/items#save"');
    });

    test("rejects variable, spread, shorthand, and computed api configs", () => {
        const cases = [
            `const config = { ref: "api/items#save", handler: () => null }; export const save = api.mutation(config);`,
            `const common = { handler: () => null }; export const save = api.mutation({ ...common, ref: "api/items#save" });`,
            `const ref = "api/items#save"; export const save = api.mutation({ ref, handler: () => null });`,
            `const key = "ref"; export const save = api.mutation({ [key]: "api/items#save", handler: () => null });`,
        ];
        for (const source of cases) {
            const p = makePlugin();
            expect(() =>
                p.transform(`import { api } from "chardb/server"; ${source}`, "/abs/proj/src/rejected.ts")
            ).toThrow();
        }
    });

    test("fails clearly when two modules produce the same stable ref", () => {
        const p = makePlugin();
        const code = `
      import { api } from "chardb/server";
      export const save = api.mutation({ ref: "src/shared.ts#save", handler: () => ({}) });
    `;
        p.transform(code, "/workspace/first/src/shared.ts");
        expect(() => p.transform(code, "/workspace/second/src/shared.ts")).toThrow(
            'Duplicate stable ref "src/shared.ts#save"'
        );
    });

    test("removes stale registry and manifest entries when a module drops all Chardb exports", () => {
        const p = makePlugin();
        const id = "/abs/proj/src/removed.ts";
        transform(p, "export const save = defineMutation({ handler: () => ({}) });", id);
        expect(p.load("\0virtual:chardb/registry")).toContain("src/removed.ts#save");
        expect(p.load("\0virtual:chardb/manifest")).toContain(`from "${id}"`);

        expect(p.transform("export const ordinary = 1;", id)).toBeNull();
        expect(p.load("\0virtual:chardb/registry")).not.toContain("src/removed.ts#save");
        expect(p.load("\0virtual:chardb/manifest")).not.toContain(`from "${id}"`);
    });

    test("emits virtual:chardb/manifest with imports per registered module", () => {
        const p = makePlugin();
        p.transform("export const a = defineMutation(async () => ({}));", "/abs/proj/src/m1.ts");
        p.transform("export const b = defineQuery(async () => ({}));", "/abs/proj/src/m2.ts");
        const id = p.resolveId("virtual:chardb/manifest");
        expect(id).toBe("\0virtual:chardb/manifest");
        if (!id) throw new Error("Expected virtual manifest id");
        const src = p.load(id);
        expect(src).not.toBeNull();
        expect(src).toContain("manifestFromExports");
        expect(src).toContain('from "/abs/proj/src/m1.ts"');
        expect(src).toContain('from "/abs/proj/src/m2.ts"');
    });
});
