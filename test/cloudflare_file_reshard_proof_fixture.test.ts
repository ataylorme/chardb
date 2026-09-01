import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FILE_RESHARD_VECTOR_DIMENSIONS } from "../scripts/run-file-reshard-deployment-proof.mjs";
import { checkWrangler } from "../src/cli/wrangler_template.ts";
import {
    FILE_RESHARD_PROOF_VECTOR,
    proofVectorValues,
} from "./fixtures/cloudflare-file-reshard-proof/src/proof-config.ts";

const FIXTURE = path.join(import.meta.dir, "fixtures", "cloudflare-file-reshard-proof");

describe("disposable Cloudflare file reshard proof fixture", () => {
    test("uses one vector shape for the schema, workload, and provisioned index", () => {
        expect(FILE_RESHARD_PROOF_VECTOR).toEqual({
            binding: "CDB_PROOF_VECTORS",
            dimensions: FILE_RESHARD_VECTOR_DIMENSIONS,
            metric: "cosine",
        });
        expect(proofVectorValues(0)).toHaveLength(FILE_RESHARD_PROOF_VECTOR.dimensions);
        expect(proofVectorValues(1)).toHaveLength(FILE_RESHARD_PROOF_VECTOR.dimensions);
    });

    test("independently typechecks the candidate fixture", async () => {
        const child = Bun.spawn([process.execPath, "x", "tsc", "-p", path.join(FIXTURE, "tsconfig.json"), "--noEmit"], {
            cwd: path.resolve(import.meta.dir, ".."),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(`${stdout}${stderr}`).toBe("");
        expect(exitCode).toBe(0);
    }, 180_000);

    test("keeps TOML primary and validates equivalent JSONC compatibility", async () => {
        const [tomlText, jsoncText] = await Promise.all([
            readFile(path.join(FIXTURE, "wrangler.toml"), "utf8"),
            readFile(path.join(FIXTURE, "wrangler.jsonc"), "utf8"),
        ]);
        expect(checkWrangler(tomlText, { requireFilesBinding: true }).ok).toBe(true);
        expect(checkWrangler(jsoncText, { requireFilesBinding: true }).ok).toBe(true);
        const toml = Bun.TOML.parse(tomlText) as Record<string, unknown>;
        const jsonc = JSON.parse(jsoncText) as Record<string, unknown>;
        for (const field of [
            "name",
            "main",
            "compatibility_date",
            "compatibility_flags",
            "migrations",
            "durable_objects",
            "r2_buckets",
            "version_metadata",
            "vars",
            "observability",
        ]) {
            expect(toml[field]).toEqual(jsonc[field]);
        }
        expect(toml).toHaveProperty("durable_objects.bindings", [
            { name: "CDB_CATALOG", class_name: "Catalog" },
            { name: "CDB_SHARD", class_name: "Cdb" },
            { name: "CDB_GATEWAY", class_name: "Gateway" },
            { name: "CDB_RESHARD", class_name: "Resharder" },
            { name: "CDB_VECTOR_PROBE", class_name: "VectorIndexProbe" },
        ]);
        expect(toml).toHaveProperty("version_metadata.binding", "CF_VERSION_METADATA");
        expect(toml).not.toHaveProperty("vars.CDB_PROOF_DEPLOYMENT_VERSION");
        expect(toml).toHaveProperty("vars.CDB_PROOF_LOCAL_VERSION", "local-dev");
    });
});
