import { ChardbProvider } from "@chardb/core/react";
import { anonymousClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { useEffect, useState } from "react";
import { ChannelList } from "./components/ChannelList.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { useChatMessages } from "./hooks.ts";

const CHANNELS = [
    { id: "general", name: "general" },
    { id: "random", name: "random" },
    { id: "dev", name: "dev" },
] as const;

const authClient = createAuthClient({
    baseURL: window.location.origin,
    plugins: [anonymousClient()],
});

function chardbEndpoint(): string {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws`;
}

export function App() {
    const session = authClient.useSession();
    useEffect(() => {
        // Auto sign-in anonymously if there's no session yet. Production
        // apps replace this with a real sign-in flow; the example uses
        // anonymous so a fresh tab "just works".
        if (!session.isPending && !session.data) void authClient.signIn.anonymous();
    }, [session.isPending, session.data]);

    if (session.isPending || !session.data) {
        return <div className="loading">Signing in…</div>;
    }

    return (
        <ChardbProvider endpoint={chardbEndpoint()} auth={authClient}>
            <Workspace />
        </ChardbProvider>
    );
}

function Workspace() {
    const session = authClient.useSession();
    const userId = session.data?.user.id;
    const [channelId, setChannelId] = useState<string>("general");
    const [version, setVersion] = useState<string | null>(null);
    useEffect(() => {
        void fetch("/api/version")
            .then(async r => {
                const v = (await r.json()) as { readonly name: string; readonly version: string };
                setVersion(`${v.name}@${v.version}`);
            })
            .catch(() => setVersion(null));
    }, []);

    const { data, state } = useChatMessages(channelId);
    const userLabel = userId ?? "anonymous";

    return (
        <div className="layout">
            <aside className="sidebar">
                <header className="sidebar__header">
                    <h1>chardb chat</h1>
                    {version ? <code className="sidebar__version">{version}</code> : null}
                </header>
                <ChannelList channels={CHANNELS} currentId={channelId} onSelect={setChannelId} />
                <footer className="sidebar__footer">
                    <span className="sidebar__label">Signed in as</span>
                    <code className="sidebar__user">{userLabel}</code>
                </footer>
            </aside>
            <main className="main">
                <header className="main__header">
                    <h2># {channelId}</h2>
                    <span className={`status status--${state}`}>{state}</span>
                </header>
                <MessageList messages={data} state={state} currentUser={userLabel} />
                <Composer channelId={channelId} />
            </main>
        </div>
    );
}
