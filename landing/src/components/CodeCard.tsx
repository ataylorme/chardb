import type { ReactNode } from "react";

type Props = {
    filename?: string;
    header?: ReactNode;
    children: ReactNode;
};

export function CodeCard({ filename, header, children }: Props) {
    return (
        <div className="rounded-xl border border-line code-card-bg overflow-hidden">
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-line">
                <span className="h-2.5 w-2.5 rounded-full bg-fg-dim/40" />
                <span className="h-2.5 w-2.5 rounded-full bg-fg-dim/30" />
                <span className="h-2.5 w-2.5 rounded-full bg-fg-dim/20" />
                {header ? (
                    <div className="ml-3 flex items-center gap-1 font-mono text-[11px]">{header}</div>
                ) : (
                    <span className="ml-3 font-mono text-[11px] text-fg-dim">{filename}</span>
                )}
            </div>
            <pre className="font-mono text-[13px] leading-[1.7] p-5 overflow-x-auto">
                <code>{children}</code>
            </pre>
        </div>
    );
}
