import { describe, expect, test } from "bun:test";
import { GATEWAY_BUCKET_COUNT, gatewayBucketName } from "../../src/server/gateway-bucket.ts";
import { vshardOf } from "../../src/vshard.ts";

function bucketNumber(clientId: string): number {
    const name = gatewayBucketName(clientId);
    const match = /^gateway-(0|[1-9][0-9]*)$/.exec(name);
    if (!match?.[1]) throw new Error(`invalid Gateway bucket name: ${name}`);
    return Number(match[1]);
}

describe("Gateway client bucketing", () => {
    test("pins deterministic names to groups of four virtual shards", () => {
        expect(GATEWAY_BUCKET_COUNT).toBe(4_096);
        expect(gatewayBucketName("")).toBe("gateway-2662");
        expect(gatewayBucketName("client-1")).toBe("gateway-3260");
        expect(gatewayBucketName("client-2")).toBe("gateway-2170");
        expect(gatewayBucketName("00000000-0000-4000-8000-000000000000")).toBe("gateway-519");
        expect(gatewayBucketName("café-🚀")).toBe("gateway-1791");

        for (const clientId of ["", "client-1", "client-2", "café-🚀"]) {
            expect(bucketNumber(clientId)).toBe(Number(vshardOf([clientId])) >> 2);
            expect(gatewayBucketName(clientId)).toBe(gatewayBucketName(clientId));
        }
    });

    test("does not force clients with the same twelve-character prefix onto one Gateway", () => {
        expect("shared-prefix-A".slice(0, 12)).toBe("shared-prefix-B".slice(0, 12));
        expect(gatewayBucketName("shared-prefix-A")).toBe("gateway-1490");
        expect(gatewayBucketName("shared-prefix-B")).toBe("gateway-390");
    });

    test("covers all 4,096 buckets with bounded deterministic sample skew", () => {
        const samples = GATEWAY_BUCKET_COUNT * 32;
        const counts = new Uint32Array(GATEWAY_BUCKET_COUNT);
        for (let index = 0; index < samples; index++) {
            const bucket = bucketNumber(`distribution-client-${index}`);
            if (bucket < 0 || bucket >= GATEWAY_BUCKET_COUNT) {
                throw new Error(`Gateway bucket ${bucket} is outside the logical namespace`);
            }
            counts[bucket] = (counts[bucket] ?? 0) + 1;
        }

        expect(counts.every(count => count > 0)).toBe(true);
        expect(Math.max(...counts)).toBeLessThanOrEqual((samples / GATEWAY_BUCKET_COUNT) * 2);
    });
});
