/** Disposable loopback TLS terminator; never contacts Neon or uses cloud credentials. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';
import { Client } from 'pg';
import { verifyCloudMigrations } from '../../../scripts/deployment/cloud-migrations.mjs';

export async function runReleaseTlsChecks({ database, host, port, role, password, inventory, sqlByFilename, passed }) {
  assert.match(database, /^colearnx_release_check_[a-z0-9_]+$/);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(host));
  const backendHost = host === '[::1]' ? '::1' : host;
  const directory = await mkdtemp(join(tmpdir(), 'colearnx-release-tls-'));
  const sockets = new Set();
  let server;
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => { /* Negative certificate tests deliberately close connections. */ });
    socket.setTimeout(10_000, () => socket.destroy());
    return socket;
  };
  try {
    const keyFile = join(directory, 'server.key');
    const certFile = join(directory, 'server.crt');
    // The generated one-day CA is trusted only by this synthetic client, never
    // installed into the OS or reused by application/cloud connections.
    execFileSync(process.env.RELEASE_CHECK_OPENSSL_BIN || 'openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
      '-keyout', keyFile, '-out', certFile,
    ], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    const certificate = await readFile(certFile);
    const secureContext = createSecureContext({ key: await readFile(keyFile), cert: certificate });
    server = createServer((socket) => {
      track(socket);
      let request = Buffer.alloc(0);
      const negotiate = (chunk) => {
        request = Buffer.concat([request, chunk]);
        if (request.length < 8) return;
        socket.removeListener('data', negotiate);
        if (request.length !== 8 || request.readInt32BE(0) !== 8 || request.readInt32BE(4) !== 80877103) {
          socket.destroy(); return;
        }
        socket.write('S'); // PostgreSQL SSLRequest acknowledgement, then StartTLS.
        const frontend = track(new TLSSocket(socket, { isServer: true, secureContext }));
        const backend = track(connect({ host: backendHost, port }));
        frontend.once('close', () => backend.destroy());
        backend.once('close', () => frontend.destroy());
        frontend.pipe(backend).pipe(frontend);
      };
      socket.on('data', negotiate);
    });
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    const proxyPort = server.address().port;
    const ssl = { ca: certificate, rejectUnauthorized: true, servername: 'localhost' };
    const config = { database, host: 'localhost', ssl };
    const verify = (clientSsl = ssl, clientPort = proxyPort, clientHost = '127.0.0.1') => verifyCloudMigrations({ config, inventory, sqlByFilename,
      commit: 'a'.repeat(40), approved: 'true', lastApplied: inventory.at(-1).filename,
      clientFactory: () => new Client({ host: clientHost, port: clientPort, database, user: role, password,
        ssl: clientSsl, connectionTimeoutMillis: 5000, query_timeout: 5000 }) });
    const report = await verify();
    assert.deepEqual(report.transport, { mode: 'verified-tls', encrypted: true, certificateAuthorized: true, backendPgStatSsl: false });
    passed('real node-postgres client verifies a TLS terminator certificate while the PostgreSQL backend reports pg_stat_ssl=false');
    await assert.rejects(verify({ rejectUnauthorized: true, servername: 'localhost' }), /could not be completed/);
    await assert.rejects(verify({ ...ssl, servername: 'wrong.fixture.invalid' }), /could not be completed/);
    await assert.rejects(verify(false, port, backendHost), /must use verified TLS/);
    passed('real untrusted-CA, wrong-hostname and plaintext connections fail closed without a cloud or migration fallback');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('colearnx-release-tls-'));
    await rm(directory, { recursive: true, force: true });
  }
}
