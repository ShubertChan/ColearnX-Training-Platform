import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDirectory, loadConfig, validateConfig } from './artifact.mjs';

class PreflightError extends Error {}

function requireValue(condition, message) {
  if (!condition) throw new PreflightError(message);
}

export function readPagesCredentials(env = process.env) {
  requireValue(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? ''), 'Set a valid CLOUDFLARE_ACCOUNT_ID.');
  requireValue(typeof env.CLOUDFLARE_API_TOKEN === 'string' && env.CLOUDFLARE_API_TOKEN.trim().length > 0
    && !/[\r\n]/.test(env.CLOUDFLARE_API_TOKEN), 'Set CLOUDFLARE_API_TOKEN through a protected secret.');
  return { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN };
}

/** Read-only target checks. Never return the project response: it contains environment variables. */
export async function readPagesProject(config, credentials, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  try { validateConfig(config); } catch { throw new PreflightError('Invalid checked-in staging configuration.'); }
  readPagesCredentials({ CLOUDFLARE_ACCOUNT_ID: credentials?.accountId, CLOUDFLARE_API_TOKEN: credentials?.apiToken });
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, 'Pages preflight timeout must be between 1 and 60000 milliseconds.');
  const controller = new AbortController();
  let timer;
  try {
    const operation = async () => {
      let response;
      try {
        response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/pages/projects/${config.pagesProject}`, {
          method: 'GET',
          redirect: 'error',
          headers: { Authorization: `Bearer ${credentials.apiToken}`, Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch {
        throw new PreflightError('Cloudflare project preflight could not reach the API.');
      }
      // Do not inspect API error bodies, which may contain account information or configuration.
      requireValue(response.status === 200 && !response.redirected, 'Cloudflare rejected the project preflight request. Check access and the configured account.');
      let payload;
      try { payload = await response.json(); } catch { throw new PreflightError('Cloudflare project preflight returned invalid JSON.'); }
      requireValue(payload?.success === true && payload.result && typeof payload.result === 'object', 'Cloudflare did not confirm a valid Pages project.');
      const project = payload.result;
      requireValue(project.name === config.pagesProject, 'Cloudflare returned a different Pages project.');
      requireValue(project.production_branch === config.pagesBranch, 'Pages production branch does not match the approved staging branch.');
      const hostname = new URL(config.appOrigin).hostname;
      requireValue(Array.isArray(project.domains) && project.domains.includes(hostname), 'The canonical staging domain is not attached to this Pages project.');
      requireValue(project.source == null || project.source?.config?.deployments_enabled === false,
        'Disable Pages Git deployments before using this controlled release workflow.');

      const previous = project.canonical_deployment;
      const previousDeploymentId = /^[a-f0-9-]{20,40}$/.test(previous?.id ?? '') ? previous.id : null;
      const hash = previous?.deployment_trigger?.metadata?.commit_hash;
      const previousCommitSha = /^[a-f0-9]{40}$/.test(hash ?? '') ? hash : null;
      return { project: config.pagesProject, previousDeploymentId, previousCommitSha };
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeoutFn(() => {
        reject(new PreflightError('Cloudflare project preflight timed out. No deployment was requested.'));
        controller.abort();
      }, timeoutMs);
    });
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError('Cloudflare project preflight failed. No response details or secrets were logged.');
  } finally {
    clearTimeoutFn(timer);
    controller.abort();
  }
}

export function verifyPagesUnchanged(previous, current) {
  requireValue(/^[a-f0-9-]{20,40}$/.test(previous?.previousDeploymentId ?? '')
    && /^[a-f0-9-]{20,40}$/.test(current?.previousDeploymentId ?? ''),
  'Cannot verify the existing Pages deployment identity. Inspect the project before publishing.');
  requireValue(previous.project === current.project && previous.previousDeploymentId === current.previousDeploymentId,
    'Pages changed since release preflight. Inspect both platforms before publishing.');
}

async function main() {
  const args = process.argv.slice(2);
  requireValue(args.length === 0 || (args.length === 1 && args[0] === '--verify-unchanged'), 'Use pages-preflight.mjs [--verify-unchanged].');
  const report = await readPagesProject(await loadConfig(), readPagesCredentials());
  const directory = resolve(appDirectory, 'release-report');
  if (args[0] === '--verify-unchanged') {
    const previous = JSON.parse(await readFile(resolve(directory, 'pages-before.json'), 'utf8'));
    verifyPagesUnchanged(previous, report);
    console.log('Pages canonical deployment is unchanged since preflight.');
    return;
  }
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'pages-before.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('Pages read-only preflight passed. Previous non-secret deployment identity saved in release-report/pages-before.json.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof PreflightError ? error.message : 'Pages preflight failed. Check local configuration and report permissions; no project response was logged.');
    process.exitCode = 1;
  });
}
