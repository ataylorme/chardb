import { useCallback, useState } from "react";
import { usePostMessage } from "../hooks.ts";

export interface ComposerProps {
    readonly channelId: string;
}

export function Composer({ channelId }: ComposerProps) {
    const [body, setBody] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { send } = usePostMessage(channelId);

    const submit = useCallback(async () => {
        const trimmed = body.trim();
        if (!trimmed || pending) return;
        setPending(true);
        setError(null);
        try {
            // The server reads `authorId` from `ctx.auth.userId` — the
            // composer never sends a user id over the wire.
            await send({ body: trimmed });
            setBody("");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(false);
        }
    }, [body, pending, send]);

    return (
        <form
            className="composer"
            onSubmit={e => {
                e.preventDefault();
                void submit();
            }}
        >
            <input
                className="composer__input"
                type="text"
                value={body}
                placeholder={`Message #${channelId}`}
                disabled={pending}
                onChange={e => {
                    setBody(e.target.value);
                }}
            />
            <button className="composer__send" type="submit" disabled={!body.trim() || pending}>
                {pending ? "Sending…" : "Send"}
            </button>
            {error ? <span className="composer__error">{error}</span> : null}
        </form>
    );
}
