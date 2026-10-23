import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDirectory, loadConfig, requireCommit, verifyArtifact } from './artifact.mjs';
import { validateManifest } from './smoke.mjs';

const components = ['frontend', 'api', 'mediaGateway', 'videoWorker'];
const all = [...components, 'database'];
const assert = (condition, message) => { if (!condition) throw new Error(message); };

/** Conservative allowlist. Deletions and both sides of a rename are classified by git --no-renames. */
export function affectedComponents(path) {
  assert(typeof path === 'string' && path.length > 0 && !/[\x00-\x1f\x7f\\]/.test(path)
    && !path.startsWith('/') && !path.split('/').some(part => ['', '.', '..'].includes(part)), 'Invalid changed repository path.');
  if (/^(?:README|LICENSE|CONTRIBUTING)(?:\.[^/]+)?$/i.test(path) || path.startsWith('docs/')) return [];
  if (path.startsWith('.github/') || path === '.gitignore') return ['frontend', 'api'];
  if (!path.startsWith('colearnx-v1.0/')) return all;
  const local = path.slice('colearnx-v1.0/'.length);
  if (local.startsWith('docs/') || /^(?:README|LICENSE)(?:\.[^/]+)?$/i.test(local)
    || local.startsWith('tests/') || /^(?:playwright|vitest)\.config\./.test(local)) return [];
  if (local.startsWith('db/')) return all;
  if (local.startsWith('apps/media-gateway/')) return ['mediaGateway'];
  if (local.startsWith('apps/video-worker/') || local.startsWith('deploy/local-video/')) return ['videoWorker'];
  if (local === 'apps/api/src/db/migration-checksum.ts') return ['api', 'frontend'];
  if (local.startsWith('apps/api/')) return ['api'];
  assert(!local.startsWith('apps/'), 'An unregistered service changed. Add an explicitly reviewed component rule before release.');
  if (local === '.node-version') return components;
  if (local.startsWith('deployment/') || local.startsWith('scripts/deployment/')) return ['frontend', 'api'];
  if (local.startsWith('src/') || local.startsWith('public/') || /^package(?:-lock)?\.json$/.test(local)
    || /^(?:index\.html|vite\.config\.[^/]+)$/.test(local)) return ['frontend'];
  // Unknown shared/configuration code is never silently treated as documentation.
  return all;
}

export function changedFilesBetween(base, target, directory = appDirectory, git = execFileSync) {
  requireCommit(base); requireCommit(target);
  const options = { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    git('git', ['merge-base', '--is-ancestor', base, target], options);
    const paths = git('git', ['diff', '--name-only', '--no-renames', '-z', base, target, '--'], options).split('\0');
    assert(paths.pop() === '', 'Incomplete changed-file output.');
    // Empty diff produces an empty string, which becomes [] after pop().
    for (const path of paths) affectedComponents(path);
    return paths;
  } catch {
    throw new Error('Cannot establish a complete ancestor diff from the deployed component. Fetch full history and inspect the baseline; do not guess or silently skip publication.');
  }
}

function payload(manifest) {
  return JSON.stringify({ appOrigin: manifest.appOrigin, apiBaseUrl: manifest.apiBaseUrl, paymentsEnabled: manifest.paymentsEnabled,
    hostedVideoEnabled: manifest.hostedVideoEnabled, mediaOrigins: manifest.mediaOrigins, uploadOrigins: manifest.uploadOrigins,
    files: manifest.files, assets: manifest.assets });
}

export function createReleasePlan({ commit, config, targetManifest, liveManifest, pages, render, externalBaselines = {},
  externalReviewed = false, forceWebRelease = false, diff }) {
  requireCommit(commit);
  validateManifest(targetManifest, config, commit);
  requireCommit(pages?.previousCommitSha);
  assert(/^[a-f0-9-]{20,40}$/.test(pages.previousDeploymentId ?? '') && pages.project === config.pagesProject,
    'A verified existing Pages deployment identity is required.');
  assert(render?.result === 'success' && render.observedOnly === true && render.postAttempted === false
    && /^dep-[a-z0-9]+$/.test(render.deployId ?? ''), 'A read-only Render baseline is required.');
  requireCommit(render.releaseSha);
  assert(liveManifest?.commit === pages.previousCommitSha, 'Pages metadata and the public frontend manifest disagree.');
  // Baseline may intentionally use the previous public feature config, but never a different app origin.
  validateManifest(liveManifest, { ...config, apiBaseUrl: liveManifest.apiBaseUrl, paymentsEnabled: liveManifest.paymentsEnabled,
    hostedVideoEnabled: liveManifest.hostedVideoEnabled, mediaOrigins: liveManifest.mediaOrigins, uploadOrigins: liveManifest.uploadOrigins }, pages.previousCommitSha);
  assert(typeof diff === 'function' && typeof forceWebRelease === 'boolean' && typeof externalReviewed === 'boolean', 'Invalid release planner options.');
  const baselines = { frontend: pages.previousCommitSha, api: render.releaseSha, ...externalBaselines };
  const planned = {};
  let databaseChanged = false;
  for (const name of components) {
    const base = baselines[name];
    if (base === undefined || base === '') {
      assert(['mediaGateway', 'videoWorker'].includes(name), 'Missing web component baseline.');
      planned[name] = { action: 'manual-review', baseline: null, expectedCommit: null, reason: 'deployed baseline not recorded', changedFiles: [] };
      continue;
    }
    requireCommit(base);
    const changed = diff(base, commit);
    assert(Array.isArray(changed), 'Changed-file inventory is required.');
    const relevant = changed.filter(path => affectedComponents(path).includes(name));
    databaseChanged ||= changed.some(path => affectedComponents(path).includes('database'));
    const external = ['mediaGateway', 'videoWorker'].includes(name);
    const deploy = relevant.length > 0 || (!external && forceWebRelease);
    planned[name] = { action: deploy ? (external ? 'manual-review' : 'deploy') : 'retain', baseline: base,
      expectedCommit: external && deploy ? null : deploy ? commit : base,
      reason: relevant.length ? 'component or shared dependency changed' : deploy ? 'manual full web release' : 'no runtime changes', changedFiles: relevant };
  }
  if (planned.frontend.action === 'retain' && payload(liveManifest) !== payload(targetManifest)) {
    // Never retain a baseline whose bytes or response-header rules differ from the tested artifact.
    planned.frontend.action = 'deploy';
    planned.frontend.expectedCommit = commit;
    planned.frontend.reason = 'tested frontend bytes or public configuration differ';
  }
  const manualComponents = components.filter(name => planned[name].action === 'manual-review');
  return { schemaVersion: 1, commit, databaseChanged, components: planned,
    previousApiDeployId: render.deployId, previousPagesDeploymentId: pages.previousDeploymentId,
    externalReviewed, manualComponents, blocked: manualComponents.length > 0 && !externalReviewed,
    expectedFrontendManifest: planned.frontend.action === 'deploy' ? targetManifest : liveManifest };
}

export function validateReleasePlan(plan, commit) {
  requireCommit(commit);
  assert(plan?.schemaVersion === 1 && plan.commit === commit && plan.blocked === false, 'Release plan is missing, blocked or belongs to a different target commit.');
  for (const name of ['frontend', 'api']) {
    const item = plan.components?.[name];
    requireCommit(item?.baseline); requireCommit(item?.expectedCommit);
    assert(['deploy', 'retain'].includes(item.action) && item.expectedCommit === (item.action === 'deploy' ? commit : item.baseline), 'Invalid planned web component identity.');
  }
  assert(/^dep-[a-z0-9]+$/.test(plan.previousApiDeployId ?? '') && /^[a-f0-9-]{20,40}$/.test(plan.previousPagesDeploymentId ?? ''), 'Invalid planned platform deployment identity.');
  assert(plan.expectedFrontendManifest?.commit === plan.components.frontend.expectedCommit, 'Planned frontend manifest has a different component identity.');
  return plan;
}

export function planOutputs(plan) {
  validateReleasePlan(plan, plan.commit);
  return { frontend_required: String(plan.components.frontend.action === 'deploy'), api_required: String(plan.components.api.action === 'deploy'),
    expected_frontend_sha: plan.components.frontend.expectedCommit, expected_api_sha: plan.components.api.expectedCommit,
    previous_api_sha: plan.components.api.baseline, previous_api_deploy_id: plan.previousApiDeployId };
}

export async function readLiveManifest(config, fetchImpl = fetch) {
  try {
    const url = new URL('/release.json', config.appOrigin);
    url.searchParams.set('release-plan', String(Date.now()));
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20_000) });
    assert(response.status === 200 && !response.redirected, 'invalid response');
    return await response.json();
  } catch {
    throw new Error('Cannot read the live frontend release manifest. No deployment plan can be trusted.');
  }
}

async function main() {
  const commit = requireCommit(process.env.RELEASE_SHA);
  const config = await loadConfig();
  const directory = resolve(appDirectory, 'release-report');
  const plan = createReleasePlan({ commit, config,
    targetManifest: await verifyArtifact(resolve(appDirectory, 'dist'), config, commit),
    liveManifest: await readLiveManifest(config),
    pages: JSON.parse(await readFile(resolve(directory, 'pages-before.json'), 'utf8')),
    render: JSON.parse(await readFile(resolve(directory, 'render-before.json'), 'utf8')),
    externalBaselines: { mediaGateway: process.env.MEDIA_GATEWAY_DEPLOYED_SHA, videoWorker: process.env.VIDEO_WORKER_DEPLOYED_SHA },
    externalReviewed: process.env.EXTERNAL_COMPONENTS_REVIEWED === 'true', forceWebRelease: process.env.FORCE_WEB_RELEASE === 'true',
    diff: (base, target) => changedFilesBetween(base, target) });
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  for (const name of components) console.log(`${name}: ${plan.components[name].action} (${plan.components[name].reason}).`);
  assert(!plan.blocked, 'Gateway/video changes or unknown baselines need separate manual review. They are NOT published by this workflow. Record deployed baseline SHAs and obtain explicit confirmation.');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(planOutputs(plan)).map(([key, value]) => `${key}=${value}\n`).join(''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof SyntaxError ? 'Invalid local release planning input.' : error.message); process.exitCode = 1; });
}
