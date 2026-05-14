import { describe, expect, test } from "bun:test";
import { type CronHandle, InMemoryVectorize, cronMatches, runCronSimulator } from "../src/miniflare-plugin/index.ts";

describe("InMemoryVectorize", () => {
    test("upserts and queries by cosine similarity", () => {
        const v = new InMemoryVectorize(3);
        v.upsert([
            { id: "a", values: [1, 0, 0] },
            { id: "b", values: [0, 1, 0] },
            { id: "c", values: [0.9, 0.1, 0] },
        ]);
        const { matches } = v.query([1, 0, 0], { topK: 2 });
        expect(matches[0]?.id).toBe("a");
        expect(matches[1]?.id).toBe("c");
    });

    test("rejects mismatched dimensions", () => {
        const v = new InMemoryVectorize(3);
        expect(() => v.upsert([{ id: "x", values: [1, 0] }])).toThrow();
    });
});

describe("cronMatches", () => {
    test("every minute matches", () => {
        expect(cronMatches("* * * * *", new Date("2026-05-10T12:34:00Z"))).toBe(true);
    });

    test("specific hour and minute", () => {
        expect(cronMatches("0 12 * * *", new Date("2026-05-10T12:00:00Z"))).toBe(true);
        expect(cronMatches("0 12 * * *", new Date("2026-05-10T12:01:00Z"))).toBe(false);
    });

    test("step expression", () => {
        expect(cronMatches("*/15 * * * *", new Date("2026-05-10T12:30:00Z"))).toBe(true);
        expect(cronMatches("*/15 * * * *", new Date("2026-05-10T12:31:00Z"))).toBe(false);
    });

    test("ranges", () => {
        expect(cronMatches("0 9-17 * * 1-5", new Date("2026-05-11T09:00:00Z"))).toBe(true);
        expect(cronMatches("0 9-17 * * 1-5", new Date("2026-05-11T18:00:00Z"))).toBe(false);
    });

    test("rejects invalid expressions", () => {
        expect(cronMatches("not a cron", new Date())).toBe(false);
        expect(cronMatches("* * *", new Date())).toBe(false);
    });
});

function makeHandle(expr: string, onFire: (occurrence: Date) => void): CronHandle {
    const fn = (() => {
        /* will be invoked via opts.invoke or directly */
    }) as unknown as CronHandle & ((occ?: Date) => void);
    Object.assign(fn, { __chardbCron: expr });
    // Inline self-handler used by the default invoke path.
    (fn as unknown as { _onFire: typeof onFire })._onFire = onFire;
    return fn;
}

describe("runCronSimulator", () => {
    test("fires every-minute handler at every step in the window", async () => {
        const fires: Date[] = [];
        const everyMinute = makeHandle("* * * * *", () => {});
        const report = await runCronSimulator([everyMinute], {
            start: new Date("2026-05-10T00:00:00Z"),
            end: new Date("2026-05-10T00:04:00Z"),
            stepMs: 60_000,
            invoke: (_h, occ) => {
                fires.push(occ);
            },
        });
        // 5 minutes inclusive → 5 fires.
        expect(report.fires.length).toBe(5);
        expect(report.stepsEvaluated).toBe(5);
        expect(fires.map(f => f.toISOString())).toEqual([
            "2026-05-10T00:00:00.000Z",
            "2026-05-10T00:01:00.000Z",
            "2026-05-10T00:02:00.000Z",
            "2026-05-10T00:03:00.000Z",
            "2026-05-10T00:04:00.000Z",
        ]);
    });

    test("fires `*/15 * * * *` exactly 4× per hour", async () => {
        const fires: Date[] = [];
        const quarterHourly = makeHandle("*/15 * * * *", () => {});
        const report = await runCronSimulator([quarterHourly], {
            start: new Date("2026-05-10T00:00:00Z"),
            end: new Date("2026-05-10T00:59:00Z"),
            invoke: (_h, occ) => {
                fires.push(occ);
            },
        });
        expect(report.fires.length).toBe(4);
        expect(fires.map(f => f.getUTCMinutes())).toEqual([0, 15, 30, 45]);
    });

    test("multiple handles fire independently and the report records both", async () => {
        const top = makeHandle("0 * * * *", () => {});
        const half = makeHandle("30 * * * *", () => {});
        const report = await runCronSimulator([top, half], {
            start: new Date("2026-05-10T00:00:00Z"),
            end: new Date("2026-05-10T01:00:00Z"),
        });
        const exprs = report.fires.map(f => f.cronExpr).sort();
        expect(exprs).toEqual(["0 * * * *", "0 * * * *", "30 * * * *"]);
    });

    test("default invoke awaits handler completion sequentially", async () => {
        const order: string[] = [];
        const slow: CronHandle = Object.assign(
            async () => {
                await new Promise(r => setTimeout(r, 5));
                order.push("slow-done");
            },
            { __chardbCron: "* * * * *" }
        ) as CronHandle;
        const fast: CronHandle = Object.assign(
            async () => {
                order.push("fast-done");
            },
            { __chardbCron: "* * * * *" }
        ) as CronHandle;
        await runCronSimulator([slow, fast], {
            start: new Date("2026-05-10T00:00:00Z"),
            end: new Date("2026-05-10T00:00:00Z"),
        });
        expect(order).toEqual(["slow-done", "fast-done"]);
    });

    test("rejects non-positive stepMs and inverted ranges", async () => {
        const h = makeHandle("* * * * *", () => {});
        await expect(runCronSimulator([h], { stepMs: 0 })).rejects.toThrow(/stepMs/);
        await expect(
            runCronSimulator([h], {
                start: new Date("2026-05-10T01:00:00Z"),
                end: new Date("2026-05-10T00:00:00Z"),
            })
        ).rejects.toThrow(/end must be >= start/);
    });
});
