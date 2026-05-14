/**
 * Vite config for the chardb chat example.
 *
 * The chardb Vite plugin (`@chardb/vite-plugin`) walks every `defineMutation`
 * / `defineQuery` / `definePresenceKey` export under `src/server/**` and
 * stamps a deterministic wire id onto each, so the React frontend can pass
 * the function value to `useMutation(postMessage)` without the developer
 * ever typing a wire string.
 *
 * Install once (vite, @vitejs/plugin-react, react-dom are not part of the
 * chardb workspace install — they're only needed if you actually want to
 * spin the SPA up):
 *
 *   cd example/chat
 *   bun add -d vite @vitejs/plugin-react
 *   bun add react react-dom
 *
 * Run `bun run dev` to start the Vite dev server and `bun run build` to
 * produce static assets the wrangler `assets` binding can serve in front of
 * the chardb Worker.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { chardb as chardbVitePlugin } from "chardb/vite/index.ts";

export default defineConfig({
    plugins: [
        react(),
        chardbVitePlugin({
            schema: "./src/server/schema.ts",
            serverModuleGlob: "./src/server/**/*.ts",
        }),
    ],
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        proxy: {
            "/ws": { target: "ws://localhost:8787", ws: true },
            "/q": "http://localhost:8787",
            "/p": "http://localhost:8787",
            "/s": "http://localhost:8787",
            "/f": "http://localhost:8787",
            "/_chardb": "http://localhost:8787",
            "/api": "http://localhost:8787",
        },
    },
});
