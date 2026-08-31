export interface ChannelListProps {
    readonly channels: readonly { readonly id: string; readonly name: string }[];
    readonly currentId: string;
    onSelect(id: string): void;
}

export function ChannelList({ channels, currentId, onSelect }: ChannelListProps) {
    return (
        <nav className="channels">
            <h2 className="channels__title">Channels</h2>
            <ul className="channels__list">
                {channels.map(c => (
                    <li key={c.id}>
                        <button
                            type="button"
                            className={`channels__item ${c.id === currentId ? "channels__item--active" : ""}`}
                            onClick={() => onSelect(c.id)}
                        >
                            <span aria-hidden>#</span> {c.name}
                        </button>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
