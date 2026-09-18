import { build, preview } from "vite";
import { videoHeaders } from "../../build/videoHeaders.js";
// Exercise the production bundle, including its lazy-loaded HLS engine.
await build({ configLoader: "native", build: { outDir: "work/e2e-site" } });
const headers = Object.fromEntries((videoHeaders(process.env) || "").split("\n").filter(line => line.startsWith("  ")).map(line => { const split = line.indexOf(":"); return [line.slice(0, split).trim(), line.slice(split + 1).trim()]; }));
await preview({ configLoader: "native", build: { outDir: "work/e2e-site" }, preview: { host: "127.0.0.1", port: 4178, strictPort: true, headers } });
