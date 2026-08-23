import type { ReactNode } from "react";

type Props = {
    id: string;
    num: string;
    label: string;
    children: ReactNode;
};

export function Section({ id, num, label, children }: Props) {
    return (
        <section id={id} className="border-t border-line">
            <div className="mx-auto max-w-page px-5 sm:px-8 py-16 lg:py-28">
                <p className="eyebrow">
                    <span className="num">{num}</span> / {label}
                </p>
                {children}
            </div>
        </section>
    );
}

export function SectionHeading({ children }: { children: ReactNode }) {
    return (
        <h2
            className="mt-4 font-semibold tracking-tight text-fg"
            style={{ fontSize: "clamp(28px, 4vw, 44px)", lineHeight: 1.1, letterSpacing: "-0.015em" }}
        >
            {children}
        </h2>
    );
}

export function SectionLead({ children }: { children: ReactNode }) {
    return (
        <p className="mt-5 max-w-2xl text-fg-muted" style={{ fontSize: 17, lineHeight: 1.6 }}>
            {children}
        </p>
    );
}

export function BulletList({ items }: { items: readonly string[] }) {
    return (
        <ul className="mt-8 space-y-3 text-fg" style={{ fontSize: 16 }}>
            {items.map(item => (
                <li key={item} className="flex gap-3">
                    <span className="mt-2.5 h-1 w-3 bg-fg-dim/60 shrink-0" />
                    <span>{item}</span>
                </li>
            ))}
        </ul>
    );
}

export function PullQuote({ children }: { children: ReactNode }) {
    return <blockquote className="pullquote mt-10">{children}</blockquote>;
}

export function InlineCode({ children }: { children: ReactNode }) {
    return <code className="font-mono text-fg text-[0.95em]">{children}</code>;
}
