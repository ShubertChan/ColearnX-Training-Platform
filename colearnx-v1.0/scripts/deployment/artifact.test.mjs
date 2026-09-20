import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateConfig, createManifest, verifyArtifact, requireCommit, migrationInventory, isPublicArtifactPath } from './artifact.mjs';
import { pagesArguments } from './pages-deploy.mjs';

const config = await loadConfig();
const commit = 'a'.repeat(40);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'colearnx-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<script src="./assets/app.js"></script>');
  await writeFile(join(directory, 'assets/app.js'), `const api = "${config.apiBaseUrl}";`);
  return directory;
}
test('staging configuration rejects credentials, wrong API path, unapproved branch, and extra fields', () => {
  for (const override of [{ apiOrigin: 'https://user:pass@example.com' }, { apiBaseUrl: '/api/v1' }, { pagesBranch: 'preview' }, { DATABASE_URL: 'forbidden' }, { paymentsEnabled: 'true' }]) {
    assert.throws(() => validateConfig({ ...config, ...override }));
  }
});
test('release requires a complete commit SHA', () => {
  assert.equal(requireCommit(commit), commit);
  for (const invalid of ['main', 'abc123', '', '../main', 'a'.repeat(41)]) assert.throws(() => requireCommit(invalid));
});
test('artifact manifest verifies exact source/config/file hashes', async (t) => {
  const directory = await fixture(t);
  const manifest = await createManifest(directory, config, commit);
  await writeFile(join(directory, 'release.json'), JSON.stringify(manifest));
  assert.deepEqual(await verifyArtifact(directory, config, commit), manifest);
  await assert.rejects(verifyArtifact(directory, config, 'b'.repeat(40)));
  await assert.rejects(verifyArtifact(directory, { ...config, paymentsEnabled: !config.paymentsEnabled }, commit));
  await writeFile(join(directory, 'assets/app.js'), `${config.apiBaseUrl} altered`);
  await assert.rejects(verifyArtifact(directory, config, commit));
});
test('new files added after build invalidate the artifact', async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'release.json'), JSON.stringify(await createManifest(directory, config, commit)));
  await writeFile(join(directory, 'extra.txt'), 'unvalidated');
  await assert.rejects(verifyArtifact(directory, config, commit));
});
test('missing configured API URL fails before publishing', async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'assets/app.js'), 'const api = "/api/v1";');
  await assert.rejects(createManifest(directory, config, commit));
});
test('private environment files and Pages workers cannot enter static upload', async (t) => {
  const directory = await fixture(t);
  for (const name of ['.env', '_worker.js']) {
    await writeFile(join(directory, name), 'invalid');
    await assert.rejects(createManifest(directory, config, commit));
    await rm(join(directory, name));
  }
});
test('common secret patterns stop frontend release', async (t) => {
  const directory = await fixture(t);
  for (const marker of ['sk_test_' + 'a'.repeat(20), 'postgresql://user:secret@example.com/db', '-----BEGIN PRIVATE KEY-----']) {
    await writeFile(join(directory, 'assets/app.js'), `${config.apiBaseUrl} ${marker}`);
    await assert.rejects(createManifest(directory, config, commit));
  }
});
test('Pages command uses tested dist, exact SHA, fixed CLI and existing project', () => {
  const args = pagesArguments(config, commit);
  assert.match(args[0].replaceAll('\\', '/'), /deployment\/node_modules\/wrangler\/bin\/wrangler\.js$/);
  assert.equal(args[1], 'pages');
  assert.equal(args[args.indexOf('--commit-hash') + 1], commit);
  assert.equal(args[args.indexOf('--project-name') + 1], config.pagesProject);
  assert.equal(args[args.indexOf('--branch') + 1], 'main');
  assert(args.includes('dist'));
});

test('video settings fail closed and are bound to the release artifact', async (t) => {
  assert.throws(() => validateConfig({ ...config, hostedVideoEnabled: true }), /requires/);
  for (const origins of [['https://user:password@example.com'], ['https://example.com/path'], ['https://example.com', 'https://example.com']]) {
    assert.throws(() => validateConfig({ ...config, mediaOrigins: origins }));
  }
  const directory = await fixture(t);
  const manifest = await createManifest(directory, config, commit);
  assert.equal(manifest.hostedVideoEnabled, false);
  assert.deepEqual(manifest.requiredMigrations, await migrationInventory());
  await writeFile(join(directory, 'release.json'), JSON.stringify({ ...manifest, mediaOrigins: ['https://other.example'] }));
  await assert.rejects(verifyArtifact(directory, config, commit));
});

test('migration inventory canonicalizes CRLF and rejects gaps', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'colearnx-migrations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '001_example.sql'), 'SELECT 1;\r\n');
  const before = await migrationInventory(directory);
  await writeFile(join(directory, '001_example.sql'), 'SELECT 1;\n');
  assert.deepEqual(await migrationInventory(directory), before);
  await writeFile(join(directory, '003_gap.sql'), 'SELECT 3;');
  await assert.rejects(migrationInventory(directory), /contiguous/);
});

test('static artifact allowlist rejects archives, maps and traversal', () => {
  for (const path of ['assets/logo.png', 'assets/font.woff2', 'assets/app.js', '_headers']) assert.ok(isPublicArtifactPath(path));
  for (const path of ['backup.sql', 'assets/source.zip', 'assets/app.js.map', 'assets/../private.js', 'assets/.env.js']) assert.equal(isPublicArtifactPath(path), false);
});
