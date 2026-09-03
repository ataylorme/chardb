/**
 * Coverage for `mountChardb`'s auth-handler routing.
 *
 * The framework already short-circuits chardb-reserved prefixes
 * (`/ws`, `/_chardb/*`) to the CharDB
 * WorkerEntrypoint, then falls through to the user's `app.fetch` for
 * anything else. The new `options.authHandler` argument lets a
 * better-auth `auth.handler` claim `/api/auth/*` without the user
 * wiring it into their Hono app.
 */

import { describe, expect, test } from "bun:test";
import { mountChardb } from "../../src/server/entrypoint.ts";

interface ExecutionCtxLike {
    waitUntil(p: Promise<unknown>): void;
    passThroughOnException(): void;
    props: unknown;
}

const FAKE_ENV = {} as Parameters<ReturnType<typeof mountChardb>["fetch"]>[1];
const FAKE_CTX: ExecutionCtxLike = {
    waitUntil() {},
    passThroughOnException() {},
    props: undefined,
};

class StubChardb {
    async fetch(_req: Request): Promise<Response> {
        return new Response("chardb-reserved", { status: 200 });
    }
}

describe("mountChardb", () => {
    test("routes /api/auth/* to options.authHandler when supplied", async () => {
        const calls: string[] = [];
        const authHandler = async (req: Request): Promise<Response> => {
            calls.push(new URL(req.url).pathname);
            return new Response("auth-ok", { status: 200 });
        };
        const userApp = {
            async fetch(_req: Request): Promise<Response> {
                return new Response("user-app", { status: 200 });
            },
        };
        const mounted = mountChardb(StubChardb as never, userApp, { authHandler });

        const res = await mounted.fetch(
            new Request("https://example.com/api/auth/sign-in"),
            FAKE_ENV,
            FAKE_CTX as unknown as ExecutionContext
        );
        expect(await res.text()).toBe("auth-ok");
        expect(calls).toEqual(["/api/auth/sign-in"]);
    });

    test("user routes still reach app.fetch when authHandler is unset", async () => {
        const userApp = {
            async fetch(_req: Request): Promise<Response> {
                return new Response("user-app", { status: 200 });
            },
        };
        const mounted = mountChardb(StubChardb as never, userApp);
        const res = await mounted.fetch(
            new Request("https://example.com/api/auth/sign-in"),
            FAKE_ENV,
            FAKE_CTX as unknown as ExecutionContext
        );
        expect(await res.text()).toBe("user-app");
    });

    test("the chardb-reserved /ws prefix wins over the auth handler", async () => {
        const authHandler = async () => new Response("auth-ok", { status: 200 });
        const userApp = {
            async fetch(): Promise<Response> {
                return new Response("user-app", { status: 200 });
            },
        };
        const mounted = mountChardb(StubChardb as never, userApp, { authHandler });
        const res = await mounted.fetch(
            new Request("https://example.com/ws"),
            FAKE_ENV,
            FAKE_CTX as unknown as ExecutionContext
        );
        expect(await res.text()).toBe("chardb-reserved");
    });

    test("the private file handler owns only its reserved subtree", async () => {
        const userApp = {
            async fetch(): Promise<Response> {
                return new Response("user-app", { status: 200 });
            },
        };
        const mounted = mountChardb(StubChardb as never, userApp, {
            fileHandler: async request => new Response(`file:${new URL(request.url).pathname}`),
        });
        const upload = await mounted.fetch(
            new Request("https://example.com/_chardb/files/upload"),
            FAKE_ENV,
            FAKE_CTX as unknown as ExecutionContext
        );
        expect(await upload.text()).toBe("file:/_chardb/files/upload");
        expect(upload.headers.get("Cf-Chardb-Server-Version")).toBe("0.1.0");

        const dashboard = await mounted.fetch(
            new Request("https://example.com/_chardb/health"),
            FAKE_ENV,
            FAKE_CTX as unknown as ExecutionContext
        );
        expect(await dashboard.text()).toBe("chardb-reserved");
    });

    test("former placeholder prefixes fall through to application routes", async () => {
        const userApp = {
            async fetch(req: Request): Promise<Response> {
                return new Response(`user-app:${new URL(req.url).pathname}`, { status: 200 });
            },
        };
        const mounted = mountChardb(StubChardb as never, userApp);

        for (const path of ["/q", "/q/messages", "/f", "/p/typing", "/s/events"]) {
            const res = await mounted.fetch(
                new Request(`https://example.com${path}`),
                FAKE_ENV,
                FAKE_CTX as unknown as ExecutionContext
            );
            expect(await res.text()).toBe(`user-app:${path}`);
        }
    });

    test("custom authBasePath is honoured", async () => {
        const authHandler = async () => new Response("auth-ok", { status: 200 });
        const userApp = {
            async fetch(): Promise<Response> {
                return new Response("user-app", { status: 200 });
            },
        };
        const mounted = mountChardb(StubChardb as never, userApp, {
            authHandler,
            authBasePath: "/auth",
        });
        expect(
            await (
                await mounted.fetch(
                    new Request("https://example.com/auth/session"),
                    FAKE_ENV,
                    FAKE_CTX as unknown as ExecutionContext
                )
            ).text()
        ).toBe("auth-ok");
        // Default `/api/auth` should now fall through.
        expect(
            await (
                await mounted.fetch(
                    new Request("https://example.com/api/auth/session"),
                    FAKE_ENV,
                    FAKE_CTX as unknown as ExecutionContext
                )
            ).text()
        ).toBe("user-app");
    });
});
