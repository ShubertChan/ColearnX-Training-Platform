import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './artifact.mjs';
import { readPagesCredentials, readPagesProject, verifyPagesUnchanged } from './pages-preflight.mjs';

const config = await loadConfig();
const credentials = { accountId: 'a'.repeat(32), apiToken: 'synthetic-only-never-real-token' };
const previousId = '12345678-1234-1234-1234-123456789abc';
const previousCommit = 'b'.repeat(40);
const project = {
  name: config.pagesProject,
  production_branch: 'main',
  domains: [config.pagesProject + '.pages.dev', new URL(config.appOrigin).hostname],
  source: null,
  canonical_deployment: { id: previousId, deployment_trigger: { metadata: { commit_hash: previousCommit } } },
  deployment_configs: { production: { env_vars: { SECRET: { value: 'sensitive-project-response' } } } },
};
const json = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
const mock = (override = {}) => ({ fetchImpl: async () => json({ ...project, ...override }) });

test('a competing publication or missing deployment identity stops Pages publishing', () => {
  const before = { project: config.pagesProject, previousDeploymentId: previousId };
  assert.doesNotThrow(() => verifyPagesUnchanged(before, { ...before }));
  assert.throws(() => verifyPagesUnchanged(before, { ...before, previousDeploymentId: 'aaaaaaaa-1234-1234-1234-123456789abc' }), /Pages changed/);
  assert.throws(() => verifyPagesUnchanged(before, { ...before, project: 'another-project' }), /Pages changed/);
  for (const absent of [undefined, {}, { ...before, previousDeploymentId: null }]) {
    assert.throws(() => verifyPagesUnchanged(absent, before), /Cannot verify/);
    assert.throws(() => verifyPagesUnchanged(before, absent), /Cannot verify/);
  }
});

test('Pages preflight verifies the existing project with GET only and returns only safe identifiers', async () => {
  let call;
  const report = await readPagesProject(config, credentials, { fetchImpl: async (url, init) => { call = { url, init }; return json(project); } });
  assert.deepEqual(report, { project: config.pagesProject, previousDeploymentId: previousId, previousCommitSha: previousCommit });
  assert.equal(call.url, `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/pages/projects/${config.pagesProject}`);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.body, undefined);
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers.Authorization, `Bearer ${credentials.apiToken}`);
  assert.ok(!JSON.stringify(report).includes('sensitive-project-response'));
});

test('Pages preflight accepts Git sources only when deployments are explicitly disabled', async () => {
  await readPagesProject(config, credentials, mock({ source: { type: 'github', config: { deployments_enabled: false } } }));
  for (const source of [{ type: 'github', config: { deployments_enabled: true } }, { type: 'github', config: {} }, {}]) {
    await assert.rejects(readPagesProject(config, credentials, mock({ source })), /Disable Pages Git deployments/);
  }
});

test('Pages preflight rejects the wrong project, production branch, or canonical domain', async () => {
  await assert.rejects(readPagesProject(config, credentials, mock({ name: 'different-project' })), /different Pages project/);
  await assert.rejects(readPagesProject(config, credentials, mock({ production_branch: 'preview' })), /production branch/);
  await assert.rejects(readPagesProject(config, credentials, mock({ domains: [config.pagesProject + '.pages.dev'] })), /canonical staging domain/);
});

test('Pages previous deployment metadata is nullable and never copies arbitrary response text', async () => {
  const missing = await readPagesProject(config, credentials, mock({ canonical_deployment: null }));
  assert.equal(missing.previousDeploymentId, null);
  assert.equal(missing.previousCommitSha, null);
  const invalid = await readPagesProject(config, credentials, mock({ canonical_deployment: { id: 'sensitive-project-response', deployment_trigger: { metadata: { commit_hash: 'short-sha' } } } }));
  assert.deepEqual(invalid, { project: config.pagesProject, previousDeploymentId: null, previousCommitSha: null });
});

test('Pages API errors are not read or echoed, and malformed envelopes fail closed', async () => {
  let bodyRead = false;
  await assert.rejects(readPagesProject(config, credentials, { fetchImpl: async () => ({ status: 403, json: async () => { bodyRead = true; throw new Error('sensitive-project-response'); } }) }), /Cloudflare rejected/);
  assert.equal(bodyRead, false);
  await assert.rejects(readPagesProject(config, credentials, { fetchImpl: async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'sensitive-project-response' }] })) }), (error) => {
    assert.match(error.message, /did not confirm/);
    assert.ok(!error.message.includes('sensitive-project-response'));
    return true;
  });
  await assert.rejects(readPagesProject(config, credentials, { fetchImpl: async () => new Response('not-json') }), /invalid JSON/);
});

test('Pages network exceptions cannot leak API tokens or raw upstream details', async () => {
  await assert.rejects(readPagesProject(config, credentials, { fetchImpl: async () => { throw new Error(`sensitive-project-response ${credentials.apiToken}`); } }), (error) => {
    assert.match(error.message, /could not reach/);
    assert.ok(!error.message.includes(credentials.apiToken));
    assert.ok(!error.message.includes('sensitive-project-response'));
    return true;
  });
});

test('Pages preflight timeout includes stalled fetch and response JSON parsing', async () => {
  for (const blockAt of ['fetch', 'json']) {
    let expire;
    let signal;
    let jsonStarted = false;
    const pending = readPagesProject(config, credentials, {
      fetchImpl: async (_url, init) => {
        signal = init.signal;
        if (blockAt === 'fetch') return new Promise(() => {});
        return { status: 200, json: async () => { jsonStarted = true; return new Promise(() => {}); } };
      },
      setTimeoutFn: (callback) => { expire = callback; return 7; },
      clearTimeoutFn: (timer) => assert.equal(timer, 7),
    });
    // Let the mocked HTTP response advance into response.json before expiring its deadline.
    await Promise.resolve();
    if (blockAt === 'json') assert.equal(jsonStarted, true);
    expire();
    await assert.rejects(pending, /timed out/);
    assert.equal(signal.aborted, true);
  }
});

test('invalid Cloudflare credentials and staging config fail before network access', async () => {
  let called = false;
  const deps = { fetchImpl: async () => { called = true; return json(project); } };
  await assert.rejects(readPagesProject(config, { ...credentials, accountId: 'bad-id' }, deps), /CLOUDFLARE_ACCOUNT_ID/);
  await assert.rejects(readPagesProject(config, { ...credentials, apiToken: 'bad\ntoken' }, deps), /protected secret/);
  await assert.rejects(readPagesProject({ ...config, pagesBranch: 'unsafe' }, credentials, deps), /checked-in staging configuration/);
  assert.throws(() => readPagesCredentials({}), /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(called, false);
});
