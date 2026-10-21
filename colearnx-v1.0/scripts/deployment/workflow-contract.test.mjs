import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = (await readFile(new URL('../../../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
test('CD remains manual/main-only with approval and full reusable CI; no cloud writes in installation', () => {
  const trigger = workflow.split('\npermissions:')[0];
  assert.match(trigger, /workflow_dispatch:/);
  assert.doesNotMatch(trigger, /\n  (?:push|pull_request|workflow_run):/);
  assert.match(trigger, /migrations_reviewed:[\s\S]*default: false/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(workflow, /name: staging/);
  const install = workflow.slice(workflow.indexOf('- name: Install lockfile'), workflow.indexOf('- name: Reject a stale'));
  assert.doesNotMatch(install, /secrets\.|READONLY_URL|RENDER_API_KEY|CLOUDFLARE_API_TOKEN/);
});

test('actual read-only ledger and observed baselines precede either mutating publication', () => {
  const commands = ['cloud-migrations.mjs before', 'pages-preflight.mjs\n', 'render-deploy.mjs --inspect-only', 'release-plan.mjs',
    'run: node scripts/deployment/render-deploy.mjs\n', 'pages-deploy.mjs', 'release:smoke -- --planned', 'cloud-migrations.mjs after'];
  let previous = -1;
  for (const command of commands) {
    const index = workflow.indexOf(command);
    assert.ok(index > previous, `Required stage ordering: ${command}`);
    previous = index;
  }
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /secrets\.STAGING_DATABASE_READONLY_URL/g);
  assert.match(workflow, /vars\.STAGING_DATABASE_HOST/g);
  assert.doesNotMatch(workflow, /MIGRATION_DATABASE_URL|db:migrate|db:seed|storage:reconcile/);
});

test('component selection only skips publication; retained components still require exact identity and smoke checks', () => {
  assert.match(workflow, /if: steps\.plan\.outputs\.api_required == 'true'/);
  assert.match(workflow, /if: steps\.plan\.outputs\.frontend_required == 'true'/);
  assert.equal((workflow.match(/RELEASE_SHA: \$\{\{ steps\.plan\.outputs\.expected_api_sha \}\}/g) ?? []).length, 2);
  assert.match(workflow, /EXPECTED_RENDER_DEPLOY_ID: \$\{\{ steps\.plan\.outputs\.previous_api_deploy_id \}\}/);
  assert.match(workflow, /EXPECTED_RENDER_SHA: \$\{\{ steps\.plan\.outputs\.previous_api_sha \}\}/);
  assert.equal((workflow.match(/EXPECTED_RENDER_DEPLOY_ID: \$\{\{ steps\.render\.outputs\.render_deploy_id \|\| steps\.plan\.outputs\.previous_api_deploy_id \}\}/g) ?? []).length, 2);
  assert.match(workflow, /run: npm run release:smoke -- --api-only/);
  assert.match(workflow, /run: node scripts\/deployment\/pages-preflight\.mjs --verify-unchanged/);
});
