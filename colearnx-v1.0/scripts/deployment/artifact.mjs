import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const appDirectory = fileURLToPath(new URL('../../', import.meta.url));
const configFile = new URL('../../deployment/staging.json', import.meta.url);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateConfig(config) {
  const fields = ['appOrigin', 'apiOrigin', 'apiBaseUrl', 'pagesProject', 'pagesBranch', 'paymentsEnabled', 'paymentProvider', 'hostedVideoEnabled', 'mediaOrigins', 'uploadOrigins'];
  if (!config || Object.keys(config).sort().join() !== fields.sort().join()) throw new Error('Unexpected staging configuration fields.');
  for (const key of ['appOrigin', 'apiOrigin']) {
    const url = new URL(config[key]);
    if (url.protocol !== 'https:' || url.origin !== config[key] || url.username || url.password) throw new Error(`${key} must be a plain HTTPS origin.`);
  }
  if (config.apiBaseUrl !== `${config.apiOrigin}/api/v1`) throw new Error('API base must match apiOrigin/api/v1.');
  if (!/^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/.test(config.pagesProject) || config.pagesBranch !== 'main') throw new Error('Invalid staging Pages target.');
  if (typeof config.paymentsEnabled !== 'boolean' || config.paymentProvider !== 'stripe') throw new Error('Invalid payment feature configuration.');
  if (typeof config.hostedVideoEnabled !== 'boolean') throw new Error('hostedVideoEnabled must be boolean.');
  for (const key of ['mediaOrigins', 'uploadOrigins']) {
    if (!Array.isArray(config[key]) || config[key].length > 10 || new Set(config[key]).size !== config[key].length) throw new Error('Invalid video origin allowlist.');
    for (const value of config[key]) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Video origins must be exact HTTPS origins.');
    }
    if (config.hostedVideoEnabled && !config[key].length) throw new Error('Enabled hosted video requires media and upload origins.');
  }
  return config;
}

export async function loadConfig() {
  return validateConfig(JSON.parse(await readFile(configFile, 'utf8')));
}

export function requireCommit(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('RELEASE_SHA must be a full lowercase Git commit SHA.');
  return commit;
}

async function artifactFiles(directory, prefix = '') {
  if (!prefix && (await lstat(directory)).isSymbolicLink()) throw new Error('Artifact directory cannot be a symlink.');
  const files = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Only static assets belong in this Pages deployment; never upload runtime code or private files.
    if (entry.isSymbolicLink() || /(^|\/)(\.|node_modules$|functions$|_worker\.js$)/.test(path)) throw new Error('Unexpected private or executable file in frontend artifact.');
    if (path === 'release.json') {
      if (!entry.isFile()) throw new Error('release.json must be a regular file.');
      continue;
    }
    if (entry.isDirectory()) files.push(...await artifactFiles(directory, path));
    else if (entry.isFile()) {
      if (!isPublicArtifactPath(path)) throw new Error('Unexpected file type in static frontend artifact.');
      files.push({ path, sha256: sha256(await readFile(resolve(directory, path))) });
    }
    else throw new Error('Unsupported frontend artifact entry.');
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export function isPublicArtifactPath(path) {
  return ['index.html', '_headers', '_redirects', 'robots.txt', 'favicon.ico'].includes(path)
    || /^assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|css|png|jpg|jpeg|gif|webp|avif|ico|svg|woff2?|ttf|otf|wasm)$/.test(path);
}

export async function migrationInventory(directory = resolve(appDirectory, 'db/migrations')) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  const result = [];
  for (const [index, name] of names.entries()) {
    if (!new RegExp(`^${String(index + 1).padStart(3, '0')}_[a-z0-9_]+\\.sql$`).test(name)) throw new Error('Migration filenames must be unique and contiguous.');
    if (!(await lstat(resolve(directory, name))).isFile()) throw new Error('Migration must be a regular file.');
    const sql = (await readFile(resolve(directory, name), 'utf8')).replace(/\r\n?/g, '\n');
    result.push({ filename: name, checksum: sha256(sql) });
  }
  if (!result.length) throw new Error('Release must declare its required migrations.');
  return result;
}

export async function createManifest(directory, config, commit) {
  validateConfig(config);
  requireCommit(commit);
  const files = await artifactFiles(directory);
  if (!files.some((file) => file.path === 'index.html') || !files.some((file) => file.path.endsWith('.js'))) throw new Error('Frontend build is missing HTML or JavaScript.');
  const assets = files.filter((file) => !['_headers', '_redirects'].includes(file.path));
  let scripts = '';
  for (const asset of assets) {
    if (!/\.(?:html|js|css|svg|txt)$/.test(asset.path)) continue;
    const content = await readFile(resolve(directory, asset.path), 'utf8');
    if (/(?:sk_(?:test|live)_[A-Za-z0-9]{16,}|postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(content)) throw new Error('Possible credential found in frontend artifact. Do not deploy.');
    if (asset.path.endsWith('.js')) scripts += content;
  }
  if (!scripts.includes(config.apiBaseUrl)) throw new Error('Canonical API address is missing from built JavaScript.');
  return { schemaVersion: 1, commit, appOrigin: config.appOrigin, apiBaseUrl: config.apiBaseUrl, paymentsEnabled: config.paymentsEnabled,
    hostedVideoEnabled: config.hostedVideoEnabled, mediaOrigins: config.mediaOrigins, uploadOrigins: config.uploadOrigins,
    requiredMigrations: await migrationInventory(), assets, files };
}

export async function verifyArtifact(directory, config, commit) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'release.json'), 'utf8'));
  const actual = await createManifest(directory, config, commit);
  if (JSON.stringify(manifest) !== JSON.stringify(actual)) throw new Error('Artifact version, configuration, or file hashes do not match. Rebuild and validate the same source.');
  return actual;
}

async function main() {
  const config = await loadConfig();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appDirectory, encoding: 'utf8' }).trim();
  const commit = requireCommit(process.env.RELEASE_SHA || head);
  if (head !== commit) throw new Error('Checked-out source does not match RELEASE_SHA.');
  const directory = resolve(appDirectory, 'dist');
  if (process.argv[2] === 'build') {
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: appDirectory, encoding: 'utf8' }).trim();
    if (dirty) throw new Error('Release builds require committed source, including untracked files.');
    const env = { ...process.env, NODE_ENV: 'production' };
    for (const key of Object.keys(env)) if (key.startsWith('VITE_')) delete env[key];
    Object.assign(env, {
      VITE_API_BASE_URL: config.apiBaseUrl,
      VITE_PAYMENTS_API_ENABLED: String(config.paymentsEnabled),
      VITE_PAYMENT_PROVIDER: config.paymentProvider,
      VITE_ENABLE_HOSTED_VIDEO: String(config.hostedVideoEnabled),
      VITE_MEDIA_ORIGINS: config.mediaOrigins.join(','),
      VITE_UPLOAD_ORIGINS: config.uploadOrigins.join(','),
    });
    execFileSync(process.execPath, [resolve(appDirectory, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: appDirectory, env, stdio: 'inherit' });
    const manifest = await createManifest(directory, config, commit);
    await writeFile(resolve(directory, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (process.argv[2] !== 'verify') throw new Error('Usage: artifact.mjs build|verify');
  await verifyArtifact(directory, config, commit);
  console.log(`Verified frontend ${commit} (${relative(appDirectory, directory).split(sep).join('/')}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Frontend artifact command failed. Check configuration, clean source, build output, and RELEASE_SHA; do not publish.'); process.exitCode = 1; });
}
