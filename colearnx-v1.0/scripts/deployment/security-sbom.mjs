import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditComponents } from './security-audit.mjs';

const component = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(auditComponents, component) || !process.env.npm_execpath) {
  throw new Error('Run npm run security:sbom -- <frontend|api|video-worker|media-gateway|deployment>.');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = execFileSync(process.execPath, [process.env.npm_execpath, 'sbom', '--sbom-format=cyclonedx',
  '--package-lock-only', '--include=dev', '--ignore-scripts'], {
  cwd: resolve(root, auditComponents[component]), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const bom = JSON.parse(output);
if (bom.bomFormat !== 'CycloneDX' || !bom.components?.length || !bom.dependencies?.length) {
  throw new Error('Refusing to publish a missing or empty dependency inventory.');
}
const dir = process.env.AUDIT_REPORT_DIR || resolve(root, 'release-report/security');
await mkdir(dir, { recursive: true });
await writeFile(resolve(dir, component + '.cdx.json'), output);
console.log(component + ': ' + bom.components.length + ' CycloneDX components');
