import { client } from "@chardb/core";
import { chardb } from "@chardb/core/server";
import * as api from "./api.ts";
import { auth } from "./auth.ts";
import { migrations } from "./migrations.ts";
import * as schema from "./schema.ts";

interface ProofEnv {
    readonly CDB_ADMIN_TOKEN: string;
    readonly CDB_FILES: R2Bucket;
    readonly CDB_PROOF_RUN_ID: string;
    readonly CDB_RELEASE_SHA256: string;
}

const app = chardb({ auth, authBasePath: "/api/auth", schema, api, migrations });

function bearer(value: string | undefined): string {
    return value?.replace(/^Bearer\s+/i, "") ?? "";
}

async function sha256(value: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function sameSecret(left: string, right: string): Promise<boolean> {
    const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
    let different = leftHash.length ^ rightHash.length;
    for (let index = 0; index < leftHash.length; index++) {
        different |= (leftHash[index] ?? 0) ^ (rightHash[index] ?? 0);
    }
    return different === 0;
}

async function proofAuthorized(
    request: { header(name: string): string | undefined },
    env: ProofEnv,
    suppliedRunId: string
): Promise<boolean> {
    return (
        suppliedRunId === env.CDB_PROOF_RUN_ID &&
        sameSecret(bearer(request.header("authorization")), env.CDB_ADMIN_TOKEN)
    );
}

async function listObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    do {
        const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        objects.push(...page.objects);
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return objects;
}

async function objectDigest(objects: readonly R2Object[]): Promise<string> {
    const digest = await sha256(
        objects
            .map(object => `${object.key}\0${object.size}\0${object.etag}`)
            .sort()
            .join("\n")
    );
    return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

app.get("/health", c => {
    const env = c.env as unknown as ProofEnv;
    return c.json({
        ok: true,
        schemaVersion: migrations.version,
        releaseSha256: env.CDB_RELEASE_SHA256,
        proofConfigured:
            typeof env.CDB_ADMIN_TOKEN === "string" &&
            env.CDB_ADMIN_TOKEN.length > 0 &&
            typeof env.CDB_PROOF_RUN_ID === "string" &&
            env.CDB_PROOF_RUN_ID.length > 0,
    });
});

app.post("/api/documents", async c => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "missing bearer token" }, 401);
    const body = await c.req.json<{
        readonly action: "create" | "replace";
        readonly id: string;
        readonly organizationId: string;
        readonly fileId: string;
        readonly mutId: string;
    }>();
    const mutation = body.action === "replace" ? api.replaceDocumentFile : api.createDocument;
    const result = await client(c.env.DB, { jwt: token, authOrigin: new URL(c.req.url).origin }).mutate(
        mutation,
        { id: body.id, organizationId: body.organizationId, fileId: body.fileId },
        { mutId: body.mutId }
    );
    return c.json(result);
});

app.get("/proof/r2-state", async c => {
    const env = c.env as unknown as ProofEnv;
    const runId = c.req.header("x-chardb-proof-run-id") ?? "";
    if (!(await proofAuthorized(c.req, env, runId))) return c.json({ error: "not found" }, 404);
    const organizationId = c.req.query("organizationId") ?? "";
    const prefix = organizationId ? `v1/${organizationId}/` : "";
    const objects = await listObjects(env.CDB_FILES, prefix);
    return c.json({
        count: objects.length,
        bytes: objects.reduce((sum, object) => sum + object.size, 0),
        digest: await objectDigest(objects),
    });
});

app.post("/proof/add-member", async c => {
    const env = c.env as unknown as ProofEnv;
    const runId = c.req.header("x-chardb-proof-run-id") ?? "";
    if (!(await proofAuthorized(c.req, env, runId))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ readonly organizationId: string; readonly userId: string }>();
    const member = await c.var.auth.api.addMember({
        body: { organizationId: body.organizationId, userId: body.userId, role: "member" },
    });
    return c.json({ id: member.id, organizationId: member.organizationId, userId: member.userId, role: member.role });
});

app.post("/proof/r2-purge", async c => {
    const env = c.env as unknown as ProofEnv;
    const body = await c.req.json<{ readonly confirm?: string }>();
    const runId = c.req.header("x-chardb-proof-run-id") ?? "";
    if (!(await proofAuthorized(c.req, env, runId)) || body.confirm !== "PURGE_DISPOSABLE_BUCKET") {
        return c.json({ error: "not found" }, 404);
    }
    let deleted = 0;
    for (;;) {
        const objects = await listObjects(env.CDB_FILES, "");
        if (objects.length === 0) break;
        for (let index = 0; index < objects.length; index += 1_000) {
            const keys = objects.slice(index, index + 1_000).map(object => object.key);
            await env.CDB_FILES.delete(keys);
            deleted += keys.length;
        }
    }
    return c.json({ deleted });
});

export default app;
export const { DB, Catalog, Cdb, Gateway, Resharder } = app;
