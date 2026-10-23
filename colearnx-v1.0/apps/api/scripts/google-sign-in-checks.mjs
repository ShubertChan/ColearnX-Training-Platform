import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { OAuth2Client } from 'google-auth-library';

// Real HTTP, signature checks and restricted-role PostgreSQL; only Google's
// certificate download is replaced with a local key. No OAuth credentials.
export async function runGoogleSignInChecks({ owner, app, passed }) {
  const { env } = await import('../src/config/env.ts');
  const oldClientId = env.GOOGLE_CLIENT_ID;
  const oldCerts = OAuth2Client.prototype.getFederatedSignonCertsAsync;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const clientId = 'local-fixture.apps.googleusercontent.com';
  let source = 0;
  const call = (path) => request(app).post(`/api/v1/auth/google${path}`).set('Origin', env.APP_ORIGIN).set('X-Forwarded-For', `198.51.100.${++source}`);
  const token = (nonce, claims = {}, signingKey = privateKey) => jwt.sign({
    sub: 'new-google-user', email: 'google-new@gmail.com', email_verified: true, name: 'Google Member', nonce,
    aud: clientId, iss: 'https://accounts.google.com', ...claims,
  }, signingKey, { algorithm: 'RS256', ...(!claims.exp ? { expiresIn: 600 } : {}), keyid: 'fixture' });
  const begin = async () => {
    const response = await call('/challenge').send({}).expect(200);
    return { nonce: response.body.data.nonce, cookie: response.headers['set-cookie'][0].split(';')[0] };
  };
  const signIn = (flow, claims = {}, consent = true) => call('').set('Cookie', flow.cookie)
    .send({ credential: token(flow.nonce, claims), ...(consent ? { acceptedTerms: true, ageAcknowledged: true } : {}) });
  const createUser = async (email, overrides = {}) => {
    const id = randomUUID();
    const passwordHash = await argon2.hash('Existing-password-for-Google-42');
    await owner.query(`INSERT INTO users (user_id, full_name, email, password_hash, email_verified_at, email_verification_required_at, account_status)
      VALUES ($1, 'Existing member', $2, $3, CASE WHEN $4 THEN now() END, CASE WHEN $5 THEN now() END, $6)`,
    [id, email, passwordHash, overrides.verified ?? true, overrides.required ?? true, overrides.status ?? 'active']);
    await owner.query('INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)', [id, 'Keep my name']);
    await owner.query('INSERT INTO point_accounts (user_id) VALUES ($1)', [id]);
    await owner.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, role_id FROM roles WHERE role_code IN ('member', 'trainer')`, [id]);
    return { id, passwordHash };
  };
  try {
    env.GOOGLE_CLIENT_ID = '';
    assert.equal((await request(app).get('/api/v1/auth/google/config').expect(200)).body.data.enabled, false);
    await call('/challenge').send({}).expect(503);
    env.GOOGLE_CLIENT_ID = clientId;
    OAuth2Client.prototype.getFederatedSignonCertsAsync = async () => ({ certs: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) } });
    await request(app).post('/api/v1/auth/google/challenge').send({}).expect(403);
    await request(app).post('/api/v1/auth/google/challenge').set('Origin', 'https://evil.example').send({}).expect(403);
    const flow = await begin();
    const consent = await signIn(flow, {}, false).expect(202);
    assert.deepEqual(consent.body.data, { registrationRequired: true });
    assert.equal((await owner.query("SELECT 1 FROM users WHERE email = 'google-new@gmail.com'")).rowCount, 0);
    const registered = await signIn(flow).expect(200);
    const userId = registered.body.data.user.id;
    assert.ok(registered.body.data.accessToken);
    assert.ok(registered.headers['set-cookie'].some((value) => value.startsWith('colearnx_refresh=')));
    assert.equal((await owner.query('SELECT 1 FROM profiles WHERE user_id = $1', [userId])).rowCount, 1);
    assert.equal((await owner.query('SELECT 1 FROM point_accounts WHERE user_id = $1', [userId])).rowCount, 1);
    assert.deepEqual(registered.body.data.user.roles, ['member']);
    await signIn(flow).expect(401);
    passed('Google is opt-in; origin is mandatory; first sign-in requires consent, creates one member/profile/wallet, and rejects replay');

    const existing = await createUser('Same.Member@Gmail.com');
    const snapshots = await owner.query('SELECT * FROM point_accounts WHERE user_id = $1', [existing.id]);
    const login = await signIn(await begin(), { sub: 'existing-google', email: 'same.member@gmail.com' }, false).expect(200);
    assert.equal(login.body.data.user.id, existing.id);
    assert.ok(login.body.data.user.roles.includes('trainer'));
    assert.equal((await owner.query('SELECT password_hash FROM users WHERE user_id = $1', [existing.id])).rows[0].password_hash, existing.passwordHash);
    assert.equal((await owner.query('SELECT display_name FROM profiles WHERE user_id = $1', [existing.id])).rows[0].display_name, 'Keep my name');
    assert.deepEqual((await owner.query('SELECT * FROM point_accounts WHERE user_id = $1', [existing.id])).rows, snapshots.rows);
    const renamed = await signIn(await begin(), { sub: 'existing-google', email: 'renamed@company.test', hd: 'company.test' }).expect(200);
    assert.equal(renamed.body.data.user.id, existing.id);
    await signIn(await begin(), { sub: 'different-subject', email: 'same.member@gmail.com' }).expect(409);
    passed('case-insensitive existing Gmail linking preserves user ID, password, profile, wallet and roles; subject survives email rename; conflicting subjects are rejected');

    const pending = await createUser('pending-google@gmail.com', { verified: false });
    await signIn(await begin(), { sub: 'pending-google', email: 'pending-google@gmail.com' }).expect(200);
    const pendingAfter = (await owner.query('SELECT password_hash, email_verified_at FROM users WHERE user_id = $1', [pending.id])).rows[0];
    assert.ok(pendingAfter.email_verified_at);
    assert.notEqual(pendingAfter.password_hash, pending.passwordHash);
    assert.equal(await argon2.verify(pendingAfter.password_hash, 'Existing-password-for-Google-42'), false);
    const legacy = await createUser('legacy-google@gmail.com', { verified: false, required: false });
    await signIn(await begin(), { sub: 'legacy-google', email: 'legacy-google@gmail.com' }).expect(200);
    assert.equal((await owner.query('SELECT password_hash FROM users WHERE user_id = $1', [legacy.id])).rows[0].password_hash, legacy.passwordHash);
    passed('pending unverified passwords are invalidated, while grandfathered legitimate passwords survive Google linking');

    for (const status of ['suspended', 'deleted']) {
      const inactive = await createUser(`${status}-google@gmail.com`, { status });
      await signIn(await begin(), { sub: `${status}-google`, email: `${status}-google@gmail.com` }).expect(403);
      assert.equal((await owner.query('SELECT 1 FROM google_identities WHERE user_id = $1', [inactive.id])).rowCount, 0);
    }
    const locked = await createUser('locked-google@gmail.com');
    await owner.query(`INSERT INTO auth_failure_counters (user_id, consecutive_failures, locked_until) VALUES ($1, 5, now() + interval '1 hour')`, [locked.id]);
    await signIn(await begin(), { sub: 'locked-google', email: 'locked-google@gmail.com' }).expect(401);
    assert.equal((await owner.query('SELECT 1 FROM refresh_sessions WHERE user_id = $1', [locked.id])).rowCount, 0);
    const mfa = await createUser('mfa-google@gmail.com');
    await owner.query(`INSERT INTO user_mfa_secrets (user_id, secret_encrypted, confirmed_at) VALUES ($1, 'not-needed-until-second-factor', now())`, [mfa.id]);
    const challenged = await signIn(await begin(), { sub: 'mfa-google', email: 'mfa-google@gmail.com' }).expect(200);
    assert.equal(challenged.body.data.mfaRequired, true);
    assert.equal(challenged.body.data.accessToken, undefined);
    assert.equal(challenged.headers['set-cookie'], undefined);
    assert.equal((await owner.query('SELECT 1 FROM refresh_sessions WHERE user_id = $1', [mfa.id])).rowCount, 0);
    passed('Google respects suspended/deleted users, lockout and enrolled MFA, with no session issued before a second factor');

    const invalidFlow = await begin();
    for (const claims of [{ aud: 'attacker-client' }, { iss: 'https://evil.example' }, { email_verified: false }, { nonce: 'x'.repeat(64) }, { exp: Math.floor(Date.now() / 1000) - 600 }]) {
      await signIn(invalidFlow, claims).expect(401);
    }
    await signIn(invalidFlow, { email: 'member@outlook.com' }).expect(403);
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await call('').set('Cookie', invalidFlow.cookie).send({ credential: token(invalidFlow.nonce, {}, otherKey) }).expect(401);
    await call('').send({ credential: token(invalidFlow.nonce) }).expect(401);
    const anotherBrowser = await begin();
    await call('').set('Cookie', anotherBrowser.cookie).send({ credential: token(invalidFlow.nonce) }).expect(401);
    await owner.query('UPDATE google_login_challenges SET expires_at = now() - interval \'1 second\'');
    await signIn(invalidFlow).expect(401);
    passed('real JWT verification rejects wrong signatures/audience/issuer, unverified email, foreign browser, wrong nonce and expired challenges');

    const concurrentFlow = await begin();
    const claims = { sub: 'concurrent-google', email: 'concurrent-google@gmail.com' };
    const raced = await Promise.all([signIn(concurrentFlow, claims), signIn(concurrentFlow, claims)]);
    assert.deepEqual(raced.map((response) => response.status).sort(), [200, 401]);
    const independent = await Promise.all([begin(), begin()]);
    const secondClaims = { sub: 'independent-google', email: 'independent-google@gmail.com' };
    const independentResponses = await Promise.all(independent.map((item) => signIn(item, secondClaims)));
    assert.deepEqual(independentResponses.map((response) => response.status), [200, 200]);
    assert.equal(independentResponses[0].body.data.user.id, independentResponses[1].body.data.user.id);
    assert.equal((await owner.query("SELECT 1 FROM users WHERE email = 'independent-google@gmail.com'")).rowCount, 1);
    passed('parallel replay produces one session; separate simultaneous Google sign-ins converge on one user');
  } finally {
    env.GOOGLE_CLIENT_ID = oldClientId;
    OAuth2Client.prototype.getFederatedSignonCertsAsync = oldCerts;
  }
}
