import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
