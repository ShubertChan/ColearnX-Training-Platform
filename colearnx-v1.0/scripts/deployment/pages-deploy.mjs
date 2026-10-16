import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDirectory, loadConfig, requireCommit, validateConfig, verifyArtifact } from './artifact.mjs';

export function pagesArguments(config, commit) {
  requireCommit(commit);
  validateConfig(config);
  return [resolve(appDirectory, 'deployment/node_modules/wrangler/bin/wrangler.js'), 'pages', 'deploy', 'dist', '--project-name', config.pagesProject,
    '--branch', config.pagesBranch, '--commit-hash', commit, '--commit-message', `staging-${commit}`, '--commit-dirty=false'];
}

export function verifyCliVersion(installedVersion, pinnedVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(pinnedVersion || '') || installedVersion !== pinnedVersion) {
    throw new Error('Install the exact lockfile-pinned deployment CLI before providing secrets.');
  }
}

async function main() {
  const config = await loadConfig();
  const commit = requireCommit(process.env.RELEASE_SHA);
  if (!process.env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID || '')) throw new Error('Missing Cloudflare credentials.');
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Publish only through the approved main workflow.');
  const cli = JSON.parse(await readFile(resolve(appDirectory, 'deployment/node_modules/wrangler/package.json'), 'utf8'));
  const tooling = JSON.parse(await readFile(resolve(appDirectory, 'deployment/package.json'), 'utf8'));
  verifyCliVersion(cli.version, tooling.dependencies?.wrangler);
  await verifyArtifact(resolve(appDirectory, 'dist'), config, commit);
  // GitHub's Linux runner avoids shell interpolation; no tokens appear in command arguments.
  if (process.platform === 'win32') throw new Error('Run publishing through the Linux GitHub Actions workflow.');
  const reportFile = resolve(appDirectory, 'release-report/pages.json');
  await mkdir(resolve(appDirectory, 'release-report'), { recursive: true });
  await writeFile(reportFile, JSON.stringify({ commit, project: config.pagesProject, status: 'started' }, null, 2));
  const result = spawnSync(process.execPath, pagesArguments(config, commit), { cwd: appDirectory, env: process.env, stdio: 'inherit', timeout: 600_000 });
  const status = result.status === 0 && !result.error ? 'uploaded' : 'failed_or_unknown';
  await writeFile(reportFile, JSON.stringify({ commit, project: config.pagesProject, status }, null, 2));
  if (status !== 'uploaded') throw new Error('Pages upload failed or completion is unknown; inspect Cloudflare before retrying.');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `pages_commit_sha=${commit}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Pages publish failed. Inspect the deployment status; do not assume rollback occurred.'); process.exitCode = 1; });
}
