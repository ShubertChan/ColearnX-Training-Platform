import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Documented API contract: https://api-docs.render.com/reference/create-deploy
// and https://api-docs.render.com/openapi/render-public-api-1.json
const API_BASE = 'https://api.render.com/v1';
const EXPECTED_REPO = 'https://github.com/ShubertChan/ColearnX-Training-Platform';
const EXPECTED_BUILD = 'npm --prefix apps/api ci --include=dev && npm --prefix apps/api run build';
const EXPECTED_START = new Set(['npm --prefix apps/api start', 'npm --prefix apps/api run start']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SERVICE_PATTERN = /^srv-[a-z0-9]+$/;
const DEPLOY_PATTERN = /^dep-[a-z0-9]+$/;
const ACTIVE = new Set(['created', 'queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress']);
const FAILED = new Set(['build_failed', 'pre_deploy_failed', 'update_failed', 'canceled', 'deactivated']);
const KNOWN = new Set([...ACTIVE, ...FAILED, 'live']);

class SafeError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function requireValue(condition, code, message) {
  if (!condition) throw new SafeError(code, message);
}

export function readRenderConfig(env = process.env) {
  requireValue(typeof env.RENDER_API_KEY === 'string' && env.RENDER_API_KEY.trim().length > 0
    && !/[\r\n]/.test(env.RENDER_API_KEY), 'invalid_api_key', 'Set RENDER_API_KEY through a protected secret.');
  requireValue(SERVICE_PATTERN.test(env.RENDER_SERVICE_ID ?? ''), 'invalid_service_id', 'RENDER_SERVICE_ID must be a Render service ID.');
  requireValue(SHA_PATTERN.test(env.RELEASE_SHA ?? ''), 'invalid_release_sha', 'RELEASE_SHA must be a full lowercase 40-character Git commit SHA.');
  return { apiKey: env.RENDER_API_KEY, serviceId: env.RENDER_SERVICE_ID, releaseSha: env.RELEASE_SHA };
}

function validateService(service, serviceId) {
  requireValue(service?.id === serviceId && service?.type === 'web_service', 'wrong_service', 'The selected Render resource is not the expected web service.');
  // Render can return the canonical Git URL with or without its .git suffix.
  requireValue(service.repo === EXPECTED_REPO || service.repo === `${EXPECTED_REPO}.git`, 'wrong_repository', 'The Render service must use the CoLearnX GitHub repository.');
  requireValue(service.branch === 'main', 'wrong_branch', 'The Render service must track main.');
  requireValue(service.autoDeploy === 'no', 'autodeploy_enabled', 'Disable Render Auto-Deploy before using the controlled release workflow.');
  requireValue(service.suspended === 'not_suspended', 'service_suspended', 'The Render service must be active before release.');
  requireValue(service.rootDir === 'colearnx-v1.0', 'wrong_root_directory', 'Set the Render root directory to colearnx-v1.0 before releasing.');
  const details = service.serviceDetails;
  // runtime is the current field; env is deprecated but must not contradict it if present.
  requireValue(details?.runtime === 'node' && (details.env === undefined || details.env === 'node'), 'wrong_runtime', 'The Render service must use the native Node runtime.');
  const native = details.envSpecificDetails;
  requireValue(typeof native?.buildCommand === 'string' && native.buildCommand.trim() === EXPECTED_BUILD,
    'unreviewed_build_command', 'The Render build command differs from the reviewed API-only build. Check the deployment guide; no settings were changed.');
  requireValue(typeof native.startCommand === 'string' && EXPECTED_START.has(native.startCommand.trim()),
    'unreviewed_start_command', 'The Render start command differs from the reviewed API start. Check the deployment guide; no settings were changed.');
  // This optional field must be unset or blank: a deploy must not indirectly run migrations/seed.
  requireValue(native.preDeployCommand === undefined || (typeof native.preDeployCommand === 'string' && native.preDeployCommand.trim() === ''),
    'predeploy_command_present', 'Clear the Render Pre-Deploy Command before release. Migrations and seed are not part of this workflow.');
}

function validateDeploy(deploy, { sha, id } = {}) {
  requireValue(DEPLOY_PATTERN.test(deploy?.id ?? ''), 'invalid_deploy', 'Render returned an invalid deployment identity. Inspect the dashboard before retrying.');
  requireValue(KNOWN.has(deploy.status), 'unknown_status', 'Render returned an unknown deployment status. Inspect the dashboard before retrying.');
  if (id) requireValue(deploy.id === id, 'deploy_id_mismatch', 'Render returned a different deployment ID.');
  if (sha) requireValue(deploy.commit?.id === sha, 'commit_mismatch', 'Render did not confirm the exact requested release SHA. Inspect the dashboard before retrying.');
  return deploy;
}

/** All network, clock and report dependencies are injectable; unit tests never contact Render. */
export async function deployRender(config, {
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
  onReport = async () => {},
  timeoutMs = 20 * 60_000,
  requestTimeoutMs = 20_000,
  pollIntervalMs = 15_000,
  verifyOnly = false,
} = {}) {
  // Validate even when a caller bypasses the CLI environment parser.
  readRenderConfig({ RENDER_API_KEY: config.apiKey, RENDER_SERVICE_ID: config.serviceId, RELEASE_SHA: config.releaseSha });
  requireValue([timeoutMs, requestTimeoutMs, pollIntervalMs].every((value) => Number.isFinite(value) && value > 0), 'invalid_timeout', 'Deployment timeouts must be positive finite numbers.');
  const started = now();
  const deadline = started + timeoutMs;
  const servicePath = `/services/${config.serviceId}`;
  const report = {
    serviceId: config.serviceId,
    releaseSha: config.releaseSha,
    deployId: null,
    status: 'not_started',
    result: 'pending',
    previousLiveDeployId: null,
    previousLiveSha: null,
    postAttempted: false,
    startedAt: new Date(started).toISOString(),
  };
  const checkpoint = () => onReport({ ...report });
  const remaining = () => {
    const time = deadline - now();
    requireValue(time > 0, 'deploy_timeout', 'Deployment verification timed out. Render may still be deploying; inspect the dashboard before retrying.');
    return time;
  };
  const pause = async (ms) => sleep(Math.min(ms, remaining()));

  async function requestOnce(method, path, body) {
    const controller = new AbortController();
    let timer;
    try {
      const expiration = Math.min(requestTimeoutMs, remaining());
      const operation = async () => {
        let response;
        try {
          response = await fetchImpl(`${API_BASE}${path}`, {
            method,
            redirect: 'error',
            headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal,
          });
        } catch {
          throw new SafeError(method === 'POST' ? 'post_uncertain' : 'request_failed', method === 'POST'
            ? 'The deploy request outcome is uncertain. Do not retry automatically; inspect Render first.'
            : 'Render API could not be reached.', method === 'GET');
        }
        if (!response.ok) {
          // Never read or echo API error bodies: they can contain secrets or service configuration.
          const transient = response.status === 429 || response.status >= 500;
          throw new SafeError(method === 'POST' && transient ? 'post_uncertain' : 'http_error',
            method === 'POST' ? 'Render did not confirm the deploy request. Inspect the dashboard before retrying.' : 'Render API rejected a read request.', method === 'GET' && transient);
        }
        try {
          return await response.json();
        } catch {
          // The documented 202 response can be empty. Without a deploy ID, do not guess or POST again.
          throw new SafeError(method === 'POST' ? 'post_uncertain' : 'invalid_response', method === 'POST'
            ? 'Render accepted the request without a verifiable deployment response. Inspect the dashboard before retrying.'
            : 'Render returned an invalid JSON response.');
        }
      };
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new SafeError(method === 'POST' ? 'post_uncertain' : 'request_timeout', method === 'POST'
            ? 'The deploy request timed out with an uncertain outcome. Inspect Render before retrying.'
            : 'A Render API read timed out.', method === 'GET'));
        }, expiration);
      });
      return await Promise.race([operation(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function read(path) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await requestOnce('GET', path);
      } catch (error) {
        if (!(error instanceof SafeError) || !error.retryable || attempt === 2) throw error;
        await pause(2_000 * (attempt + 1));
      }
    }
  }

  async function listDeploys() {
    const deployments = [];
    const cursors = new Set();
    let cursor;
    // Fail closed if history exceeds the bounded scan; never deploy with an incomplete conflict check.
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
      const rows = await read(`${servicePath}/deploys?${query}`);
      requireValue(Array.isArray(rows) && rows.length <= 100, 'invalid_deploy_list', 'Render returned an invalid deployment list.');
      for (const row of rows) deployments.push(validateDeploy(row?.deploy));
      if (rows.length < 100) return deployments;
      cursor = rows.at(-1)?.cursor;
      requireValue(typeof cursor === 'string' && cursor.length > 0 && !cursors.has(cursor), 'invalid_cursor', 'Render deployment pagination could not be verified.');
      cursors.add(cursor);
    }
    throw new SafeError('history_limit', 'Deployment history exceeded the safety scan limit. Review the deployment history before releasing.');
  }

  function requireNoConflict(deployments, expectedLiveId) {
    requireValue(!deployments.some((deploy) => ACTIVE.has(deploy.status)), 'conflicting_deploy', 'Another Render deployment is in progress. Wait for it to finish and retry this workflow.');
    const live = deployments.filter((deploy) => deploy.status === 'live');
    requireValue(live.length <= 1, 'ambiguous_live', 'Render returned multiple live deployments. Inspect the service before releasing.');
    if (expectedLiveId) requireValue(live.length === 1 && live[0].id === expectedLiveId && live[0].commit?.id === config.releaseSha, 'superseded_deploy', 'The requested release is no longer the only live Render deployment. Do not publish the frontend.');
    return live[0];
  }

  try {
    validateService(await read(servicePath), config.serviceId);
    const previous = requireNoConflict(await listDeploys());
    if (previous) {
      requireValue(SHA_PATTERN.test(previous.commit?.id ?? ''), 'invalid_previous_commit', 'The current live Git commit could not be recorded for rollback.');
      report.previousLiveDeployId = previous.id;
      report.previousLiveSha = previous.commit.id;
    }
    if (verifyOnly || previous?.commit?.id === config.releaseSha) {
      requireValue(previous?.commit?.id === config.releaseSha, 'commit_not_live', 'The tested Render commit is not live. Do not publish or accept the frontend.');
      report.deployId = previous.id;
      report.status = 'live';
      report.result = 'success';
      report.reused = true;
      report.finishedAt = new Date(now()).toISOString();
      await checkpoint();
      return { ...report };
    }
    report.postAttempted = true;
    report.status = 'requesting';
    await checkpoint();
    // Exactly one POST, pinned to the tested SHA. No deploy hooks and no "latest commit" fallback.
    const created = await requestOnce('POST', `${servicePath}/deploys`, { commitId: config.releaseSha, clearCache: 'do_not_clear' });
    // Preserve a valid ID even if the response's commit or status cannot be verified.
    if (DEPLOY_PATTERN.test(created?.id ?? '')) report.deployId = created.id;
    validateDeploy(created, { sha: config.releaseSha });
    report.status = created.status;
    await checkpoint();
    while (true) {
      // Read back even when POST claims live; do not equate "accepted" with deployment success.
      remaining();
      const current = validateDeploy(await read(`${servicePath}/deploys/${report.deployId}`), { sha: config.releaseSha, id: report.deployId });
      report.status = current.status;
      await checkpoint();
      requireValue(!FAILED.has(current.status), 'deploy_failed', 'The Render deployment did not become live. Inspect its deployment logs.');
      if (current.status === 'live') {
        validateService(await read(servicePath), config.serviceId);
        requireNoConflict(await listDeploys(), report.deployId);
        report.result = 'success';
        report.finishedAt = new Date(now()).toISOString();
        await checkpoint();
        return { ...report };
      }
      await pause(pollIntervalMs);
    }
  } catch (error) {
    const safe = error instanceof SafeError ? error : new SafeError('internal_error', 'The deployment helper failed. No raw response or secret has been logged. Inspect the saved release report.');
    report.result = 'failed';
    report.errorCode = safe.code;
    report.finishedAt = new Date(now()).toISOString();
    try { await checkpoint(); } catch { /* Keep the original sanitized failure. */ }
    throw safe;
  }
}

export function renderOutputs(report) {
  // Values are validated IDs/SHA/statuses, not arbitrary Render response fields or commit messages.
  return {
    render_deploy_id: report.deployId ?? '',
    render_commit_sha: report.releaseSha,
    render_status: report.status,
    render_result: report.result,
    render_previous_deploy_id: report.previousLiveDeployId ?? '',
    render_previous_commit_sha: report.previousLiveSha ?? '',
  };
}

async function main() {
  const args = process.argv.slice(2);
  requireValue(args.length === 0 || (args.length === 1 && args[0] === '--verify-only'), 'invalid_args', 'Use render-deploy.mjs [--verify-only].');
  const verifyOnly = args[0] === '--verify-only';
  let finalReport;
  try {
    const config = readRenderConfig();
    await deployRender(config, { verifyOnly, onReport: async (report) => {
      finalReport = report;
      await mkdir('release-report', { recursive: true });
      await writeFile(`release-report/${verifyOnly ? 'render-check' : 'render'}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } });
    console.log(`Render confirmed the exact release SHA is live. Release evidence: release-report/${verifyOnly ? 'render-check' : 'render'}.json`);
  } catch (error) {
    console.error(error instanceof SafeError ? error.message : 'The deployment helper failed; no sensitive details were logged.');
    process.exitCode = 1;
  } finally {
    if (finalReport && process.env.GITHUB_OUTPUT && !verifyOnly) {
      try {
        await appendFile(process.env.GITHUB_OUTPUT, Object.entries(renderOutputs(finalReport)).map(([key, value]) => `${key}=${value}\n`).join(''), 'utf8');
      } catch {
        console.error('Could not save GitHub step outputs. Do not continue the release.');
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
