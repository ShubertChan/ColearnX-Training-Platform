import { createHash } from "node:crypto";

const integrity = bytes => "sha384-" + createHash("sha384").update(bytes).digest("base64");

// Run after Vite finalises its chunks. The import map covers lazy JS (video,
// HLS and checkout) without making the browser download them at startup.
export function protectEntryHtml(html, bundle) {
  const assets = new Map();
  for (const item of Object.values(bundle)) {
    if (item.type === "chunk") assets.set(item.fileName, integrity(item.code));
    else if (item.fileName.endsWith(".css")) assets.set(item.fileName, integrity(item.source));
  }
  const modules = Object.fromEntries([...assets].filter(([name]) => name.endsWith(".js"))
    .sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => ["./" + name, hash]));
  if (!Object.keys(modules).length) throw new Error("Expected compiled JavaScript in the production bundle.");
  const map = JSON.stringify({ integrity: modules });
  const withIntegrity = html.replace(/<(?:script|link)\b[^>]*>/gi, tag => {
    if (/^<link/i.test(tag) && !/\brel="(?:stylesheet|modulepreload)"/i.test(tag)) return tag;
    const url = /\b(?:src|href)="([^"]+)"/i.exec(tag)?.[1];
    if (!url) return tag;
    const hash = assets.get(url.replace(/^(?:\.\/|\/)/, ""));
    if (!hash) throw new Error("Cannot compute SRI for HTML asset: " + url);
    return tag.replace(/>$/, ' integrity="' + hash + '">');
  });
  if (!withIntegrity.includes("<head>")) throw new Error("No head for the module integrity map.");
  return {
    html: withIntegrity.replace("<head>", '<head>\n    <script type="importmap">' + map + "</script>"),
    mapHash: integrity(map),
  };
}
