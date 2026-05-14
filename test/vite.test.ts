import { describe, expect, test } from "bun:test";
import { chardb } from "../src/vite/index.ts";

interface PluginShape {
    name: string;
    resolveId?: (s: string) => string | null;
    load?: (id: string) => string | null;
    transform?: (code: string, id: string) => { code: string; map: null } | null;
}

function makePlugin(): PluginShape {
    return chardb({}) as unknown as PluginShape;
}

describe("@chardb/vite-plugin", () => {
    test("rewrites exported defineMutation to set __chardbRef", () => {
        const p = makePlugin();
        const code = `
      import { defineMutation } from "chardb/server";
      export const createPost = defineMutation(async () => ({}));
    `;
        const out = p.transform!(code, "/abs/proj/src/mutations/post.ts");
        expect(out).not.toBeNull();
        expect(out!.code).toContain("__chardbRef");
        expect(out!.code).toContain("src/mutations/post.ts#createPost");
    });

    test("AST mode picks up aliased imports", () => {
        const p = makePlugin();
        const code = `
      import { defineMutation as dm } from "chardb/server";
      export const fancy = dm(async () => ({}));
    `;
        const out = p.transform!(code, "/abs/proj/src/aliased.ts");
        expect(out).not.toBeNull();
        expect(out!.code).toContain("src/aliased.ts#fancy");
        expect(out!.code).toContain("__chardbRef");
    });

    test("emits virtual:chardb/manifest with imports per registered module", () => {
        const p = makePlugin();
        p.transform!(`export const a = defineMutation(async () => ({}));`, "/abs/proj/src/m1.ts");
        p.transform!(`export const b = defineQuery(async () => ({}));`, "/abs/proj/src/m2.ts");
        const id = p.resolveId!("virtual:chardb/manifest");
        expect(id).toBe("\0virtual:chardb/manifest");
        const src = p.load!(id!);
        expect(src).not.toBeNull();
        expect(src).toContain("manifestFromExports");
        expect(src).toContain('from "/abs/proj/src/m1.ts"');
        expect(src).toContain('from "/abs/proj/src/m2.ts"');
    });
});
