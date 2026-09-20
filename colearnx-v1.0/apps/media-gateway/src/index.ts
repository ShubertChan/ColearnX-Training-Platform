export interface Env {
  HLS_BUCKET: R2Bucket;
  PLAYBACK_TOKEN_SECRET: string;
  APP_ORIGIN: string;
}

type PlaybackClaims = { sub: string; videoVersionId: string; sessionId: string; exp: number; scope: 'play' | 'preview'; orderItemId?: string };

const encoder = new TextEncoder();

function forbidden() {
  return new Response('Playback unauthorised.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

function expired() {
  return new Response('Playback authorisation expired.', { status: 401, headers: { 'Cache-Control': 'no-store' } });
}

function decodeBase64Url(value: string) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return atob(padded);
}

async function validToken(raw: string | null, secret: string): Promise<PlaybackClaims | null> {
  if (!raw?.startsWith('Bearer ')) return null;
  const [version, payload, signature, extra] = raw.slice(7).split('.');
  if (version !== 'v1' || !payload || !signature || extra) return null;
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signatureBytes = Uint8Array.from(decodeBase64Url(signature), (character) => character.charCodeAt(0));
    if (!await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(`v1.${payload}`))) return null;
    const claims = JSON.parse(decodeBase64Url(payload)) as PlaybackClaims;
    if (!claims.sub || !claims.videoVersionId || !claims.sessionId || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)
      || (claims.scope !== 'play' && claims.scope !== 'preview')) return null;
    return claims;
  } catch {
    return null;
  }
}

function contentType(key: string) {
  if (key.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (key.endsWith('.ts')) return 'video/mp2t';
  if (key.endsWith('.m4s')) return 'video/iso.segment';
  if (key.endsWith('.mp4')) return 'video/mp4';
  if (key.endsWith('.key')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function range(value: string | null): R2Range | undefined {
  const match = /^bytes=(\d+)-(\d*)$/i.exec(value ?? '');
  if (!match) return undefined;
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(offset) || offset < 0 || (end !== undefined && (!Number.isSafeInteger(end) || end < offset))) return undefined;
  return end === undefined ? { offset } : { offset, length: end - offset + 1 };
}

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  return origin && origin === env.APP_ORIGIN ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Range', Vary: 'Origin' } : {};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, env) });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed.', { status: 405 });
    const match = /^\/v1\/hls\/([0-9a-f-]{36})\/(.+)$/i.exec(url.pathname);
    if (!match) return new Response('Not found.', { status: 404 });
    const claims = await validToken(request.headers.get('Authorization'), env.PLAYBACK_TOKEN_SECRET);
    if (!claims) return expired();
    const [, videoVersionId, assetPath] = match;
    if (claims.videoVersionId !== videoVersionId || assetPath.includes('..') || assetPath.includes('\\') || assetPath.startsWith('/')) return forbidden();
    const object = await env.HLS_BUCKET.get(`course-video-hls/${videoVersionId}/${assetPath}`, { range: range(request.headers.get('Range')) });
    if (!object) return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store', ...cors(request, env) } });
    const headers = new Headers({
      'Content-Type': object.httpMetadata?.contentType ?? contentType(assetPath),
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
      ...cors(request, env),
    });
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    if (object.range && 'offset' in object.range && typeof object.range.offset === 'number') {
      const offset = object.range.offset;
      const length = object.range.length ?? Math.max(0, object.size - offset);
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    }
    return new Response(request.method === 'HEAD' ? null : object.body, { status: object.range ? 206 : 200, headers });
  },
};
