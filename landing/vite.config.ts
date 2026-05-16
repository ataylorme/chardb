import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, "index.html"),
                og: resolve(__dirname, "og.html"),
                favicon: resolve(__dirname, "favicon.html"),
            },
        },
    },
});
