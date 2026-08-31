const POST_PATHS = new Set(["/seed", "/membership-delete", "/benchmark-seed"]);
const GET_PATHS = new Set([
    "/cdb-drain",
    "/cdb-force-due",
    "/cdb-state",
    "/gateway-drain",
    "/gateway-registration",
    "/vector-process",
    "/vector-state",
]);

function tokenEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    return difference === 0;
}

export function assertBenchmarkAdminToken(value: unknown): string {
    if (typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new TypeError("CDB_BENCHMARK_ADMIN_TOKEN must be a 32 through 256 character URL-safe secret");
    }
    return value;
}

export function authorizeBenchmarkControlRequest(request: Request, expectedToken: string): Response | null {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
        return request.method === "GET"
            ? null
            : new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
    }
    const authorization = request.headers.get("authorization");
    if (!authorization) {
        return new Response("missing bearer token", {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="chardb-vector-benchmark"' },
        });
    }
    if (
        !authorization.startsWith("Bearer ") ||
        !tokenEqual(authorization.slice(7), assertBenchmarkAdminToken(expectedToken))
    ) {
        return new Response("forbidden", { status: 403 });
    }
    const expectedMethod = POST_PATHS.has(url.pathname) ? "POST" : GET_PATHS.has(url.pathname) ? "GET" : null;
    if (expectedMethod && request.method !== expectedMethod) {
        return new Response("method not allowed", { status: 405, headers: { allow: expectedMethod } });
    }
    if (expectedMethod === "POST" && request.headers.get("content-type") !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
    }
    return null;
}
