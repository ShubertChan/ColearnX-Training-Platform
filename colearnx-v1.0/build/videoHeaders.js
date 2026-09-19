export function videoHeaders(env) {
  if (String(env.VITE_ENABLE_HOSTED_VIDEO).toLowerCase() !== "true") return null;
  const origins = value => String(value || "").split(",").map(x => x.trim()).filter(Boolean).map(value => {
    const url = new URL(value);
    if (url.origin !== value || !(url.protocol === "https:" || (["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:"))) throw Error("Video origins must be exact HTTPS origins (HTTP is allowed only for localhost tests).");
    return url.origin;
  });
  const media = origins(env.VITE_MEDIA_ORIGINS), upload = origins(env.VITE_UPLOAD_ORIGINS);
  if (!upload.length) throw Error("Set VITE_UPLOAD_ORIGINS before enabling hosted video. Include the exact existing attachment and video R2 origins.");
  const api = env.VITE_API_BASE_URL?.startsWith("http") ? origins(new URL(env.VITE_API_BASE_URL).origin) : [];
  const connect = [...new Set(["'self'", ...api, ...media, ...upload])].join(" ");
  const csp = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: " + media.join(" "), "connect-src " + connect, "media-src 'self' blob: " + media.join(" "), "worker-src 'self' blob:", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"].join("; ");
  return `/*\n  Content-Security-Policy: ${csp}\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n`;
}
