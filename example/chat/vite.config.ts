/**
 * Vite config for the chardb chat example.
 *
 * The chardb Vite plugin scans server exports and stamps their wire refs.
 * This config consumes the plugin through the package's public `@chardb/core/vite`
 * export. Query and mutation modules become ref-only browser handles.
 */

import { chardb as chardbVitePlugin } from "@chardb/core/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workerOrigin = process.env.CHARDB_URL ?? "http://127.0.0.1:8787";
const workerSocket = workerOrigin.replace(/^http/, "ws");

export default defineConfig({
    plugins: [react(), chardbVitePlugin()],
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
    resolve: {
        preserveSymlinks: true,
    },
    server: {
        host: "127.0.0.1",
        port: 5173,
        strictPort: true,
        proxy: {
            "/ws": { target: workerSocket, ws: true, changeOrigin: true },
            "/_chardb": workerOrigin,
            "/api": workerOrigin,
        },
    },
});
