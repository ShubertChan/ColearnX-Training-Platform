import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { securityHeaders } from "./build/videoHeaders.js";
import { protectEntryHtml } from "./build/assetIntegrity.js";

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: "security-headers",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const entry = bundle["index.html"];
        const { html, mapHash } = protectEntryHtml(String(entry.source), bundle);
        entry.source = html;
        const source = securityHeaders({ ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env }, mapHash);
        this.emitFile({ type: "asset", fileName: "_headers", source });
      },
    },
  }],
  base: "./",
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
}));
