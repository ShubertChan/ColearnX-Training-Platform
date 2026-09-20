import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runSmoke } from './smoke.mjs';
import { loadConfig, migrationInventory } from './artifact.mjs';

const commit = 'a'.repeat(40);
const config = await loadConfig();
const files = { 'index.html': '<html><script src="/assets/index-test.js"></script></html>', 'assets/index-test.js': 'console.log("staging");', 'assets/index-test.css': 'body{margin:0}' };
const manifest = { commit, appOrigin: config.appOrigin, apiBaseUrl: config.apiBaseUrl, paymentsEnabled: true, assets: Object.entries(files).map(([path, body]) => ({ path, sha256: createHash('sha256').update(body).digest('hex') })) };
Object.assign(manifest, { schemaVersion: 1, hostedVideoEnabled: false, mediaOrigins: [], uploadOrigins: [], requiredMigrations: await migrationInventory(), files: manifest.assets });
const cors = { 'access-control-allow-origin': config.appOrigin, 'access-control-allow-credentials': 'true' };
const options = { config, manifest, releaseSha: commit, maxAttempts: 1 };
const responseJson = (body, status = 200, headers = cors) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(override = () => undefined) {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    const replaced = override(url, init, requests.length);
    if (replaced !== undefined) return replaced;
    if (init.headers?.Origin === 'https://not-authorized.invalid') return responseJson({ error: { code: 'ORIGIN_NOT_ALLOWED' } }, 403, {});
    if (init.method === 'OPTIONS' && url.pathname.includes('/admin/')) return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'authorization,content-type,x-csrf-token,x-step-up-token' } });
    if (url.pathname === '/health/live') return responseJson({ data: { status: 'live' } });
    if (url.pathname === '/health/ready') return responseJson({ data: { status: 'ready' } });
    if (url.pathname.endsWith('/wallet/top-up-packages')) return responseJson({ data: [{ id: 'package-one', amountMinor: 500, points: 500 }] });
    if (url.pathname.endsWith('/auth/refresh')) return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'Content-Type,X-CSRF-Token' } });
    if (url.pathname.endsWith('/me')) return responseJson({ error: { code: 'AUTH_REQUIRED' } }, 401);
    if (['/auth/mfa', '/admin/role-applications', '/admin/video-operations'].some(path => url.pathname.endsWith(path))) return responseJson({ error: { code: 'AUTH_REQUIRED' } }, 401);
    if (url.pathname === '/release.json') return responseJson(manifest);
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (path in files) return new Response(files[path]);
    throw new Error('Unexpected mock URL');
  };
  return { fetchImpl, requests, now: () => 1234 };
}

test('full smoke verifies the expected release and every artifact with no mutations or credentials', async () => {
  const deps = fakeFetch();
  const result = await runSmoke(options, deps);
  assert.equal(result.assetsChecked, 3);
  assert.equal(result.commit, commit);
  assert.equal(result.attempts, 1);
  assert.equal(deps.requests.length, 14);
  for (const { url, init } of deps.requests) {
    assert.ok(['GET', 'OPTIONS'].includes(init.method ?? 'GET'));
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    assert.equal(init.headers?.Authorization, undefined);
    if (url.origin === config.appOrigin) assert.ok(url.searchParams.has('smoke'));
  }
});

test('API-only gate does not require a SHA, local artifact or Pages access', async () => {
  const deps = fakeFetch();
  assert.equal((await runSmoke({ config, apiOnly: true, maxAttempts: 1 }, deps)).mode, 'api-only');
  assert.equal(deps.requests.length, 10);
  assert.ok(deps.requests.every(({ url }) => url.origin === config.apiOrigin));
});

test('rejects the wrong CORS origin even if the package request returns HTTP 200', async () => {
  await assert.rejects(runSmoke(options, fakeFetch((url) => url.pathname.endsWith('/wallet/top-up-packages') ? responseJson({ data: [] }, 200, { ...cors, 'access-control-allow-origin': 'https://other.example' }) : undefined)), /CORS origin/);
});

test('rejects stale deployed versions', async () => {
  await assert.rejects(runSmoke(options, fakeFetch((url) => url.pathname === '/release.json' ? responseJson({ ...manifest, commit: 'b'.repeat(40) }) : undefined)), /deployed version or build configuration/);
});

test('rejects mismatched artifact bytes', async () => {
  await assert.rejects(runSmoke(options, fakeFetch((url) => url.pathname.endsWith('index-test.js') ? new Response('stale JS') : undefined)), /checksum mismatch for assets\/index-test.js/);
});

test('rejects health status errors and malformed health payloads', async () => {
  await assert.rejects(runSmoke(options, fakeFetch((url) => url.pathname === '/health/ready' ? responseJson({}, 503) : undefined)), /expected HTTP 200, received HTTP 503/);
  await assert.rejects(runSmoke(options, fakeFetch((url) => url.pathname === '/health/ready' ? responseJson({ data: { status: 'live' } }) : undefined)), /unexpected health payload/);
});

test('cold starts retry with a bounded attempt count and injected sleep', async () => {
  let healthCalls = 0;
  const sleeps = [];
  const deps = fakeFetch((url) => url.pathname === '/health/ready' && ++healthCalls === 1 ? responseJson({}, 503) : undefined);
  const result = await runSmoke({ ...options, maxAttempts: 2, retryDelayMs: 5 }, { ...deps, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [5]);
});

test('an unresponsive fetch is bounded, aborted and reported without leaking its error details', async () => {
  let timerCallback;
  let signal;
  const promise = runSmoke(options, {
    fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); },
    setTimeoutFn: (callback) => { timerCallback = callback; return 123; },
    clearTimeoutFn: (timer) => assert.equal(timer, 123),
  });
  timerCallback();
  await assert.rejects(promise, /Smoke attempt timed out/);
  assert.equal(signal.aborted, true);
  await assert.rejects(runSmoke(options, { fetchImpl: async () => { throw new Error('sensitive-upstream-details'); } }), (error) => {
    assert.match(error.message, /network request failed/);
    assert.ok(!error.message.includes('sensitive-upstream-details'));
    return true;
  });
});

test('rejects redirected responses and incomplete authentication CORS headers', async () => {
  await assert.rejects(runSmoke(options, fakeFetch((url) => url.pathname === '/release.json' ? new Response(null, { status: 302, headers: { location: 'https://other.example' } }) : undefined)), /unexpected redirect/);
  await assert.rejects(runSmoke(options, fakeFetch((url) => url.pathname.endsWith('/auth/refresh') ? new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } }) : undefined)), /required request headers/);
});

test('fails closed when unauthenticated access is granted or enabled packages are empty', async () => {
  await assert.rejects(runSmoke(options, fakeFetch((url) => url.pathname.endsWith('/me') ? responseJson({ data: {} }) : undefined)), /expected HTTP 401, received HTTP 200/);
  await assert.rejects(runSmoke(options, fakeFetch((url) => url.pathname.endsWith('/wallet/top-up-packages') ? responseJson({ data: [] }) : undefined)), /no active packages/);
});

test('validates expected artifacts before any requests', async () => {
  const deps = fakeFetch();
  await assert.rejects(runSmoke({ ...options, releaseSha: 'short' }, deps), /40-character/);
  await assert.rejects(runSmoke({ ...options, manifest: { ...manifest, apiBaseUrl: 'https://other.example' } }, deps), /staging configuration/);
  await assert.rejects(runSmoke({ ...options, manifest: { ...manifest, assets: [{ path: '../secret', sha256: 'a'.repeat(64) }] } }, deps), /invalid or duplicate/);
  assert.equal(deps.requests.length, 0);
});
