import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appDirectory, migrationInventory, requireCommit } from './artifact.mjs';

const repository = 'ShubertChan/ColearnX-Training-Platform';

export async function verifyReleaseSource({ env = process.env, head, inventory, fetchImpl = fetch }) {
  const sha = requireCommit(env.RELEASE_SHA);
  if (env.GITHUB_REPOSITORY?.toLowerCase() !== repository.toLowerCase() || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || head !== sha) throw new Error('Only a manual main release of the checked-out SHA is permitted.');
  if (!Array.isArray(inventory) || !inventory.length || env.MIGRATIONS_REVIEWED !== 'true' || env.LAST_APPLIED_MIGRATION !== inventory.at(-1)?.filename) {
    throw new Error('Review cloud migrations separately and acknowledge the exact final migration filename. No cloud migration was run.');
  }
  const headers = { Accept: 'application/vnd.github+json' };
  if (env.GH_TOKEN) headers.Authorization = `Bearer ${env.GH_TOKEN}`;
  let response;
  let body;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}/git/ref/heads/main`, {
      headers, redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (response.status !== 200) throw new Error();
    body = await response.json();
  } catch { throw new Error('Cannot verify current GitHub main. No deployment is permitted.'); }
  if (body?.object?.sha !== sha) throw new Error('This workflow commit is no longer main. Start a new release from current main.');
  return { commit: sha, lastRequiredMigration: inventory.at(-1).filename, migrationCount: inventory.length };
}

async function main() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appDirectory, encoding: 'utf8' }).trim();
  console.log(JSON.stringify(await verifyReleaseSource({ head, inventory: await migrationInventory() })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
