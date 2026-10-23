import assert from 'node:assert/strict';
import test from 'node:test';
import { affectedComponents, changedFilesBetween, createReleasePlan, planOutputs, readLiveManifest, validateReleasePlan } from './release-plan.mjs';
import { loadConfig, migrationInventory } from './artifact.mjs';

const config = await loadConfig();
const commit = 'a'.repeat(40), front = 'b'.repeat(40), api = 'c'.repeat(40), media = 'd'.repeat(40), video = 'e'.repeat(40);
const files = [{ path: 'index.html', sha256: 'f'.repeat(64) }, { path: 'assets/index.js', sha256: 'f'.repeat(64) }];
const targetManifest = { schemaVersion: 1, commit, appOrigin: config.appOrigin, apiBaseUrl: config.apiBaseUrl, paymentsEnabled: config.paymentsEnabled,
  hostedVideoEnabled: config.hostedVideoEnabled, mediaOrigins: config.mediaOrigins, uploadOrigins: config.uploadOrigins,
  requiredMigrations: await migrationInventory(), files, assets: files };
const liveManifest = { ...targetManifest, commit: front };
const base = { commit, config, targetManifest, liveManifest,
  pages: { project: config.pagesProject, previousDeploymentId: '12345678-1234-1234-1234-123456789abc', previousCommitSha: front },
  render: { result: 'success', observedOnly: true, postAttempted: false, releaseSha: api, deployId: 'dep-before' },
  externalBaselines: { mediaGateway: media, videoWorker: video }, diff: () => [] };
const plan = (paths, options = {}) => createReleasePlan({ ...base, diff: () => paths, ...options });

test('frontend-only release retains API and verifies the existing frontend baseline independently', () => {
  const p = plan(['colearnx-v1.0/src/pages/Login.jsx']);
  assert.equal(p.components.frontend.action, 'deploy');
  assert.equal(p.components.api.action, 'retain');
  assert.equal(p.components.api.expectedCommit, api);
  assert.equal(p.expectedFrontendManifest.commit, commit);
  assert.equal(p.blocked, false);
  assert.deepEqual(planOutputs(p), { frontend_required: 'true', api_required: 'false', expected_frontend_sha: commit,
    expected_api_sha: api, previous_api_sha: api, previous_api_deploy_id: 'dep-before' });
});

test('API-only release keeps verified frontend bytes and its honest original SHA', () => {
  const p = plan(['colearnx-v1.0/apps/api/src/routes/wallet.ts']);
  assert.equal(p.components.api.action, 'deploy');
  assert.equal(p.components.frontend.action, 'retain');
  assert.equal(p.expectedFrontendManifest.commit, front);
  assert.equal(planOutputs(p).expected_frontend_sha, front);
});

test('mixed deployed baselines use separate complete diffs, never only HEAD~1 or the frontend SHA', () => {
  const calls = [];
  const p = createReleasePlan({ ...base, diff: (old, next) => {
    calls.push([old, next]);
    return old === api ? ['colearnx-v1.0/apps/api/src/app.ts'] : [];
  } });
  assert.deepEqual(calls, [[front, commit], [api, commit], [media, commit], [video, commit]]);
  assert.equal(p.components.api.action, 'deploy');
  assert.equal(p.components.frontend.action, 'retain');
});

test('docs/test-only changes skip publication, not CI, actual migration checks or smoke checks', () => {
  const p = plan(['README.md', 'colearnx-v1.0/docs/STAGING_CICD.md', 'colearnx-v1.0/tests/components/Example.test.jsx']);
  assert.ok(Object.values(p.components).every(item => item.action === 'retain'));
  const forced = plan([], { forceWebRelease: true });
  assert.equal(forced.components.frontend.action, 'deploy');
  assert.equal(forced.components.api.action, 'deploy');
  assert.equal(forced.components.mediaGateway.action, 'retain');
});

test('shared schema/unknown runtime changes include every dependent component and require explicit external review', () => {
  for (const path of ['colearnx-v1.0/db/migrations/021_future.sql', 'colearnx-v1.0/shared/new-contract.js', 'new-global-config.json']) {
    const p = plan([path]);
    assert.equal(p.components.frontend.action, 'deploy');
    assert.equal(p.components.api.action, 'deploy');
    assert.deepEqual(p.manualComponents, ['mediaGateway', 'videoWorker']);
    assert.equal(p.blocked, true);
    assert.throws(() => planOutputs(p), /blocked/);
  }
  assert.equal(plan(['colearnx-v1.0/db/migrations/021_future.sql'], { externalReviewed: true }).blocked, false);
  const tooling = plan(['.github/workflows/ci.yml', 'colearnx-v1.0/deployment/package-lock.json']);
  assert.equal(tooling.components.api.action, 'deploy');
  assert.equal(tooling.components.frontend.action, 'deploy');
});

test('media gateway and local video changes are identified but never claimed as automatic deployments', () => {
  const p = plan(['colearnx-v1.0/apps/media-gateway/src/index.ts', 'colearnx-v1.0/deploy/local-video/compose.yaml'], { externalReviewed: true });
  for (const name of ['mediaGateway', 'videoWorker']) {
    assert.equal(p.components[name].action, 'manual-review');
    assert.equal(p.components[name].expectedCommit, null);
  }
  assert.equal(p.components.api.action, 'retain');
  assert.equal(p.components.frontend.action, 'retain');
});

test('unknown external baselines fail closed until separately reviewed, rather than assuming the API SHA', () => {
  const p = plan([], { externalBaselines: {} });
  assert.equal(p.blocked, true);
  assert.equal(p.components.videoWorker.baseline, null);
  assert.equal(plan([], { externalBaselines: {}, externalReviewed: true }).blocked, false);
  assert.throws(() => plan([], { externalBaselines: { mediaGateway: 'short' } }), /full lowercase/);
});

test('unregistered service and unsafe paths cannot be silently skipped even with an external acknowledgement', () => {
  assert.throws(() => plan(['colearnx-v1.0/apps/unknown-service/index.js'], { externalReviewed: true }), /unregistered service/);
  for (const path of ['../private', '/absolute', 'a//b', 'a/./b', 'a\\b', 'a\nb', '']) assert.throws(() => affectedComponents(path));
});

test('artifact or header/config drift forces a frontend deployment even with no matching source path', () => {
  const changed = structuredClone(liveManifest);
  changed.files = [...changed.files, { path: '_headers', sha256: '1'.repeat(64) }];
  const p = plan([], { liveManifest: changed });
  assert.equal(p.components.frontend.action, 'deploy');
  assert.match(p.components.frontend.reason, /bytes or public configuration/);
  const oldConfig = plan([], { liveManifest: { ...liveManifest, paymentsEnabled: false } });
  assert.equal(oldConfig.components.frontend.action, 'deploy');
});

test('missing/conflicting platform metadata or a forged plan is rejected', () => {
  assert.throws(() => plan([], { liveManifest: { ...liveManifest, commit: api } }), /disagree/);
  assert.throws(() => plan([], { render: { ...base.render, postAttempted: true } }), /read-only Render/);
  assert.throws(() => plan([], { pages: { ...base.pages, previousDeploymentId: null } }), /deployment identity/);
  const p = plan([]);
  assert.equal(validateReleasePlan(p, commit), p);
  assert.throws(() => validateReleasePlan(p, front), /different target/);
  assert.throws(() => validateReleasePlan({ ...p, expectedFrontendManifest: targetManifest }, commit), /different component/);
});

test('git uses ancestor-checked, NUL-delimited whole-range diffs with rename detection disabled', () => {
  const calls = [];
  const paths = changedFilesBetween(front, commit, 'synthetic-dir', (_command, args) => {
    calls.push(args);
    return args[0] === 'merge-base' ? '' : 'colearnx-v1.0/src/old.jsx\0colearnx-v1.0/apps/api/src/new.ts\0';
  });
  assert.equal(paths.length, 2);
  assert.deepEqual(calls[0], ['merge-base', '--is-ancestor', front, commit]);
  assert.deepEqual(calls[1], ['diff', '--name-only', '--no-renames', '-z', front, commit, '--']);
  assert.deepEqual(changedFilesBetween(front, commit, '.', () => ''), []);
  assert.throws(() => changedFilesBetween(front, commit, '.', () => { throw new Error('private git response'); }), error => /complete ancestor diff/.test(error.message) && !error.message.includes('private git'));
  assert.throws(() => changedFilesBetween(front, commit, '.', (_command, args) => args[0] === 'diff' ? 'truncated' : ''), /complete ancestor diff/);
});

test('live frontend baseline is read with GET only and no credentials; errors are sanitized', async () => {
  const result = await readLiveManifest(config, async (url, init) => {
    assert.equal(new URL(url).origin, config.appOrigin);
    assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    return Response.json(liveManifest);
  });
  assert.equal(result.commit, front);
  await assert.rejects(readLiveManifest(config, async () => { throw new Error('sensitive upstream response'); }), error => /Cannot read/.test(error.message) && !error.message.includes('sensitive'));
});
