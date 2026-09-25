import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import gateway from '../src/index.ts';

const origin = 'https://staging.colearnx.net';
const version = '11111111-1111-4111-8111-111111111111';
const otherVersion = '22222222-2222-4222-8222-222222222222';
const secret = 'test-only-key-not-a-deployed-playback-secret';
const url = `https://media.example.test/v1/hls/${version}/attempt/master.m3u8`;
let objectReads = 0;
const env = {
  APP_ORIGIN: origin,
  PLAYBACK_TOKEN_SECRET: secret,
  HLS_BUCKET: { async get() { objectReads += 1; return null; } },
};

function token(overrides = {}) {
  const claims = { sub: 'test-user', videoVersionId: version, sessionId: 'test-session',
    exp: Math.floor(Date.now() / 1000) + 300, scope: 'play', ...overrides };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`v1.${payload}`).digest('base64url');
  return `Bearer v1.${payload}.${signature}`;
}

for (const example of [
  { name: 'missing token', status: 401 },
  { name: 'expired token', status: 401, authorization: token({ exp: 1 }) },
  { name: 'invalid signature', status: 401, authorization: 'Bearer v1.invalid.signature' },
  { name: 'cross-version token', status: 403, authorization: token({ videoVersionId: otherVersion }) },
  { name: 'missing route', status: 404, url: 'https://media.example.test/source.mp4' },
  { name: 'wrong method', status: 405, method: 'POST' },
]) {
  test(`${example.name}: allowed app can read error status without exposing R2`, async () => {
    const before = objectReads;
    const response = await gateway.fetch(new Request(example.url ?? url, {
      method: example.method ?? 'GET',
      headers: { Origin: origin, ...(example.authorization ? { Authorization: example.authorization } : {}) },
    }), env);
    assert.equal(response.status, example.status);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('vary'), 'Origin');
    assert.equal(objectReads, before);
  });
}

test('untrusted origins do not receive CORS permission', async () => {
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    const response = await gateway.fetch(new Request(url, { method, headers: { Origin: 'https://untrusted.example' } }), env);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('authorised preflight permits authorization and range headers', async () => {
  const response = await gateway.fetch(new Request(url, { method: 'OPTIONS', headers: { Origin: origin } }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization, Range');
});

test('missing private object returns a readable no-store 404', async () => {
  const response = await gateway.fetch(new Request(url, { headers: { Origin: origin, Authorization: token() } }), env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('invalid byte range fails before accessing storage', async () => {
  const before = objectReads;
  const response = await gateway.fetch(new Request(url, {
    headers: { Origin: origin, Authorization: token(), Range: 'bytes=99-1' },
  }), env);
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(objectReads, before);
});

function storedObjectEnv(objectRange, body = 'test-data') {
  return { ...env, HLS_BUCKET: { async get() {
    return { body, size: 9, range: objectRange,
      httpMetadata: { contentType: 'video/mp2t' }, httpEtag: '"fixture"',
      writeHttpMetadata(headers) { headers.set('Cache-Control', 'public'); },
    };
  } } };
}

test('R2 full-object range metadata does not turn an ordinary GET into 206', async () => {
  const response = await gateway.fetch(new Request(url, {
    headers: { Origin: origin, Authorization: token() },
  }), storedObjectEnv({ offset: 0, length: 9 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), 'test-data');
});

test('R2 full-object range metadata keeps HEAD at 200 with an empty body', async () => {
  const response = await gateway.fetch(new Request(url, {
    method: 'HEAD', headers: { Origin: origin, Authorization: token() },
  }), storedObjectEnv({ offset: 0, length: 9 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(await response.text(), '');
});

test('explicit byte range produces 206 and Content-Range', async () => {
  const response = await gateway.fetch(new Request(url, {
    headers: { Origin: origin, Authorization: token(), Range: 'bytes=0-3' },
  }), storedObjectEnv({ offset: 0, length: 4 }, 'test'));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/9');
  assert.equal(await response.text(), 'test');
});
