import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { videoHeaders } from "./build/videoHeaders.js";

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: "hosted-video-headers",
    generateBundle() {
      const source = videoHeaders({ ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env });
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
