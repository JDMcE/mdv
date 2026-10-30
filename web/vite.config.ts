import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "../internal/server/dist",
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": { target: "http://localhost:8080", ws: true } },
  },
});
