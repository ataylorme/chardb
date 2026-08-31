import { useEffect, useRef } from "react";
import type { MessageRow } from "../hooks.ts";

export interface MessageListProps {
    readonly messages: readonly MessageRow[];
    readonly state: "pending" | "live" | "refetching" | "error" | "closed";
    readonly currentUser: string;
}

export function MessageList({ messages, state, currentUser }: MessageListProps) {
    const endRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (messages.length === 0) return;
        endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }, [messages]);

    if (state === "pending") {
        return <div className="message-list message-list--empty">Connecting to chardb…</div>;
    }
    if (state === "error") {
        return <div className="message-list message-list--empty">Subscription error.</div>;
    }

    if (messages.length === 0) {
        return (
            <div className="message-list message-list--empty">
                No messages yet. Open another tab to see realtime sync in action.
            </div>
        );
    }

    return (
        <div className="message-list">
            {messages.map(m => (
                <article
                    key={m.id}
                    className={`message ${m.authorId === currentUser ? "message--mine" : "message--theirs"}`}
                >
                    <header className="message__header">
                        <span className="message__author">{m.authorId}</span>
                        <time className="message__ts" dateTime={new Date(m.createdAt).toISOString()}>
                            {formatTime(m.createdAt)}
                        </time>
                    </header>
                    <p className="message__body">{m.body}</p>
                </article>
            ))}
            <div ref={endRef} />
        </div>
    );
}

function formatTime(ms: number): string {
    const d = new Date(ms);
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
}
