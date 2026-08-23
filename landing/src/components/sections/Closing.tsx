import { GITHUB_URL } from "../../lib/constants";

export function Closing() {
    return (
        <section className="border-t border-line">
            <div className="mx-auto max-w-page px-5 sm:px-8 py-20 lg:py-32 text-center">
                <h2
                    className="font-semibold tracking-tight text-fg mx-auto"
                    style={{
                        fontSize: "clamp(32px, 5vw, 56px)",
                        lineHeight: 1.08,
                        letterSpacing: "-0.02em",
                        maxWidth: "18ch",
                    }}
                >
                    Does a schema-declared organization boundary fit your app?
                </h2>

                <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-5">
                    <a
                        href={GITHUB_URL}
                        rel="noopener"
                        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors"
                    >
                        Read the code and tell us where it breaks <span aria-hidden="true">→</span>
                    </a>
                </div>
            </div>
        </section>
    );
}
