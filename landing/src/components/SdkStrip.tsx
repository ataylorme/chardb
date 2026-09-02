const sdks = [
    { name: "React", icon: "/brands/react.svg", available: true },
    { name: "Rust", icon: "/brands/rust.svg", available: true },
    { name: "Python", icon: "/brands/python.svg", available: false },
    { name: "Swift", icon: "/brands/swift.svg", available: false },
    { name: "Flutter", icon: "/brands/flutter.svg", available: false },
    { name: "Expo", icon: "/brands/expo.svg", available: false },
] as const;

export function SdkStrip() {
    return (
        <section aria-labelledby="sdk-heading" className="border-t border-line">
            <div className="mx-auto max-w-page px-5 py-8 sm:px-8">
                <div className="mb-4 flex items-end justify-between gap-6">
                    <div>
                        <p id="sdk-heading" className="font-mono text-xs text-accent">
                            Client SDKs
                        </p>
                        <p className="mt-2 text-sm text-fg-muted">
                            React and Rust ship today. More clients are planned.
                        </p>
                    </div>
                </div>
                <ul className="sdk-grid" aria-label="SDK availability">
                    {sdks.map(sdk => (
                        <li className={`sdk-chip${sdk.available ? " is-available" : ""}`} key={sdk.name}>
                            <span className="sdk-icon-shell">
                                <img src={sdk.icon} alt="" width="28" height="28" />
                            </span>
                            <span className="sdk-name">{sdk.name}</span>
                            <span className="sdk-status">{sdk.available ? "Available" : "Coming soon"}</span>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    );
}
