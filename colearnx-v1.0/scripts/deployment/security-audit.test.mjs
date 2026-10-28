import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { auditArguments, auditComponent, auditComponents, classifyAudit, saveAuditReport } from './security-audit.mjs';

function response(counts = {}, status = 0) {
  return { status, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...counts },
  } }) };
}

test('low/moderate findings are reported without changing the existing high-severity gate', () => {
  const clean = classifyAudit(response());
  assert.equal(clean.status, 'passed');
  assert.equal(clean.exitCode, 0);
  const advisory = classifyAudit(response({ moderate: 2, low: 1, total: 3 }));
  assert.equal(advisory.exitCode, 0);
  assert.equal(advisory.counts.total, 3);
});

test('high and critical findings fail, including an inconsistent successful npm exit', () => {
  for (const [level, status] of [['high', 1], ['critical', 1], ['high', 0]]) {
    const result = classifyAudit(response({ [level]: 1, total: 1 }, status));
    assert.equal(result.status, 'vulnerable');
    assert.equal(result.exitCode, 1);
    assert.equal(result.counts[level], 1);
  }
});

test('registry errors, malformed responses, timeouts and unexplained npm failures never pass', () => {
  const invalid = [
    { status: 1, stdout: JSON.stringify({ error: { code: 'E503', summary: 'private-fixture-value' } }) },
    { status: 0, stdout: '<html>private-fixture-value</html>' },
    { status: 0, stdout: '{}' },
    { ...response(), status: 1 },
    { ...response(), error: new Error('private-fixture-value') },
    { ...response(), signal: 'SIGTERM', status: null },
    response({ high: -1 }), response({ critical: '0' }),
  ];
  for (const value of invalid) {
    const result = classifyAudit(value);
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-value/);
  }
});

test('all five real lockfiles are scanned without install, omitted dev tools or cloud commands', async () => {
  assert.deepEqual(Object.keys(auditComponents), ['frontend', 'api', 'video-worker', 'media-gateway', 'deployment']);
  for (const component of Object.keys(auditComponents)) {
    let calls = 0;
    const result = await auditComponent(component, { npmCli: '/fixture/npm-cli.js', execute(file, args, options) {
      calls += 1;
      assert.equal(file, process.execPath);
      assert.deepEqual(args, ['/fixture/npm-cli.js', ...auditArguments]);
      assert.ok(options.cwd.endsWith(auditComponents[component].replaceAll('/', process.platform === 'win32' ? '\\' : '/'))
        || component === 'frontend');
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 120_000);
      return response();
    } });
    assert.equal(calls, 1);
    assert.equal(result.exitCode, 0);
  }
  for (const argument of ['--package-lock-only', '--include=dev', '--audit-level=high', '--json', '--ignore-scripts']) {
    assert.ok(auditArguments.includes(argument));
  }
  assert.doesNotMatch(auditArguments.join(' '), /install|\bci\b|\bfix\b|omit|production/);
});

test('unknown paths cannot be scanned and an execution error becomes a failed result', async () => {
  for (const component of ['../apps/api', '__proto__', 'constructor']) {
    await assert.rejects(auditComponent(component, { execute() { assert.fail('No execution allowed'); } }));
  }
  const result = await auditComponent('api', { npmCli: '/fixture/npm-cli.js', execute() { throw new Error('private-fixture-value'); } });
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-value/);
});

test('failed audit evidence and source SHA are saved before returning failure', async () => {
  const workDirectory = fileURLToPath(new URL('../../work/', import.meta.url));
  await mkdir(workDirectory, { recursive: true });
  const directory = await mkdtemp(join(workDirectory, 'security-audit-test-'));
  try {
    const result = { component: 'api', directory: 'apps/api', ...classifyAudit(response({ high: 1, total: 1 }, 1)) };
    const summaryFile = join(directory, 'summary.md');
    const sourceSha = 'a'.repeat(40);
    await saveAuditReport(result, { reportDirectory: directory, summaryFile, sourceSha });
    const saved = JSON.parse(await readFile(join(directory, 'api.json'), 'utf8'));
    assert.equal(saved.sourceSha, sourceSha);
    assert.equal(saved.status, 'vulnerable');
    assert.equal(saved.exitCode, 1);
    assert.equal(saved.audit.metadata.vulnerabilities.high, 1);
    assert.match(await readFile(summaryFile, 'utf8'), /\*\*vulnerable\*\*/);
  } finally {
    assert.ok(directory.startsWith(join(workDirectory, 'security-audit-test-')));
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI preserves success/failure exits and saves evidence without a real registry', async () => {
  const workDirectory = fileURLToPath(new URL('../../work/', import.meta.url));
  await mkdir(workDirectory, { recursive: true });
  const directory = await mkdtemp(join(workDirectory, 'security-audit-cli-test-'));
  try {
    const npmCli = join(directory, 'fixture-npm.mjs');
    await writeFile(npmCli, 'console.log(process.env.FIXTURE_AUDIT_JSON); process.exitCode = Number(process.env.FIXTURE_AUDIT_EXIT);\n');
    const script = fileURLToPath(new URL('./security-audit.mjs', import.meta.url));
    for (const fixture of [response(), response({ high: 1, total: 1 }, 1), { status: 1, stdout: 'registry unavailable' }]) {
      const child = spawnSync(process.execPath, [script, '--component', 'frontend'], {
        env: { ...process.env, npm_execpath: npmCli, AUDIT_REPORT_DIR: directory,
          GITHUB_STEP_SUMMARY: join(directory, 'summary.md'), GITHUB_SHA: 'b'.repeat(40),
          FIXTURE_AUDIT_JSON: fixture.stdout, FIXTURE_AUDIT_EXIT: String(fixture.status) },
        encoding: 'utf8', timeout: 10_000, windowsHide: true,
      });
      assert.equal(child.status, fixture.status);
      const report = JSON.parse(await readFile(join(directory, 'frontend.json'), 'utf8'));
      assert.equal(report.exitCode, fixture.status);
      assert.equal(report.sourceSha, 'b'.repeat(40));
    }
  } finally {
    assert.ok(directory.startsWith(join(workDirectory, 'security-audit-cli-test-')));
    await rm(directory, { recursive: true, force: true });
  }
});

test('daily workflow scans every tree, saves failures and has no deployment permissions or secrets', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/security-audit.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '37 1 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /component: \[frontend, api, video-worker, media-gateway, deployment\]/);
  assert.match(workflow, /npm run security:audit -- --component/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /secrets\.|environment:|write-all|contents: write|continue-on-error|npm (?:ci|install)|db:migrate|db:seed|deploy-staging\.yml/);
});

test('Dependabot covers all manifests and Actions without hiding security updates or enabling auto-merge', async () => {
  const config = (await readFile(new URL('../../../.github/dependabot.yml', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  for (const directory of Object.values(auditComponents)) {
    const path = directory === '.' ? '/colearnx-v1.0' : `/colearnx-v1.0/${directory}`;
    assert.ok(config.includes(`- ${path}\n`));
  }
  assert.match(config, /package-ecosystem: github-actions/);
  assert.match(config, /applies-to: security-updates/);
  assert.match(config, /timezone: Asia\/Shanghai/);
  assert.doesNotMatch(config, /\n\s+(?:ignore|target-branch|insecure-external-code-execution|auto-merge):/);
});
