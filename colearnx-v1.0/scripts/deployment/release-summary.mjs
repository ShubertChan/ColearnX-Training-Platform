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
const text = `## Staging release: ${status}

- Source commit: ${safeSha(env.RELEASE_SHA)}
- Website: ${config.appOrigin}
- API: ${config.apiOrigin}
- Render deploy: ${safeId(env.RENDER_DEPLOY_ID)}
- Previous Render deploy: ${safeId(env.RENDER_PREVIOUS_DEPLOY_ID)}
- Previous Render commit: ${safeSha(env.RENDER_PREVIOUS_COMMIT_SHA)}
- Pages upload: ${pagesStatus}

Success requires post-release API/CORS, release metadata, and asset hash checks. It does not certify login, payments, email, R2 uploads, or database migration completeness.

No migration, seed, cleanup, or automatic rollback was run. If this job failed, one platform may already have changed: inspect Render and Pages before retrying. Restore only a compatible code/artifact pair; never reset the cloud database.
`;
await mkdir(resolve(appDirectory, 'release-report'), { recursive: true });
await writeFile(resolve(appDirectory, 'release-report/summary.md'), text);
if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text);
console.log(text);
