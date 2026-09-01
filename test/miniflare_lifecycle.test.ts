import { describe, expect, test } from "bun:test";
import { disposeMiniflareBounded, restartMiniflareBounded } from "../scripts/miniflare-lifecycle.mjs";

describe("bounded Miniflare lifecycle", () => {
    test("returns after the disposal deadline instead of hanging", async () => {
        const diagnostics: string[] = [];
        let timeoutCalls = 0;
        const startedAt = performance.now();
        const result = await disposeMiniflareBounded(
            { dispose: () => new Promise(() => undefined) },
            {
                timeoutMs: 20,
                label: "stuck fixture",
                diagnose: message => diagnostics.push(message),
                onTimeout: () => {
                    timeoutCalls++;
                },
            }
        );

        expect(result).toEqual({ status: "timed-out" });
        expect(performance.now() - startedAt).toBeLessThan(500);
        expect(timeoutCalls).toBe(1);
        expect(diagnostics).toEqual(["stuck fixture disposal exceeded 20ms; continuing after the deadline"]);
    });

    test("restarts when the old process rejects disposal after a broken pipe", async () => {
        const diagnostics: string[] = [];
        const brokenPipe = new Error("write EPIPE");
        const next = {
            ready: Promise.resolve(new URL("http://127.0.0.1:8787")),
            dispose: async () => undefined,
        };
        const result = await restartMiniflareBounded({ dispose: async () => Promise.reject(brokenPipe) }, () => next, {
            settleDelayMs: 0,
            diagnose: message => diagnostics.push(message),
        });

        expect(result.instance).toBe(next);
        expect(result.origin).toEqual(new URL("http://127.0.0.1:8787"));
        expect(result.disposal).toEqual({ status: "rejected", error: brokenPipe });
        expect(diagnostics).toEqual([
            "Miniflare restart teardown disposal rejected; continuing because the instance is no longer usable",
        ]);
    });

    test("bounds startup and disposes the failed replacement", async () => {
        let replacementDisposals = 0;
        const replacement = {
            ready: new Promise<URL>(() => undefined),
            dispose: async () => {
                replacementDisposals++;
            },
        };

        await expect(
            restartMiniflareBounded(undefined, () => replacement, {
                disposeTimeoutMs: 20,
                readyTimeoutMs: 20,
                settleDelayMs: 0,
                label: "stuck replacement",
                diagnose: () => undefined,
            })
        ).rejects.toThrow("stuck replacement did not become ready within 20ms");
        expect(replacementDisposals).toBe(1);
    });

    test("disposes a replacement whose ready promise rejects", async () => {
        const startupError = new Error("workerd exited");
        let replacementDisposals = 0;
        const replacement = {
            ready: Promise.reject(startupError),
            dispose: async () => {
                replacementDisposals++;
            },
        };

        await expect(
            restartMiniflareBounded(undefined, () => replacement, {
                settleDelayMs: 0,
                diagnose: () => undefined,
            })
        ).rejects.toBe(startupError);
        expect(replacementDisposals).toBe(1);
    });

    test("waits for the old Workerd control socket to settle before replacement", async () => {
        let disposedAt = 0;
        let startedAt = 0;
        const next = {
            ready: Promise.resolve(new URL("http://127.0.0.1:8787")),
            dispose: async () => undefined,
        };

        await restartMiniflareBounded(
            {
                dispose: async () => {
                    disposedAt = performance.now();
                },
            },
            () => {
                startedAt = performance.now();
                return next;
            },
            { settleDelayMs: 20, diagnose: () => undefined }
        );

        expect(startedAt - disposedAt).toBeGreaterThanOrEqual(15);
    });
});
