import react from "@vitejs/plugin-react";
import { chardb } from "@chardb/core/vite";
import { defineConfig } from "vite";

const workerOrigin = process.env.CHARDB_URL ?? "http://127.0.0.1:8787";
const workerSocket = workerOrigin.replace(/^http/, "ws");

export default defineConfig({
  publicDir: false,
  plugins: [
    react(),
    chardb(),
  ],
  build: {
    outDir: "public",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": { target: workerSocket, ws: true, changeOrigin: true },
      "/_chardb": {
        target: workerOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", request => request.setHeader("origin", workerOrigin));
        },
      },
      "/api": workerOrigin,
      "/health": workerOrigin,
    },
  },
});
