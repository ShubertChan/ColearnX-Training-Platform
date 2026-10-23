import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isPublicArtifactPath, validateConfig, appDirectory } from './artifact.mjs';
import { resolve } from 'node:path';

const SHA = /^[a-f0-9]{40}$/i;
const HASH = /^[a-f0-9]{64}$/i;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizedManifest(manifest) {
  return {
    commit: manifest.commit,
    appOrigin: manifest.appOrigin,
    apiBaseUrl: manifest.apiBaseUrl,
    paymentsEnabled: manifest.paymentsEnabled,
    schemaVersion: manifest.schemaVersion,
    hostedVideoEnabled: manifest.hostedVideoEnabled,
    mediaOrigins: manifest.mediaOrigins,
    uploadOrigins: manifest.uploadOrigins,
    requiredMigrations: manifest.requiredMigrations,
    files: manifest.files,
    assets: manifest.assets.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function validateManifest(manifest, config, releaseSha) {
  requireCondition(SHA.test(releaseSha ?? ''), 'RELEASE_SHA must be a full 40-character commit SHA.');
  requireCondition(manifest?.commit === releaseSha, 'Local release manifest does not match RELEASE_SHA.');
  requireCondition(manifest.appOrigin === config.appOrigin && manifest.apiBaseUrl === config.apiBaseUrl
    && manifest.paymentsEnabled === config.paymentsEnabled, 'Local release manifest does not match staging configuration.');
  requireCondition(manifest.hostedVideoEnabled === config.hostedVideoEnabled, 'Hosted-video configuration differs from the tested manifest.');
  requireCondition(manifest.schemaVersion === 1 && ['mediaOrigins', 'uploadOrigins'].every(key => JSON.stringify(manifest[key]) === JSON.stringify(config[key])), 'Manifest schema or video origin configuration differs.');
  requireCondition(Array.isArray(manifest.requiredMigrations) && manifest.requiredMigrations.length > 0
    && manifest.requiredMigrations.every((row, i) => new RegExp(`^${String(i + 1).padStart(3, '0')}_[a-z0-9_]+\\.sql$`).test(row.filename) && HASH.test(row.checksum)), 'Invalid required migration inventory.');
  requireCondition(Array.isArray(manifest.assets) && manifest.assets.length > 0 && manifest.assets.length <= 100, 'Local release manifest must contain 1–100 assets.');
  const paths = new Set();
  for (const asset of manifest.assets) {
    requireCondition(typeof asset?.path === 'string'
      && isPublicArtifactPath(asset.path) && !['_headers', '_redirects'].includes(asset.path)
      && HASH.test(asset.sha256 ?? '') && !paths.has(asset.path), 'Local release manifest contains an invalid or duplicate asset.');
    paths.add(asset.path);
  }
  requireCondition(paths.has('index.html') && manifest.assets.some(({ path }) => path.endsWith('.js')), 'Local release manifest must include index.html and JavaScript.');
  requireCondition(Array.isArray(manifest.files) && manifest.files.length <= 110
    && manifest.files.every(file => isPublicArtifactPath(file?.path) && HASH.test(file.sha256 ?? ''))
    && new Set(manifest.files.map(file => file.path)).size === manifest.files.length
    && manifest.assets.every(asset => manifest.files.some(file => file.path === asset.path && file.sha256 === asset.sha256)), 'Invalid complete frontend file inventory.');
}

function checkCors(response, config, label) {
  requireCondition(response.headers.get('access-control-allow-origin') === config.appOrigin, `${label}: CORS origin does not match the canonical app origin.`);
  requireCondition(response.headers.get('access-control-allow-credentials') === 'true', `${label}: credentialed CORS is not enabled.`);
}

async function request(fetchImpl, url, options, expectedStatus, label) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
  } catch {
    // Do not echo fetch errors: they can contain headers, URLs or upstream data.
    throw new Error(`${label}: network request failed.`);
  }
  requireCondition(!response.redirected && !(response.status >= 300 && response.status < 400), `${label}: unexpected redirect.`);
  requireCondition(response.status === expectedStatus, `${label}: expected HTTP ${expectedStatus}, received HTTP ${response.status}.`);
  return response;
}

async function json(response, label) {
  try { return await response.json(); } catch { throw new Error(`${label}: expected a JSON response.`); }
}

async function checkApi(config, fetchImpl, signal) {
  const headers = { Origin: config.appOrigin };
  await Promise.all([
    ...['live', 'ready'].map(async (status) => {
      const label = `API health/${status}`;
      const response = await request(fetchImpl, `${config.apiOrigin}/health/${status}`, { signal, headers }, 200, label);
      checkCors(response, config, label);
      requireCondition((await json(response, label))?.data?.status === status, `${label}: unexpected health payload.`);
    }),
    (async () => {
      const label = 'Top-up packages';
      const response = await request(fetchImpl, `${config.apiBaseUrl}/wallet/top-up-packages`, { signal, headers }, 200, label);
      checkCors(response, config, label);
      const body = await json(response, label);
      // The current API envelope is { data: Package[] }, not { data: { items: [] } }.
      requireCondition(Array.isArray(body?.data), `${label}: expected a package array.`);
      requireCondition(!config.paymentsEnabled || body.data.length > 0, `${label}: payments are enabled but no active packages were returned.`);
    })(),
    (async () => {
      const label = 'Authentication preflight';
      const response = await request(fetchImpl, `${config.apiBaseUrl}/auth/refresh`, {
        signal,
        method: 'OPTIONS',
        headers: { ...headers, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' },
      }, 204, label);
      checkCors(response, config, label);
      const tokens = (name) => (response.headers.get(name) ?? '').toLowerCase().split(',').map((item) => item.trim());
      requireCondition(tokens('access-control-allow-methods').includes('post'), `${label}: POST is not allowed.`);
      const allowed = tokens('access-control-allow-headers');
      requireCondition(allowed.includes('content-type') && allowed.includes('x-csrf-token'), `${label}: required request headers are not allowed.`);
    })(),
    (async () => {
      const label = 'Unauthenticated /me';
      const response = await request(fetchImpl, `${config.apiBaseUrl}/me`, { signal, headers }, 401, label);
      checkCors(response, config, label);
    })(),
    ...['auth/mfa', 'admin/role-applications', 'admin/video-operations', 'admin/security/summary', 'admin/security/events'].map(async path => {
      const response = await request(fetchImpl, `${config.apiBaseUrl}/${path}`, { signal, headers }, 401, `Unauthenticated ${path}`);
      checkCors(response, config, path);
      requireCondition((await json(response, path))?.error?.code === 'AUTH_REQUIRED', `${path}: missing authentication guard.`);
    }),
    (async () => {
      const response = await request(fetchImpl, `${config.apiOrigin}/health/live`, { signal, headers: { Origin: 'https://not-authorized.invalid' } }, 403, 'Rejected origin');
      requireCondition(response.headers.get('access-control-allow-origin') === null, 'Rejected origin was allowed by CORS.');
    })(),
    (async () => {
      const response = await request(fetchImpl, `${config.apiBaseUrl}/admin/role-applications/00000000-0000-0000-0000-000000000000/decision`, {
        method: 'OPTIONS', signal, headers: { ...headers, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-csrf-token,x-step-up-token' },
      }, 204, 'Administrator step-up preflight');
      checkCors(response, config, 'Administrator step-up preflight');
      requireCondition((response.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').map(x => x.trim()).includes('x-step-up-token'), 'Administrator step-up preflight must allow its proof header.');
    })(),
  ]);
}

async function checkArtifact(config, manifest, fetchImpl, signal, cacheKey) {
  const label = 'Frontend release manifest';
  const manifestUrl = new URL('/release.json', config.appOrigin);
  manifestUrl.searchParams.set('smoke', cacheKey);
  const response = await request(fetchImpl, manifestUrl.href, { signal }, 200, label);
  const remote = await json(response, label);
  let sameManifest = false;
  try { sameManifest = JSON.stringify(normalizedManifest(remote)) === JSON.stringify(normalizedManifest(manifest)); } catch { /* Invalid manifest fails closed. */ }
  requireCondition(sameManifest, `${label}: deployed version or build configuration does not match the expected artifact.`);

  // A small fixed worker pool avoids an unbounded burst of asset requests.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, manifest.assets.length) }, async () => {
    while (cursor < manifest.assets.length && !signal.aborted) {
      const asset = manifest.assets[cursor++];
      const assetUrl = new URL(asset.path === 'index.html' ? '/' : `/${asset.path}`, config.appOrigin);
      assetUrl.searchParams.set('smoke', cacheKey);
      const assetResponse = await request(fetchImpl, assetUrl.href, { signal }, 200, 'Frontend artifact');
      let bytes;
      try { bytes = await assetResponse.arrayBuffer(); } catch { throw new Error('Frontend artifact: could not read response bytes.'); }
      const hash = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
      requireCondition(hash === asset.sha256, `Frontend artifact: checksum mismatch for ${asset.path}.`);
    }
  }));
}

/** Non-mutating release checks only; this is not login, payment, R2 or migration acceptance testing. */
export async function runSmoke({ config, manifest, releaseSha, apiOnly = false, maxAttempts = 6, retryDelayMs = 5000, attemptTimeoutMs = 30000 }, dependencies = {}) {
  validateConfig(config);
  if (!apiOnly) validateManifest(manifest, config, releaseSha);
  requireCondition(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10, 'maxAttempts must be between 1 and 10.');
  requireCondition(Number.isInteger(retryDelayMs) && retryDelayMs >= 0 && retryDelayMs <= 30000, 'retryDelayMs must be between 0 and 30000.');
  requireCondition(Number.isInteger(attemptTimeoutMs) && attemptTimeoutMs > 0 && attemptTimeoutMs <= 60000, 'attemptTimeoutMs must be between 1 and 60000.');
  const {
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    now = Date.now,
  } = dependencies;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeoutFn(() => {
        reject(new Error('Smoke attempt timed out.'));
        controller.abort();
      }, attemptTimeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          await checkApi(config, fetchImpl, controller.signal);
          if (!apiOnly) await checkArtifact(config, manifest, fetchImpl, controller.signal, `${releaseSha}-${now()}-${attempt}`);
        })(),
        deadline,
      ]);
      return { mode: apiOnly ? 'api-only' : 'full', attempts: attempt, ...(apiOnly ? {} : { commit: releaseSha, assetsChecked: manifest.assets.length }) };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeoutFn(timer);
      controller.abort();
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  throw new Error(`Smoke checks failed after ${maxAttempts} attempt(s): ${lastError.message}`);
}

async function main() {
  const args = process.argv.slice(2);
  requireCondition(args.length === 0 || (args.length === 1 && ['--api-only', '--planned'].includes(args[0])), 'Usage: node scripts/deployment/smoke.mjs [--api-only|--planned]');
  const apiOnly = args[0] === '--api-only';
  const config = JSON.parse(await readFile(new URL('../../deployment/staging.json', import.meta.url), 'utf8'));
  let manifest = apiOnly ? undefined : JSON.parse(await readFile(new URL('../../dist/release.json', import.meta.url), 'utf8'));
  let releaseSha = process.env.RELEASE_SHA;
  if (args[0] === '--planned') {
    const { validateReleasePlan } = await import('./release-plan.mjs');
    const plan = validateReleasePlan(JSON.parse(await readFile(resolve(appDirectory, 'release-report/plan.json'), 'utf8')), releaseSha);
    manifest = plan.expectedFrontendManifest;
    releaseSha = plan.components.frontend.expectedCommit;
  }
  const result = await runSmoke({ config, manifest, apiOnly, releaseSha });
  await mkdir(resolve(appDirectory, 'release-report'), { recursive: true });
  await writeFile(resolve(appDirectory, `release-report/smoke-${apiOnly ? 'api' : 'full'}.json`), JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2));
  console.log(`PASS: ${result.mode} smoke checks (${result.attempts} attempt(s))${result.commit ? ` for ${result.commit}` : ''}.`);
  console.log('Scope: health, public packages, CORS, unauthenticated access; full mode also verifies the exact frontend artifact. No accounts, payments or stored files were changed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Local JSON parser/read errors could include file content; only own diagnostics are useful here.
    const message = error instanceof SyntaxError ? 'Invalid deployment configuration or release JSON.' : error.message;
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  });
}
