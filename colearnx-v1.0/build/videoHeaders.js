// Builds the Cloudflare Pages `_headers` file for the static client.
//
// W5 (finding F-11): the client is a Vite static site, so it had no
// Content-Security-Policy of its own -- helmet only covers API responses. This
// now ALWAYS emits a full security header set (CSP, HSTS preload, nosniff,
// frame denial, referrer and permissions policy). When hosted video is enabled
// the exact API / media / R2 origins are added to the relevant CSP directives.
// Attachment uploads also use R2 without hosted video, so explicitly configured
// upload origins remain allowed independently of the hosted-video switch.
//
// The function is named `securityHeaders`; `videoHeaders` remains exported as a
// backwards-compatible alias for existing imports and tests.

function exactOrigins(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((value) => {
      const url = new URL(value);
      if (
        url.origin !== value || url.hostname.includes("*") ||
        !(
          url.protocol === "https:" ||
          (["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:")
        )
      ) {
        throw Error("Origins must be exact HTTPS origins (HTTP is allowed only for localhost tests).");
      }
      return url.origin;
    });
}

export function securityHeaders(env) {
  const videoOn = String(env.VITE_ENABLE_HOSTED_VIDEO).toLowerCase() === "true";
  const media = videoOn ? exactOrigins(env.VITE_MEDIA_ORIGINS) : [];
  const upload = exactOrigins(env.VITE_UPLOAD_ORIGINS);
  if (videoOn && !upload.length) {
    throw Error("Set VITE_UPLOAD_ORIGINS before enabling hosted video. Include the exact existing attachment and video R2 origins.");
  }
  if (videoOn && !media.length) {
    throw Error("Set VITE_MEDIA_ORIGINS to the exact private playback gateway origin before enabling hosted video.");
  }
  const api = env.VITE_API_BASE_URL?.startsWith("http") ? [new URL(env.VITE_API_BASE_URL).origin] : [];

  const connect = [...new Set(["'self'", ...api, ...media, ...upload])].join(" ");
  const img = ["'self'", "data:", ...media].join(" ");
  const mediaSrc = ["'self'", "blob:", ...media].join(" ");

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src " + img,
    "font-src 'self'",
    "connect-src " + connect,
    "media-src " + mediaSrc,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  return [
    "/*",
    "  Content-Security-Policy: " + csp,
    "  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: no-referrer",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "  Cross-Origin-Opener-Policy: same-origin",
    "",
  ].join("\n");
}

// Backwards-compatible alias.
export const videoHeaders = securityHeaders;
