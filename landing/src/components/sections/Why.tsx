import type { ReactNode } from "react";
import whyMarkdown from "../../content/Why.md?raw";

type MarkdownBlock =
    | { kind: "heading"; level: 1 | 2; text: string }
    | { kind: "paragraph"; text: string }
    | { kind: "quote"; text: string };

function parseMarkdown(source: string): MarkdownBlock[] {
    return source
        .trim()
        .split(/\n\s*\n/)
        .map(block => block.replace(/\s*\n\s*/g, " ").trim())
        .map(block => {
            if (block.startsWith("## ")) return { kind: "heading", level: 2, text: block.slice(3) } as const;
            if (block.startsWith("# ")) return { kind: "heading", level: 1, text: block.slice(2) } as const;
            if (block.startsWith("> ")) return { kind: "quote", text: block.slice(2) } as const;
            return { kind: "paragraph", text: block } as const;
        });
}

function renderInline(text: string): ReactNode[] {
    const token = /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    const nodes: ReactNode[] = [];
    let cursor = 0;

    for (const match of text.matchAll(token)) {
        const index = match.index ?? 0;
        if (index > cursor) nodes.push(text.slice(cursor, index));

        const value = match[0];
        if (value.startsWith("`")) {
            nodes.push(<code key={index}>{value.slice(1, -1)}</code>);
        } else {
            const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
            if (link) {
                nodes.push(
                    <a
                        key={index}
                        href={link[2]}
                        target="_blank"
                        rel="noreferrer"
                        className="text-fg underline decoration-line underline-offset-4 transition-colors hover:text-accent"
                    >
                        {link[1]}
                    </a>
                );
            }
        }
        cursor = index + value.length;
    }

    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
}

const blocks = parseMarkdown(whyMarkdown);
const title = blocks.find(block => block.kind === "heading" && block.level === 1)?.text ?? "Why I built CharDB";
const intro = blocks.find(block => block.kind === "paragraph")?.text ?? "";
const articleBlocks = blocks.slice(blocks.findIndex(block => block.kind === "heading" && block.level === 2));
const quoteIndex = articleBlocks.findIndex(block => block.kind === "quote");
const quote = quoteIndex >= 0 ? articleBlocks[quoteIndex] : undefined;
const postscriptIndex = articleBlocks.findIndex(block => block.kind === "heading" && block.text === "P.S. Cloudflare");
const postscript = articleBlocks.slice(postscriptIndex + 1).find(block => block.kind === "paragraph");
const storyBlocks = articleBlocks.slice(0, quoteIndex >= 0 ? quoteIndex : postscriptIndex);
const stories = storyBlocks.reduce<Array<{ title: string; paragraphs: string[] }>>((sections, block) => {
    if (block.kind === "heading") {
        sections.push({ title: block.text, paragraphs: [] });
    } else if (block.kind === "paragraph") {
        sections.at(-1)?.paragraphs.push(block.text);
    }
    return sections;
}, []);

export function Why() {
    return (
        <section id="why">
            <article className="mx-auto max-w-page px-5 py-16 sm:px-8 lg:py-28">
                <p className="eyebrow">founder note / august 2026</p>

                <div className="mt-4 grid grid-cols-1 items-start gap-10 lg:grid-cols-12 lg:gap-16">
                    <header className="lg:sticky lg:top-24 lg:col-span-5">
                        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{title}</h1>
                        <p className="mt-5 text-[17px] leading-7 text-fg-muted">{intro}</p>
                        <a
                            href="/"
                            className="mt-7 inline-flex items-center gap-1 text-sm text-fg-muted transition-colors hover:text-fg"
                        >
                            Back to the product <span aria-hidden="true">→</span>
                        </a>
                    </header>

                    <div className="space-y-10 lg:col-span-7">
                        {stories.map(story => (
                            <section
                                className="border-t border-line pt-8 first:border-t-0 first:pt-0"
                                key={story.title}
                            >
                                <h2 className="text-xl font-semibold tracking-tight text-fg">{story.title}</h2>
                                <div className="mt-4 space-y-4 leading-7 text-fg-muted">
                                    {story.paragraphs.map(paragraph => (
                                        <p key={paragraph}>{renderInline(paragraph)}</p>
                                    ))}
                                </div>
                            </section>
                        ))}

                        {quote?.kind === "quote" ? (
                            <blockquote className="border-l-2 border-accent pl-5 text-xl leading-8 tracking-tight text-fg sm:text-2xl sm:leading-9">
                                {quote.text}
                            </blockquote>
                        ) : null}

                        <aside className="border-t border-accent/50 pt-8" aria-labelledby="cloudflare-postscript">
                            <h2 id="cloudflare-postscript" className="font-mono text-sm tracking-tight text-accent">
                                P.S. Cloudflare
                            </h2>
                            {postscript?.kind === "paragraph" ? (
                                <p className="mt-4 text-xl leading-8 tracking-tight text-fg sm:text-2xl sm:leading-9">
                                    {renderInline(postscript.text)}
                                </p>
                            ) : null}
                        </aside>
                    </div>
                </div>
            </article>
        </section>
    );
}
