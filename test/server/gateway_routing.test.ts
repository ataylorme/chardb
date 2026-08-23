import { describe, expect, test } from "bun:test";
import { shardsForIntent } from "../../src/server/do/gateway.ts";
import type { CatalogRoutingRpc } from "../../src/server/rpc.ts";
import { ShardId } from "../../src/types.ts";
import type { CdbIntent } from "../../src/wire.ts";

function intent(overrides: Partial<CdbIntent> = {}): CdbIntent {
    return { kind: "select", tables: ["messages"], ...overrides };
}

describe("Gateway query routing", () => {
    test("scatter uses the Catalog shard inventory without probing vshards", async () => {
        let routeCalls = 0;
        let inventoryCalls = 0;
        const catalog: CatalogRoutingRpc = {
            async route() {
                routeCalls++;
                return { shardId: ShardId("unexpected"), schemaEpoch: 1 };
            },
            async listShardIds() {
                inventoryCalls++;
                return [ShardId("ShardDO_0"), ShardId("ShardDO_narrow")];
            },
        };

        await expect(shardsForIntent(catalog, intent({ joinShape: "cross-partition" }))).resolves.toEqual([
            "ShardDO_0",
            "ShardDO_narrow",
        ]);
        expect(routeCalls).toBe(0);
        expect(inventoryCalls).toBe(1);
    });

    test("partition values still use point routing and deduplicate physical shards", async () => {
        const routedVshards: number[] = [];
        const catalog: CatalogRoutingRpc = {
            async route(vshard) {
                routedVshards.push(vshard);
                return { shardId: ShardId("ShardDO_one"), schemaEpoch: 1 };
            },
            async listShardIds() {
                throw new Error("point routing must not enumerate shards");
            },
        };

        await expect(
            shardsForIntent(
                catalog,
                intent({ partitionKey: { table: "messages", column: "organization_id", values: ["org-1", "org-2"] } })
            )
        ).resolves.toEqual(["ShardDO_one"]);
        expect(routedVshards).toHaveLength(2);
    });

    test("reference queries still route through vshard zero", async () => {
        const routedVshards: number[] = [];
        const catalog: CatalogRoutingRpc = {
            async route(vshard) {
                routedVshards.push(vshard);
                return { shardId: ShardId("ShardDO_reference"), schemaEpoch: 1 };
            },
            async listShardIds() {
                throw new Error("reference routing must not enumerate shards");
            },
        };

        await expect(shardsForIntent(catalog, intent({ joinShape: "reference" }))).resolves.toEqual([
            "ShardDO_reference",
        ]);
        expect(routedVshards).toEqual([0]);
    });
});
