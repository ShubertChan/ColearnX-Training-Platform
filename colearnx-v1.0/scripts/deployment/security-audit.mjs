import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const applicationRoot = fileURLToPath(new URL('../../', import.meta.url));
export const auditComponents = Object.freeze({
  frontend: '.',
  api: 'apps/api',
  'video-worker': 'apps/video-worker',
  'media-gateway': 'apps/media-gateway',
  deployment: 'deployment',
});

// npm only retries registry requests. A vulnerability is never retried away.
export const auditArguments = Object.freeze([
  'audit', '--package-lock-only', '--include=dev', '--audit-level=high', '--json',
  '--registry=https://registry.npmjs.org', '--ignore-scripts',
  '--fetch-retries=2', '--fetch-timeout=30000',
  '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=5000',
]);

export function classifyAudit({ status, stdout, error, signal }) {
  let audit;
  try { audit = JSON.parse(stdout); } catch { /* Invalid/unavailable registry data fails closed. */ }
  const counts = audit?.metadata?.vulnerabilities;
  const validCounts = counts && ['info', 'low', 'moderate', 'high', 'critical', 'total']
    .every(level => Number.isSafeInteger(counts[level]) && counts[level] >= 0);
  if (error || signal || audit?.error || audit?.auditReportVersion !== 2 || !validCounts
    || !audit.vulnerabilities || typeof audit.vulnerabilities !== 'object' || Array.isArray(audit.vulnerabilities)) {
    // Do not publish raw error output that could include machine-local configuration.
    return { status: 'error', exitCode: 1, message: 'Audit could not be verified. Check registry availability and lockfile configuration.' };
  }
  if (counts.high > 0 || counts.critical > 0) {
    return { status: 'vulnerable', exitCode: 1, counts, audit,
      message: `Blocked: ${counts.high} high and ${counts.critical} critical vulnerabilities.` };
  }
  if (status !== 0) {
    return { status: 'error', exitCode: 1, message: 'npm audit exited unsuccessfully; the scan is not a passing result.' };
  }
  return { status: 'passed', exitCode: 0, counts, audit,
    message: `${counts.total} known vulnerabilities; no high or critical findings.` };
}

export async function auditComponent(component, { npmCli, execute = spawnSync } = {}) {
  if (!Object.hasOwn(auditComponents, component)) throw new Error('Choose a supported audit component.');
  if (!npmCli) throw new Error('Run this command through npm run security:audit.');
  const cwd = resolve(applicationRoot, auditComponents[component]);
  // Read only reviewed manifests/locks; never resolve a replacement tree or install packages.
  const lock = JSON.parse(await readFile(resolve(cwd, 'package-lock.json'), 'utf8'));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) {
    throw new Error('A supported, committed package-lock.json is required.');
  }
  let result;
  try {
    result = execute(process.execPath, [npmCli, ...auditArguments], {
      cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, shell: false,
    });
  } catch {
    result = { error: true };
  }
  return { component, directory: auditComponents[component], ...classifyAudit(result) };
}

export async function saveAuditReport(result, { reportDirectory, summaryFile, sourceSha } = {}) {
  const sha = /^[a-f0-9]{40}$/.test(sourceSha ?? '') ? sourceSha : 'local';
  const destination = resolve(reportDirectory ?? resolve(applicationRoot, 'work/security-audit'));
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, `${result.component}.json`), JSON.stringify({
    sourceSha: sha, checkedAt: new Date().toISOString(), ...result,
  }, null, 2) + '\n');
  if (summaryFile) {
    const counts = result.counts;
    await appendFile(summaryFile, [
      `### Dependency audit: ${result.component}`, '',
      `Source: \`${sha}\`; status: **${result.status}**.`, '', result.message, '',
      counts ? `Low: ${counts.low}; moderate: ${counts.moderate}; high: ${counts.high}; critical: ${counts.critical}.\n` : '',
      'Full lockfile, including development tools; no dependencies installed or business services contacted.', '',
    ].join('\n'));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--component' || !Object.hasOwn(auditComponents, args[1])) {
    throw new Error('Usage: npm run security:audit -- --component <frontend|api|video-worker|media-gateway|deployment>');
  }
  let result;
  try { result = await auditComponent(args[1], { npmCli: process.env.npm_execpath }); }
  catch { result = { component: args[1], directory: auditComponents[args[1]], status: 'error', exitCode: 1,
    message: 'Audit failed before completion. Check the committed lockfile and npm runtime.' }; }
  await saveAuditReport(result, { reportDirectory: process.env.AUDIT_REPORT_DIR,
    summaryFile: process.env.GITHUB_STEP_SUMMARY, sourceSha: process.env.GITHUB_SHA });
  console.log(`${result.component}: ${result.message}`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Dependency audit failed. No deployment was requested.');
    process.exitCode = 1;
  });
}
