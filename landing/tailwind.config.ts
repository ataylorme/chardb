import type { Config } from "tailwindcss";

export default {
    content: ["./index.html", "./src/**/*.{ts,tsx}"],
    darkMode: "class",
    theme: {
        extend: {
            colors: {
                ink: {
                    950: "#0A0A0A",
                    900: "#0E0E0E",
                    850: "#111111",
                    800: "#161616",
                    700: "#1C1C1C",
                },
                line: "rgba(255,255,255,0.06)",
                line2: "rgba(255,255,255,0.10)",
                fg: {
                    DEFAULT: "#EDEDED",
                    muted: "#9A9A9A",
                    dim: "#5A5A5A",
                },
                accent: {
                    DEFAULT: "#EC5713",
                    soft: "#FF8858",
                },
                syn: {
                    kw: "#FF8858",
                    str: "#9ECBFF",
                    ident: "#EDEDED",
                    fn: "#E1C8FF",
                    num: "#F2C66B",
                    cmt: "#5A5A5A",
                    punc: "#9A9A9A",
                },
            },
            fontFamily: {
                sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
                mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
            },
            maxWidth: {
                page: "1100px",
            },
        },
    },
} satisfies Config;
