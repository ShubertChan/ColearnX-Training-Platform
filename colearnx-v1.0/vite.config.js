import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { securityHeaders } from "./build/videoHeaders.js";

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: "security-headers",
    generateBundle() {
      const source = securityHeaders({ ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env });
      if (source) this.emitFile({ type: "asset", fileName: "_headers", source });
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
