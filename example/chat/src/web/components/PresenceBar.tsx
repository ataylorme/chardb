import { useEffect, useState } from "react";
import { useTypingPresence } from "../hooks.ts";

export interface PresenceBarProps {
    readonly channelId: string;
    readonly currentUser: string;
}

export function PresenceBar({ channelId, currentUser }: PresenceBarProps) {
    const { states } = useTypingPresence(channelId);
    // Re-render every second so stale `until` values drop off without waiting
    // for a new presence event from a peer.
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick(n => n + 1), 1_000);
        return () => clearInterval(id);
    }, []);

    const now = Date.now();
    const active = Array.from(states.values())
        .map(entry => entry.state)
        .filter(s => s.user !== currentUser && s.until > now)
        .map(s => s.user);

    if (active.length === 0) return null;

    return (
        <div className="presence">
            <span className="presence__dot" aria-hidden />
            {formatTyping(active)}
        </div>
    );
}

function formatTyping(users: readonly string[]): string {
    if (users.length === 1) return `${users[0]} is typing…`;
    if (users.length === 2) return `${users[0]} and ${users[1]} are typing…`;
    return `${users[0]} and ${users.length - 1} others are typing…`;
}
