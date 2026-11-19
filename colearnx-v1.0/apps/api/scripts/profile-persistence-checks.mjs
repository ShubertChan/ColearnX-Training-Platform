import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import request from 'supertest';

export async function runProfilePersistenceChecks({ owner, app, passed }) {
  const credentials = { email: `profile-${randomUUID()}@example.test`, password: randomBytes(24).toString('hex') };
  // Accounts created before the profiles table can have only a users row.
  const account = await owner.query('INSERT INTO users (full_name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
    ['Original name', credentials.email, await argon2.hash(credentials.password)]);
  await owner.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, role_id FROM roles WHERE role_code = 'member'", [account.rows[0].user_id]);

  const browser = request.agent(app);
  const signIn = client => client.post('/api/v1/auth/login').set('X-Forwarded-For', '198.51.100.195').send(credentials).expect(200);
  const login = await signIn(browser);
  const edit = fields => browser.patch('/api/v1/me').auth(login.body.data.accessToken, { type: 'bearer' }).send(fields).expect(200);
  const read = token => request(app).get('/api/v1/me').auth(token, { type: 'bearer' }).expect(200);
  await edit({ phone: '1234', location: 'Perth' });
  assert.deepEqual((await read(login.body.data.accessToken)).body.data.profile,
    { displayName: 'Original name', phone: '1234', location: 'Perth', bio: null });

  await edit({ fullName: '  Updated name  ', location: null, bio: 'Updated bio' });
  await browser.post('/api/v1/auth/logout').set('X-CSRF-Token', login.body.data.csrfToken).expect(200);
  const freshLogin = await signIn(request(app));
  assert.deepEqual((await read(freshLogin.body.data.accessToken)).body.data.profile,
    { displayName: 'Updated name', phone: '1234', location: null, bio: 'Updated bio' });
  passed('profile edits survive logout and a fresh login, including edits to an account with no previous profile row');
}
