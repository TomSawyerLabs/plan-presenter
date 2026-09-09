import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HOST_PORT = process.env.PP_PORT ?? "27411";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 27412,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${HOST_PORT}`,
      "/ws": { target: `ws://127.0.0.1:${HOST_PORT}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          mermaid: ["mermaid"],
          mdx: ["@mdx-js/mdx", "@mdx-js/react"],
        },
      },
    },
  },
});
