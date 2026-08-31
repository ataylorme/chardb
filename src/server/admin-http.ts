const ADMIN_BODY_MAX_BYTES = 4_096;
const ADMIN_TOKEN_MAX_BYTES = 512;
const ADMIN_TEXT_ENCODER = new TextEncoder();

interface AdminEnv {
    readonly CDB_ADMIN_TOKEN?: string;
}

async function equalSecret(left: string, right: string): Promise<boolean> {
    const [leftDigest, rightDigest] = await Promise.all([
        crypto.subtle.digest("SHA-256", ADMIN_TEXT_ENCODER.encode(left)),
        crypto.subtle.digest("SHA-256", ADMIN_TEXT_ENCODER.encode(right)),
    ]);
    const a = new Uint8Array(leftDigest);
    const b = new Uint8Array(rightDigest);
    let difference = a.byteLength ^ b.byteLength;
    const length = Math.max(a.byteLength, b.byteLength);
    for (let index = 0; index < length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
    return difference === 0 && left.length > 0;
}

export async function authorizeAdmin(request: Request, env: AdminEnv): Promise<Response | null> {
    const configuredToken = env.CDB_ADMIN_TOKEN;
    if (!configuredToken) return new Response("not found", { status: 404 });
    if (ADMIN_TEXT_ENCODER.encode(configuredToken).byteLength > ADMIN_TOKEN_MAX_BYTES) {
        return adminJsonError(500, "admin token is misconfigured");
    }
    const supplied = request.headers.get("authorization");
    const token = supplied?.startsWith("Bearer ") ? supplied.slice("Bearer ".length) : "";
    if (
        ADMIN_TEXT_ENCODER.encode(token).byteLength > ADMIN_TOKEN_MAX_BYTES ||
        !(await equalSecret(token, configuredToken))
    ) {
        return new Response("forbidden", { status: 403 });
    }
    return null;
}

export async function readAdminBody(request: Request): Promise<unknown> {
    const declared = request.headers.get("content-length");
    if (declared !== null) {
        const bytes = Number(declared);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > ADMIN_BODY_MAX_BYTES) {
            throw new TypeError("migration request body is too large");
        }
    }
    if (!request.body) throw new TypeError("migration request body is required");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > ADMIN_BODY_MAX_BYTES) {
            await reader.cancel();
            throw new TypeError("migration request body is too large");
        }
        chunks.push(next.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
}

export function exactAdminObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("migration request body must be an object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors).sort();
    const expected = [...keys].sort();
    if (
        actual.length !== expected.length ||
        actual.some((key, index) => key !== expected[index]) ||
        actual.some(key => {
            const descriptor = descriptors[key];
            return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
        })
    ) {
        throw new TypeError("migration request body has unexpected fields");
    }
    return Object.fromEntries(actual.map(key => [key, descriptors[key]?.value]));
}

export function adminJsonError(status: number, error: string): Response {
    return Response.json({ ok: false, error }, { status });
}
