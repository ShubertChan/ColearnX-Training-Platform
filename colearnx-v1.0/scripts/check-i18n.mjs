import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
const root = new URL("../src/", import.meta.url);
const dictionary = JSON.parse(await readFile(new URL("i18n/zh-CN.json", root), "utf8"));
const issues = [];
const parameters = text => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort().join(",");
for (const [key, value] of Object.entries(dictionary)) {
  if (typeof value !== "string" || parameters(key) !== parameters(value)) issues.push(`Invalid translation or parameters: ${key}`);
}
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) await scan(file);
    else if (entry.name.endsWith(".jsx")) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
        const key = JSON.parse(match[1]).trim();
        if (!Object.hasOwn(dictionary, key)) issues.push(`${path.basename(file.pathname)}: missing ${key}`);
      }
    }
  }
}
await scan(root);
if (issues.length) { console.error(issues.join("\n")); process.exitCode = 1; }
else console.log(`Chinese catalog verified: ${Object.keys(dictionary).length} entries; source keys and interpolation parameters are complete.`);
