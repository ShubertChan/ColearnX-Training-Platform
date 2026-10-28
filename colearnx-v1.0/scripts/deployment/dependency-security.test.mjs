import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

function patchedVersion(version, minimum, label) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `${label} must use a stable release`);
  const actual = version.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  assert.equal(actual[0], required[0], `${label}: review major upgrades separately`);
  assert.ok(actual[1] > required[1] || (actual[1] === required[1] && actual[2] >= required[2]),
    `${label} must be at least ${minimum}, received ${version}`);
}

test('lockfiles retain patched Undici, body-parser and Zod versions in every affected dependency tree', async () => {
  const requirements = [
    ['frontend', '../../package-lock.json', 'undici', '8.12.2'],
    ['API', '../../apps/api/package-lock.json', 'body-parser', '2.4.0'],
    ['API', '../../apps/api/package-lock.json', 'zod', '4.6.6'],
    ['media gateway', '../../apps/media-gateway/package-lock.json', 'undici', '7.30.1'],
    ['deployment tools', '../../deployment/package-lock.json', 'undici', '7.30.1'],
  ];
  for (const [component, path, dependency, minimum] of requirements) {
    const lock = await json(path);
    const entries = Object.entries(lock.packages).filter(([name]) => name.endsWith(`/node_modules/${dependency}`)
      || name === `node_modules/${dependency}`);
    assert.ok(entries.length > 0, `${component}: expected ${dependency} in the locked dependency tree`);
    for (const [name, entry] of entries) patchedVersion(entry.version, minimum, `${component}/${name}`);
  }
});

test('both Wrangler installations remain exactly pinned and agree with their lockfiles', async () => {
  const versions = [];
  for (const path of ['../../apps/media-gateway/', '../../deployment/']) {
    const manifest = await json(`${path}package.json`);
    const lock = await json(`${path}package-lock.json`);
    const pin = manifest.devDependencies?.wrangler ?? manifest.dependencies?.wrangler;
    patchedVersion(pin, '4.154.0', `${manifest.name}/wrangler`);
    assert.equal(lock.packages['node_modules/wrangler'].version, pin);
    assert.equal(lock.packages[''].devDependencies?.wrangler ?? lock.packages[''].dependencies?.wrangler, pin);
    versions.push(pin);
  }
  assert.equal(versions[0], versions[1]);
});

test('restored root ignore rules protect root and nested local files without hiding environment templates', () => {
  const ignored = ['.env', '.env.local', 'audit-fixture/.env.local', 'node_modules/fixture/index.js',
    'audit-fixture/node_modules/fixture/index.js', 'dist/index.html', 'release-report/result.json',
    'test-results/result.json', 'playwright-report/index.html', 'audit-fixture/debug.log'];
  const visible = ['.env.example', '.env.compose.example', '.env.staging.example', 'source-fixture.js'];
  const output = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: repositoryRoot, encoding: 'utf8', input: [...ignored, ...visible].join('\n') + '\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(output, ignored);
});

test('CI retains high-severity audits for application, development and deployment dependencies', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const prefix of ['', '--prefix apps/api ', '--prefix apps/video-worker ', '--prefix apps/media-gateway ', '--prefix deployment ']) {
    assert.ok(workflow.includes(`npm ${prefix}audit --audit-level=high`), `Missing full audit for ${prefix || 'frontend'}`);
  }
  assert.doesNotMatch(workflow, /npm[^\n]*audit[^\n]*(?:--omit[= ]dev|--production|--audit-level=(?:critical|none))/);
});
