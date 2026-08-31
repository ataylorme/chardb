import { useMutation, useQuery } from "@chardb/react";
import { useCallback } from "react";
import { uuidv7 } from "uuidv7";
import { postMessage } from "../server/api.ts";
import { listMessages } from "../server/queries.ts";

import type { InferRow } from "@chardb/react";

type MessageRow = InferRow<typeof listMessages>;
export type { MessageRow };

export interface ChatMessagesResult {
    readonly data: readonly MessageRow[];
    readonly state: "pending" | "live" | "refetching" | "error" | "closed";
}

/**
 * Live-subscribe to a channel's messages. The server-owned intent extractor
 * lives with the query in `queries.ts` (`defineQuery({intent: ...})`),
 * so we only pass `(handle, args)` here — no hand-written `CdbIntent`.
 *
 * This demo explicitly sends its fixed organizationId with the query args.
 * The server must match it against membership-derived authority; the client
 * value is routing input, not proof of access.
 */
export function useChatMessages(channelId: string, limit = 50): ChatMessagesResult {
    const args = { organizationId: "demo-org", channelId, limit };
    const { data, state } = useQuery(listMessages, args);
    const sorted = data ? [...data].sort((a, b) => a.createdAt - b.createdAt) : [];
    return { data: sorted, state };
}

export interface UsePostMessage {
    send(input: { readonly body: string }): Promise<{ readonly id: string }>;
}

export function usePostMessage(channelId: string): UsePostMessage {
    const mutate = useMutation<Parameters<typeof postMessage>[1], { readonly id: string }>(postMessage);
    const send = useCallback(
        (input: { readonly body: string }) =>
            mutate({
                id: uuidv7(),
                organizationId: "demo-org",
                channelId,
                body: input.body,
                clientCreatedAt: Date.now(),
            }),
        [mutate, channelId]
    );
    return { send };
}
