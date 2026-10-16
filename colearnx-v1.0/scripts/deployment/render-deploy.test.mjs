import assert from 'node:assert/strict';
import test from 'node:test';
import { deployRender, readRenderConfig, renderOutputs } from './render-deploy.mjs';

const SHA = 'a'.repeat(40);
const PREVIOUS_SHA = 'b'.repeat(40);
const config = { apiKey: 'test-only-render-secret', serviceId: 'srv-test123', releaseSha: SHA };
const service = {
  id: config.serviceId,
  type: 'web_service',
  repo: 'https://github.com/ShubertChan/ColearnX-Training-Platform',
  branch: 'main',
  autoDeploy: 'no',
  suspended: 'not_suspended',
  rootDir: 'colearnx-v1.0',
  serviceDetails: {
    runtime: 'node',
    env: 'node',
    envSpecificDetails: {
      buildCommand: 'npm --prefix apps/api ci --include=dev && npm --prefix apps/api run build',
      startCommand: 'npm --prefix apps/api start',
      preDeployCommand: '',
    },
  },
};
const deployment = (status, id = 'dep-new', sha = SHA) => ({ id, status, commit: { id: sha, message: 'never-log-this-commit-message' } });
const listed = (deploy) => ({ deploy, cursor: `cursor-${deploy.id}` });
const previous = listed(deployment('live', 'dep-previous', PREVIOUS_SHA));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function harness(responses, options = {}) {
  const calls = [];
  const reports = [];
  let clock = 0;
  return {
    calls,
    reports,
    run: () => deployRender(config, {
      fetchImpl: async (url, init) => {
        calls.push({ url, ...init });
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.headers.Authorization, `Bearer ${config.apiKey}`);
        assert.ok(responses.length, `Unexpected request: ${init.method}`);
        const next = responses.shift();
        if (typeof next === 'function') return next(url, init);
        return next;
      },
      onReport: async (report) => reports.push(structuredClone(report)),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      ...options,
    }),
  };
}

function successSequence() {
  return [json(service), json([previous]), json(deployment('build_in_progress'), 201), json(deployment('update_in_progress')), json(deployment('live')), json(service), json([listed(deployment('live'))])];
}

test('already-live exact SHA is reused without publishing a duplicate', async () => {
  const h = harness([json(service), json([listed(deployment('live'))])]);
  const report = await h.run();
  assert.equal(report.result, 'success');
  assert.equal(report.reused, true);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('verify-only rejects a different live SHA without creating a deployment', async () => {
  const h = harness([json(service), json([previous])], { verifyOnly: true });
  await assert.rejects(h.run(), /commit/);
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('actual npm run start syntax is supported', async () => {
  const actual = structuredClone(service);
  actual.serviceDetails.envSpecificDetails.startCommand = 'npm --prefix apps/api run start';
  const h = harness([json(actual), json([listed(deployment('live'))])], { verifyOnly: true });
  assert.equal((await h.run()).result, 'success');
});

test('releases the exact SHA once, polls until live, and preserves rollback metadata only', async () => {
  const h = harness(successSequence());
  const report = await h.run();
  const posts = h.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { commitId: SHA, clearCache: 'do_not_clear' });
  assert.equal(posts[0].url, 'https://api.render.com/v1/services/srv-test123/deploys');
  assert.equal(report.result, 'success');
  assert.equal(report.deployId, 'dep-new');
  assert.equal(report.previousLiveDeployId, 'dep-previous');
  assert.equal(report.previousLiveSha, PREVIOUS_SHA);
  assert.equal(report.status, 'live');
  assert.ok(!JSON.stringify(h.reports).includes(config.apiKey));
  assert.ok(!JSON.stringify(h.reports).includes('never-log-this'));
  assert.equal(renderOutputs(report).render_previous_commit_sha, PREVIOUS_SHA);
});

test('requires a full release SHA and valid config without reflecting input', () => {
  for (const env of [{}, { RENDER_API_KEY: 'secret', RENDER_SERVICE_ID: 'srv-test', RELEASE_SHA: 'latest-secret' }]) {
    assert.throws(() => readRenderConfig(env), (error) => !error.message.includes('latest-secret'));
  }
});

for (const [field, value] of [['repo', 'https://example.com/other'], ['branch', 'feature'], ['autoDeploy', 'yes'], ['autoDeploy', undefined], ['type', 'cron_job'], ['suspended', 'suspended'], ['id', 'srv-other']]) {
  test(`blocks an unsafe service before POST: ${field}=${value}`, async () => {
    const h = harness([json({ ...service, [field]: value })]);
    await assert.rejects(h.run());
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
  });
}

for (const [label, modify] of [
  ['wrong root directory', (value) => { value.rootDir = ''; }],
  ['missing runtime', (value) => { delete value.serviceDetails.runtime; }],
  ['Docker runtime', (value) => { value.serviceDetails.runtime = 'docker'; }],
  ['contradictory legacy env', (value) => { value.serviceDetails.env = 'python'; }],
  ['missing native details', (value) => { delete value.serviceDetails.envSpecificDetails; }],
  ['build-time migration', (value) => { value.serviceDetails.envSpecificDetails.buildCommand += ' && npm run db:migrate'; }],
  ['different build command', (value) => { value.serviceDetails.envSpecificDetails.buildCommand = 'npm run api:build'; }],
  ['start-time seed', (value) => { value.serviceDetails.envSpecificDetails.startCommand = 'npm run db:seed && npm --prefix apps/api start'; }],
  ['pre-deploy migration', (value) => { value.serviceDetails.envSpecificDetails.preDeployCommand = 'npm run db:migrate'; }],
  ['invalid pre-deploy field', (value) => { value.serviceDetails.envSpecificDetails.preDeployCommand = null; }],
]) {
  test(`blocks unreviewed Render configuration before POST: ${label}`, async () => {
    const changed = structuredClone(service);
    modify(changed);
    const h = harness([json(changed)]);
    await assert.rejects(h.run());
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
  });
}

test('allows absent pre-deploy command and trims only outer build/start whitespace', async () => {
  const reviewed = structuredClone(service);
  delete reviewed.serviceDetails.env;
  delete reviewed.serviceDetails.envSpecificDetails.preDeployCommand;
  reviewed.serviceDetails.envSpecificDetails.buildCommand = `  ${reviewed.serviceDetails.envSpecificDetails.buildCommand}\n`;
  reviewed.serviceDetails.envSpecificDetails.startCommand = `\n${reviewed.serviceDetails.envSpecificDetails.startCommand} `;
  const sequence = successSequence();
  sequence[0] = json(reviewed);
  sequence[5] = json(reviewed);
  const h = harness(sequence);
  assert.equal((await h.run()).result, 'success');
});

for (const status of ['created', 'queued', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress', 'unrecognized_new_status']) {
  test(`blocks conflicting or unknown preflight status: ${status}`, async () => {
    const h = harness([json(service), json([previous, listed(deployment(status))])]);
    await assert.rejects(h.run());
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
  });
}

test('does not treat an older successful deployment as the current rollback target', async () => {
  const h = harness([json(service), json([previous, listed(deployment('live', 'dep-other'))])]);
  await assert.rejects(h.run(), { code: 'ambiguous_live' });
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
});

test('scans the next history page before triggering a deploy', async () => {
  const history = Array.from({ length: 100 }, (_, index) => listed(deployment('deactivated', `dep-old${index}`)));
  const h = harness([json(service), json(history), json([listed(deployment('queued'))])]);
  await assert.rejects(h.run(), { code: 'conflicting_deploy' });
  assert.match(h.calls[2].url, /cursor=cursor-dep-old99/);
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0);
});

test('retries a transient GET but never repeats an uncertain POST or logs response bodies', async () => {
  const h = harness([json({ secret: config.apiKey }, 503), json(service), json([previous]), json({ error: config.apiKey }, 503)]);
  await assert.rejects(h.run(), (error) => error.code === 'post_uncertain' && !error.message.includes(config.apiKey));
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(h.reports.at(-1).result, 'failed');
  assert.equal(h.reports.at(-1).postAttempted, true);
});

test('does not retry unauthorized reads', async () => {
  const h = harness([json({ secret: config.apiKey }, 401)]);
  await assert.rejects(h.run(), { code: 'http_error' });
  assert.equal(h.calls.length, 1);
});

test('empty accepted POST is ambiguous and cannot trigger a second POST', async () => {
  const h = harness([json(service), json([previous]), new Response(null, { status: 202 })]);
  await assert.rejects(h.run(), { code: 'post_uncertain' });
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
});

test('sanitizes fetch exceptions and applies a request timeout to POST', async () => {
  const h = harness([json(service), json([previous]), () => new Promise(() => {})], { requestTimeoutMs: 5 });
  await assert.rejects(h.run(), { code: 'post_uncertain' });
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(h.calls.at(-1).signal.aborted, true);
  const h2 = harness([json(service), json([previous]), () => { throw new Error(config.apiKey); }]);
  await assert.rejects(h2.run(), (error) => !error.message.includes(config.apiKey) && error.code === 'post_uncertain');
});

test('wrong POST commit fails while retaining a valid deploy ID for investigation', async () => {
  const h = harness([json(service), json([previous]), json(deployment('created', 'dep-new', PREVIOUS_SHA), 201)]);
  await assert.rejects(h.run(), { code: 'commit_mismatch' });
  assert.equal(h.reports.at(-1).deployId, 'dep-new');
  assert.equal(h.calls.length, 3);
});

test('a read-back with the wrong commit cannot be accepted as success', async () => {
  const h = harness([json(service), json([previous]), json(deployment('created'), 201), json(deployment('live', 'dep-new', PREVIOUS_SHA))]);
  await assert.rejects(h.run(), { code: 'commit_mismatch' });
});

for (const status of ['build_failed', 'pre_deploy_failed', 'update_failed', 'canceled', 'deactivated', 'new_unknown_status']) {
  test(`fails on terminal non-live or unknown deployment state: ${status}`, async () => {
    const h = harness([json(service), json([previous]), json(deployment('created'), 201), json(deployment(status))]);
    await assert.rejects(h.run());
    assert.equal(h.reports.at(-1).result, 'failed');
  });
}

test('bounds the overall polling deadline and reports that Render may still be deploying', async () => {
  const h = harness([json(service), json([previous]), json(deployment('created'), 201), json(deployment('queued'))], { timeoutMs: 10, pollIntervalMs: 20 });
  await assert.rejects(h.run(), { code: 'deploy_timeout' });
  assert.equal(h.reports.at(-1).status, 'queued');
  assert.equal(h.calls.length, 4);
});

test('detects a concurrent external deployment after the requested commit goes live', async () => {
  const h = harness([json(service), json([previous]), json(deployment('live'), 201), json(deployment('live')), json(service), json([listed(deployment('live')), listed(deployment('queued', 'dep-other'))])]);
  await assert.rejects(h.run(), { code: 'conflicting_deploy' });
  assert.equal(h.reports.at(-1).result, 'failed');
});

test('fails if another deployment supersedes the release before final verification', async () => {
  const h = harness([json(service), json([previous]), json(deployment('created'), 201), json(deployment('live')), json(service), json([listed(deployment('live', 'dep-other', PREVIOUS_SHA))])]);
  await assert.rejects(h.run(), { code: 'superseded_deploy' });
});
