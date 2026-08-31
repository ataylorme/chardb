import { VSHARD_COUNT, vshardOf } from "../vshard.ts";

const VSHARDS_PER_GATEWAY_BUCKET = 4;

/** Number of logical Gateway Durable Object names used for client routing. */
export const GATEWAY_BUCKET_COUNT = VSHARD_COUNT / VSHARDS_PER_GATEWAY_BUCKET;

/**
 * Map a client id to one of 4,096 stable Gateway Durable Object names.
 *
 * This reuses the pinned xxhash64 virtual-shard hash and groups four adjacent
 * virtual shards per Gateway bucket. Keep this mapping stable after 1.0.
 */
export function gatewayBucketName(clientId: string): string {
    const bucket = Number(vshardOf([clientId])) >> 2;
    return `gateway-${bucket}`;
}
