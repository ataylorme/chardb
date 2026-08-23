import { useMutation, usePresence, useQuery } from "chardb/react";
import { useCallback, useEffect, useRef } from "react";
import { uuidv7 } from "uuidv7";
import { postMessage, typing } from "../server/api.ts";
import { listMessages } from "../server/queries.ts";

import type { InferRow } from "chardb/react";

type MessageRow = InferRow<typeof listMessages>;
export type { MessageRow };

const PRESENCE_TTL_MS = 3_000;

export interface ChatMessagesResult {
    readonly data: readonly MessageRow[];
    readonly state: "pending" | "live" | "refetching" | "error" | "closed";
}

/**
 * Live-subscribe to a channel's messages. The intent extractor lives
 * with the server query in `queries.ts` (`defineQuery({intent: ...})`),
 * so we only pass `(handle, args)` here — no hand-written `CdbIntent`.
 *
 * The organizationId is read from the session's active org by the
 * server-side handler; the client only supplies the channel selection.
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

export interface TypingPresence {
    readonly states: ReadonlyMap<string, { state: { user: string; until: number }; ts: number }>;
    setTyping(user: string): void;
}

export function useTypingPresence(channelId: string): TypingPresence {
    const presence = usePresence<{ user: string; until: number }>(`typing:${channelId}`);
    const lastPublishedAt = useRef<number>(0);
    const setTyping = useCallback(
        (user: string) => {
            const now = Date.now();
            if (now - lastPublishedAt.current < 1_000) return;
            lastPublishedAt.current = now;
            presence.publish({ user, until: now + PRESENCE_TTL_MS });
        },
        [presence]
    );

    useEffect(() => {
        void typing(channelId);
    }, [channelId]);

    return { states: presence.states, setTyping };
}
