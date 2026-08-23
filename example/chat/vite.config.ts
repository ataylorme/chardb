/**
 * Vite config for the chardb chat example.
 *
 * The chardb Vite plugin scans server exports and stamps their wire refs.
 * This config consumes the plugin through the package's public `chardb/vite`
 * export. The browser shim below is temporary: query handles still share a
 * module graph with workerd-only server code.
 */

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chardb as chardbVitePlugin } from "chardb/vite";
import { defineConfig } from "vite";

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
    resolve: {
        preserveSymlinks: true,
        // Query handles currently share a module graph with the Worker. Vite
        // needs a browser-safe stand-in for workerd's built-in module while it
        // tree-shakes the server-only classes from the SPA build.
        alias: [
            {
                find: "cloudflare:workers",
                replacement: fileURLToPath(new URL("./src/web/cloudflare-workers-shim.ts", import.meta.url)),
            },
        ],
    },
    server: {
        port: 5173,
        proxy: {
            "/ws": { target: "ws://localhost:8787", ws: true },
            "/_chardb": "http://localhost:8787",
            "/api": "http://localhost:8787",
        },
    },
});
