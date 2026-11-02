import { build, preview } from "vite";
import { readFile } from "node:fs/promises";
// Exercise the production bundle, including its lazy-loaded HLS engine.
await build({ configLoader: "native", build: { outDir: "work/e2e-site" } });
const policy = await readFile("work/e2e-site/_headers", "utf8");
const headers = Object.fromEntries(policy.split("\n").filter(line => line.startsWith("  ")).map(line => { const split = line.indexOf(":"); return [line.slice(0, split).trim(), line.slice(split + 1).trim()]; }));
await preview({ configLoader: "native", build: { outDir: "work/e2e-site" }, preview: { host: "127.0.0.1", port: 4178, strictPort: true, headers } });
