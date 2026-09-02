import { useRef, useState } from "react";
import { INSTALL_CMD } from "../lib/constants";

type Props = {
    text?: string;
};

export function CopyPill({ text = INSTALL_CMD }: Props) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<number | null>(null);

    const onCopy = async () => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.setAttribute("readonly", "");
                ta.style.position = "absolute";
                ta.style.left = "-9999px";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
            }
            setCopied(true);
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1400);
        } catch {
            // noop
        }
    };

    return (
        <div className="relative flex w-full max-w-full items-center gap-2 rounded-full border border-line2 bg-ink-850 py-1.5 pl-4 pr-1.5 font-mono text-xs sm:w-fit sm:text-sm">
            <span className="text-fg-dim select-none">$</span>
            <code className="min-w-0 flex-1 truncate whitespace-nowrap text-fg">{text}</code>
            <button
                type="button"
                onClick={onCopy}
                aria-label={copied ? "Copied" : `Copy ${text} to clipboard`}
                className="ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-ink-950 transition hover:brightness-110"
            >
                {copied ? (
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-4 w-4"
                        aria-hidden="true"
                    >
                        <path d="M5 12l4 4L19 7" />
                    </svg>
                ) : (
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-4 w-4"
                        aria-hidden="true"
                    >
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15V6a2 2 0 0 1 2-2h9" />
                    </svg>
                )}
            </button>
            <output
                className={`toast absolute -bottom-7 left-2 text-xs text-accent font-sans${copied ? " show" : ""}`}
                aria-live="polite"
            >
                copied
            </output>
        </div>
    );
}
