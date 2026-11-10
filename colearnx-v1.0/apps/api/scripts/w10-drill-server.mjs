// Private subprocess for the rotation drill. No admin endpoint, deployment env file, or public listener.
import assert from 'node:assert/strict';
const url = new URL(process.env.DATABASE_URL);
assert.ok(process.send && process.env.NODE_ENV === 'development' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
  /^\/colearnx_release_check_[a-z0-9_]+$/.test(url.pathname) && url.searchParams.get('options') === '-c role=colearnx_app',
'The drill server requires the guarded local fixture');
globalThis.fetch = async () => { throw new Error('External requests are disabled'); };
const { createApp } = await import('../src/app.ts');
const { closeDatabase } = await import('../src/db/database.ts');
const server = createApp().listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.once('disconnect', () => server.close(async () => { await closeDatabase(); }));
