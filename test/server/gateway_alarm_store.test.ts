import { describe, expect, test } from "bun:test";
import { GatewayAlarmScheduler } from "../../src/server/do/gateway-alarm-store.ts";

function alarmStorage(initial: number | null = null) {
    let alarm = initial;
    const events: string[] = [];
    const surface = {
        async getAlarm() {
            events.push("get");
            return alarm;
        },
        async setAlarm(value: number | Date) {
            alarm = value instanceof Date ? value.getTime() : value;
            events.push(`set:${alarm}`);
        },
    };
    return {
        storage: {
            ...surface,
            async transaction<T>(closure: (transaction: typeof surface) => Promise<T>): Promise<T> {
                events.push("transaction:start");
                const result = await closure(surface);
                events.push("transaction:end");
                return result;
            },
        } as unknown as DurableObjectStorage,
        events,
        alarm: () => alarm,
    };
}

describe("Gateway alarm scheduler", () => {
    test("serializes concurrent writes and retains the earliest deadline", async () => {
        const fake = alarmStorage();
        const scheduler = new GatewayAlarmScheduler(fake.storage);

        await Promise.all([
            scheduler.scheduleEarlier(500),
            scheduler.scheduleEarlier(200),
            scheduler.scheduleEarlier(800),
        ]);

        expect(fake.alarm()).toBe(200);
        expect(fake.events).toEqual(["get", "set:500", "get", "set:200", "get"]);
    });

    test("owns an earlier alarm in the same storage transaction as the mutation", async () => {
        const fake = alarmStorage(500);
        const scheduler = new GatewayAlarmScheduler(fake.storage);

        const result = await scheduler.transactionWithEarlierAlarm(300, () => {
            fake.events.push("mutation");
            return "retired";
        });

        expect(result).toBe("retired");
        expect(fake.alarm()).toBe(300);
        expect(fake.events).toEqual(["transaction:start", "get", "set:300", "mutation", "transaction:end"]);
    });

    test("rejects invalid deadlines before touching storage", async () => {
        const fake = alarmStorage();
        const scheduler = new GatewayAlarmScheduler(fake.storage);

        expect(() => scheduler.scheduleEarlier(-1)).toThrow("requestedAt must be a nonnegative safe integer");
        expect(fake.events).toEqual([]);
    });
});
