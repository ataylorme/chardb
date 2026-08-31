import { describe, expect, test } from "bun:test";
import {
    assertBenchmarkAdminToken,
    authorizeBenchmarkControlRequest,
} from "./workerd/public-vector-benchmark-control.ts";

const TOKEN = "public_vector_benchmark_admin_0123456789abcdef";

function request(pathname: string, init: RequestInit = {}): Request {
    return new Request(`https://benchmark.invalid${pathname}`, init);
}

describe("public vector benchmark control authentication", () => {
    test("rejects missing and wrong bearer credentials before dispatch", () => {
        const missing = authorizeBenchmarkControlRequest(request("/vector-state"), TOKEN);
        expect(missing).toMatchObject({ status: 401 });
        expect(missing?.headers.get("www-authenticate")).toBe('Bearer realm="chardb-vector-benchmark"');
        expect(
            authorizeBenchmarkControlRequest(
                request("/vector-state", { headers: { authorization: "Bearer definitely-wrong-token-0000000000" } }),
                TOKEN
            )
        ).toMatchObject({ status: 403 });
    });

    test("enforces exact methods and JSON media type on every write route", () => {
        const headers = { authorization: `Bearer ${TOKEN}` };
        expect(authorizeBenchmarkControlRequest(request("/seed", { headers }), TOKEN)).toMatchObject({ status: 405 });
        expect(
            authorizeBenchmarkControlRequest(
                request("/benchmark-seed", { method: "POST", headers: { ...headers, "content-type": "text/plain" } }),
                TOKEN
            )
        ).toMatchObject({ status: 415 });
        expect(
            authorizeBenchmarkControlRequest(
                request("/membership-delete", {
                    method: "POST",
                    headers: { ...headers, "content-type": "application/json" },
                }),
                TOKEN
            )
        ).toBeNull();
    });

    test("keeps the authenticated WebSocket path public and validates configured secrets", () => {
        expect(authorizeBenchmarkControlRequest(request("/ws"), TOKEN)).toBeNull();
        expect(authorizeBenchmarkControlRequest(request("/ws", { method: "POST" }), TOKEN)).toMatchObject({
            status: 405,
        });
        expect(assertBenchmarkAdminToken(TOKEN)).toBe(TOKEN);
        expect(() => assertBenchmarkAdminToken("short")).toThrow(/32 through 256/);
    });
});
