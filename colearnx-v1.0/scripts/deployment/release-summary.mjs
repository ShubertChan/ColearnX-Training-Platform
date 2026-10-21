import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appDirectory, loadConfig } from './artifact.mjs';

const config = await loadConfig();
const env = process.env;
const safeSha = (value) => /^[a-f0-9]{40}$/.test(value || '') ? value : 'unavailable';
const safeId = (value) => /^dep-[a-z0-9]+$/.test(value || '') ? value : 'unavailable';
let pagesStatus = 'not started';
try {
  const pages = JSON.parse(await readFile(resolve(appDirectory, 'release-report/pages.json'), 'utf8'));
  if (['started', 'uploaded', 'failed_or_unknown'].includes(pages.status)) pagesStatus = pages.status;
} catch { /* Publish might not have started. */ }
const status = ['success', 'failure', 'cancelled'].includes(env.JOB_STATUS) ? env.JOB_STATUS : 'unknown';
let componentsText = '- Component planning: unavailable (release may have stopped during preflight).';
let migrationText = '- Actual cloud migration ledger: not verified.';
try {
  const plan = JSON.parse(await readFile(resolve(appDirectory, 'release-report/plan.json'), 'utf8'));
  if (plan.commit === env.RELEASE_SHA) componentsText = ['frontend', 'api', 'mediaGateway', 'videoWorker'].map(name => {
    const item = plan.components?.[name];
    const action = ['deploy', 'retain', 'manual-review'].includes(item?.action) ? item.action : 'unknown';
    return `- ${name}: ${action}; expected commit ${safeSha(item?.expectedCommit)}${action === 'manual-review' ? ' (external/manual; NOT published by this workflow)' : ''}`;
  }).join('\n');
} catch { /* Preflight may have stopped before a plan was written. */ }
try {
  const before = JSON.parse(await readFile(resolve(appDirectory, 'release-report/migrations-before.json'), 'utf8'));
  const after = JSON.parse(await readFile(resolve(appDirectory, 'release-report/migrations-after.json'), 'utf8'));
  if (before.result === 'verified' && after.result === 'verified' && before.commit === env.RELEASE_SHA
    && after.commit === before.commit && before.ledgerDigest === after.ledgerDigest) migrationText = '- Actual cloud migration ledger: matched the repository before and after publication (read-only).';
} catch { /* A before-only check is deliberately not reported as final success. */ }
const text = `## Staging release: ${status}

- Source commit: ${safeSha(env.RELEASE_SHA)}
- Website: ${config.appOrigin}
- API: ${config.apiOrigin}
- Render deploy: ${safeId(env.RENDER_DEPLOY_ID)}
- Previous Render deploy: ${safeId(env.RENDER_PREVIOUS_DEPLOY_ID)}
- Previous Render commit: ${safeSha(env.RENDER_PREVIOUS_COMMIT_SHA)}
- Pages upload: ${pagesStatus}

${componentsText}
${migrationText}

Success requires the approved actual migration ledger, post-release API/CORS, planned component identities, release metadata, and asset hash checks. Retained components may intentionally have an older SHA only after a complete ancestor diff; retained frontend bytes must still match the tested artifact. A migration ledger check is not a full schema-drift or runtime-permission audit. This does not certify login, payments, email, R2 uploads, or externally deployed video components.

No migration, seed, cleanup, or automatic rollback was run. If this job failed, one platform may already have changed: inspect Render and Pages before retrying. Restore only a compatible code/artifact pair; never reset the cloud database.
`;
await mkdir(resolve(appDirectory, 'release-report'), { recursive: true });
await writeFile(resolve(appDirectory, 'release-report/summary.md'), text);
if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text);
console.log(text);
