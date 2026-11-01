import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { cookie, makeUser, signIn } from './w10-pentest-checks.mjs';

const me = (app, token) => request(app).get('/api/v1/me').auth(token, { type: 'bearer' });
const refresh = (app, session, origin) => request(app).post('/api/v1/auth/refresh')
  .set('Cookie', cookie(session)).set('Origin', origin).set('X-CSRF-Token', session.body.data.csrfToken).send({});

async function rotatedApi(environment) {
  const child = fork(new URL('./w10-drill-server.mjs', import.meta.url), [], {
    env: { ...environment, ACCESS_TOKEN_SECRET: randomBytes(48).toString('hex') },
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
  });
  const ended = once(child, 'exit');
  let timer;
  try {
    const [msg] = await Promise.race([once(child, 'message'), ended.then(() => { throw new Error('Fixture API stopped before readiness'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out starting rotated API')), 20000); })]);
    assert.ok(Number.isInteger(msg.port) && msg.port > 0);
    return { endpoint: 'http://127.0.0.1:' + msg.port,
      close: async () => { if (child.connected) child.disconnect(); const [code] = await ended; assert.equal(code, 0); } };
  } catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
}

export async function runW10RotationDrill({ owner, app, environment, passed }) {
  const target = new URL(environment.DATABASE_URL);
  assert.ok(environment.NODE_ENV === 'development' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    && /^\/colearnx_release_check_[a-z0-9_]+$/.test(target.pathname), 'Refusing non-fixture session revocation');
  const actual = (await owner.query('SELECT current_database() AS name, inet_server_addr()::text AS host')).rows[0];
  assert.equal(actual.name, target.pathname.slice(1));
  assert.ok(['127.0.0.1/32', '::1/128', '127.0.0.1', '::1'].includes(actual.host), 'Owner connection must also be loopback');
  const users = await Promise.all(['A', 'B'].map(s => makeUser(owner, 'Rotation fixture ' + s)));
  const trials = [];
  for (let round = 1; round <= 3; round++) {
    const sessions = await Promise.all(users.map((u, i) => signIn(app, u, '192.0.2.' + (185 + i))));
    for (const s of sessions) await me(app, s.body.data.accessToken).expect(200);
    // Detection = the simulated incident is declared with two demonstrably usable sessions.
    const started = performance.now();
    const revoked = await owner.query("UPDATE refresh_sessions SET revoked_at=now(),revoke_reason='key-rotation-drill' WHERE revoked_at IS NULL");
    assert.ok(revoked.rowCount >= 2);
    assert.equal((await owner.query('SELECT 1 FROM refresh_sessions WHERE revoked_at IS NULL')).rowCount, 0);
    const replacement = await rotatedApi(environment);
    try {
      for (const s of sessions) {
        await me(app, s.body.data.accessToken).expect(401); // still running old signer; revocation alone works
        await me(replacement.endpoint, s.body.data.accessToken).expect(401);
        await refresh(replacement.endpoint, s, environment.APP_ORIGIN).expect(401);
      }
      const fresh = await signIn(replacement.endpoint, users[0], '192.0.2.188');
      const forged = jwt.sign({ sub: users[0].id, sid: jwt.decode(fresh.body.data.accessToken).sid },
        environment.ACCESS_TOKEN_SECRET, { expiresIn: '5m' });
      // The session exists and the compromised signing key would still work on an old instance.
      await me(app, forged).expect(200);
      await me(replacement.endpoint, forged).expect(401);
      const renewed = await refresh(replacement.endpoint, fresh, environment.APP_ORIGIN).expect(200);
      await me(replacement.endpoint, renewed.body.data.accessToken).expect(200);
      trials.push({ round, revokedSessions: revoked.rowCount, recoveryMs: Math.round(performance.now() - started) });
    } finally { await replacement.close(); }
  }
  const meanRecoveryMs = Math.round(trials.reduce((sum, t) => sum + t.recoveryMs, 0) / trials.length);
  const report = { environment: 'disposable loopback PostgreSQL 16', recordedAt: new Date().toISOString(),
    clock: 'incident declared to verified old-token rejection and successful login/refresh on replacement API', trials, meanRecoveryMs };
  const dir = new URL('../../../release-report/security-w10/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('rotation.json', dir), JSON.stringify(report, null, 2) + '\n');
  passed('W10 key leak: three rotations revoke every session; old access/refresh and old-key forgery rejected; fresh login and refresh verified; mean local recovery ' + meanRecoveryMs + ' ms');
}
