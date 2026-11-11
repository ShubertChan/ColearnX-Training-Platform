import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import request from 'supertest';
import Stripe from 'stripe';

// The app and its restricted runtime role are real; only the external human
// verification service is replaced. Stripe signatures are generated locally.
export async function runAccessRiskChecks({ owner, app, passed }) {
  const { env } = await import('../src/config/env.ts');
  const { sourceKeys } = await import('../src/security/access-risk.ts');
  const before = { TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET };
  const guard = globalThis.fetch;
  const fp = raw => sourceKeys(raw, env.SECURITY_HASH_PEPPER).ipHash;
  const post = (path, ip, data) => request(app).post('/api/v1/auth/' + path).set('X-Forwarded-For', ip).send(data);
  const events = async (type, ip) => (await owner.query(`SELECT decision, risk_score, context_json FROM security_events
    WHERE event_type = $1 AND actor_ip_hash = $2 ORDER BY occurred_at`, [type, fp(ip)])).rows;
  const actor = randomUUID();
  const email = 'w57.member@example.test', password = randomBytes(24).toString('hex');
  await owner.query(`INSERT INTO users (user_id, full_name, email, password_hash, email_verified_at)
    VALUES ($1, 'Fixture Member', $2, $3, now())`, [actor, email, await argon2.hash(password)]);
  const proofs = new Map();
  const proof = (action, hostname = 'localhost') => {
    const value = randomUUID(); proofs.set(value, { success: true, hostname, action }); return value;
  };
  try {
    const off = await request(app).get('/api/v1/auth/human-check').expect(200);
    assert.deepEqual(off.body.data, { enabled: false, siteKey: null });
    env.TURNSTILE_SITE_KEY = 'local-public-fixture'; env.TURNSTILE_SECRET_KEY = randomBytes(24).toString('hex');
    const on = await request(app).get('/api/v1/auth/human-check').expect(200);
    assert.match(on.headers['cache-control'], /no-store/);
    assert.deepEqual(on.body.data, { enabled: true, siteKey: env.TURNSTILE_SITE_KEY });
    let offline = false;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(init.body.get('secret'), env.TURNSTILE_SECRET_KEY);
      if (offline) throw new Error('fixture verifier unavailable');
      const value = init.body.get('response'), response = proofs.get(value);
      proofs.delete(value);
      return Response.json(response ?? { success: false, 'error-codes': ['timeout-or-duplicate'] });
    };
    const separate = '192.0.2.100';
    for (const [path, action, fields] of [
      ['login', 'login', { email, password }],
      ['register', 'register', {}],
      ['forgot-password', 'forgot_password', { email: 'no-account@example.test' }],
      ['google', 'login', {}], ['google', 'register', { acceptedTerms: true, ageAcknowledged: true }],
    ]) {
      const absent = await post(path, separate, fields).expect(403);
      assert.equal(absent.body.error.code, 'HUMAN_CHECK_REQUIRED');
      await post(path, separate, { ...fields, turnstileToken: proof(action === 'login' ? 'register' : 'login') }).expect(403);
    }
    const token = proof('forgot_password');
    await post('forgot-password', '192.0.2.101', { email: 'no-account@example.test', turnstileToken: token }).expect(202);
    await post('forgot-password', '192.0.2.101', { email: 'no-account@example.test', turnstileToken: token }).expect(403);
    await post('login', separate, { email, password, turnstileToken: proof('login', 'foreign.test') }).expect(403);
    offline = true;
    await post('login', separate, { email, password, turnstileToken: proof('login') }).expect(503);
    offline = false;
    assert.equal((await owner.query('SELECT 1 FROM refresh_sessions WHERE user_id = $1', [actor])).rowCount, 0);
    passed('human proofs guard login, registration, recovery and Google; wrong action/host, replay and outage never issue a session');

    const registrationIP = '192.0.2.110';
    const signup = subject => post('register', registrationIP, { displayName: 'Fixture', email: subject,
      password: 'short', passwordConfirmation: 'short', acceptedTerms: true, ageAcknowledged: true, turnstileToken: proof('register') });
    // A deliberately weak password gets rejected later: the attempt is still
    // observable, and detecting a farm need not send email or create accounts.
    for (let i = 0; i < 5; i++) assert.notEqual((await signup('Farm0@example.test')).status, 429);
    assert.equal((await events('auth.registration_burst', registrationIP)).length, 0);
    for (let i = 1; i < 7; i++) assert.notEqual((await signup('farm' + i + '@example.test')).status, 429);
    const raced = await Promise.all([7, 8, 9].map(i => signup('farm' + i + '@example.test')));
    assert.ok(raced.every(r => r.status === 429 && r.body.error.code === 'SOURCE_COOLDOWN'));
    assert.deepEqual((await events('auth.registration_burst', registrationIP)).map(x => [x.decision, x.context_json.distinctTargets]), [['challenge', 5], ['deny', 8]]);
    assert.equal((await owner.query("SELECT 1 FROM users WHERE email::text LIKE 'farm%@example.test'")).rowCount, 0);
    passed('concurrent registrations count distinct targets, enforce one source cooldown, and do not create blocked accounts');

    const spray = '198.51.100.31';
    const tryLogin = (ip, subject, pass) => post('login', ip, { email: subject, password: pass, turnstileToken: proof('login') });
    for (let i = 0; i < 7; i++) await tryLogin(spray, i ? 'missing' + i + '@example.test' : email, 'wrong').expect(401);
    const last = await tryLogin(spray, 'missing7@example.test', 'wrong').expect(429);
    assert.ok(Number(last.headers['retry-after']) > 0);
    await tryLogin(spray, email, password).expect(429);
    assert.deepEqual((await events('auth.credential_stuffing', spray)).map(r => r.decision), ['challenge', 'deny']);
    const seen = await events('auth.login_failed', spray);
    assert.equal(new Set(seen.map(e => e.context_json.subject)).size, 8);
    assert.doesNotMatch(JSON.stringify(seen), /@example\.test|198\.51\.100\.31/);
    assert.equal((await owner.query('SELECT 1 FROM auth_failure_counters WHERE user_id=$1 AND locked_until > now()', [actor])).rowCount, 0);
    await tryLogin('203.0.113.4', email, password).expect(200);
    await owner.query("UPDATE security_events SET occurred_at=occurred_at-interval '11 minutes' WHERE actor_ip_hash=$1", [fp(spray)]);
    await tryLogin(spray, 'stale-window@example.test', 'wrong').expect(401);
    passed('a real and seven unknown targets share the spray threshold; another source can sign in, and cooldown expires');

    const changes = () => owner.query("SELECT decision FROM security_events WHERE actor_user_id=$1 AND event_type='auth.login_network_changed'", [actor]);
    await tryLogin('203.0.113.88', email, password).expect(200);
    assert.equal((await changes()).rowCount, 0);
    await tryLogin('192.0.2.45', email, password).expect(200);
    await tryLogin('203.0.113.89', email, password).expect(200);
    assert.deepEqual((await changes()).rows, [{ decision: 'allow' }]);
    await owner.query("UPDATE security_events SET occurred_at=occurred_at-interval '16 minutes' WHERE actor_user_id=$1 AND event_type IN ('auth.login_succeeded','auth.login_network_changed')", [actor]);
    await tryLogin('192.0.2.46', email, password).expect(200);
    assert.equal((await changes()).rowCount, 1);
    const keys = address => sourceKeys(address, env.SECURITY_HASH_PEPPER);
    assert.deepEqual(keys('::ffff:192.0.2.46'), keys('192.0.2.46'));
    assert.deepEqual(keys('2001:db8:4:5::a'), keys('2001:0db8:4:5:ffff::'));
    assert.notEqual(keys('2001:db8:4:5::a').network, keys('2001:db8:4:6::a').network);
    passed('only recent completed logins changing network alert; same subnet, stale baselines and repeat notifications are suppressed');
    env.TURNSTILE_SITE_KEY = ''; env.TURNSTILE_SECRET_KEY = ''; globalThis.fetch = guard;
    const unconfigured = '198.51.100.32';
    for (let i = 0; i < 8; i++) {
      await post('login', unconfigured, { email: 'unconfigured' + i + '@example.test', password: 'wrong' }).expect(i < 7 ? 401 : 429);
    }
    assert.deepEqual((await events('auth.credential_stuffing', unconfigured)).map(r => r.decision), ['allow', 'deny']);
    passed('without Cloudflare keys W7 still flags and denies abusive sources without making provider calls');
    await checkTopups(owner, app, env, actor);
    passed('signed test payments: only distinct credits count; bad signatures, redeliveries, stale and pending orders do not inflate the balance or alert');
  } finally { globalThis.fetch = guard; Object.assign(env, before); }
}

async function checkTopups(owner, app, env, actor) {
  env.STRIPE_SECRET_KEY = 'sk_test_' + randomUUID(); env.STRIPE_WEBHOOK_SECRET = randomBytes(24).toString('hex');
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const account = (await owner.query('INSERT INTO point_accounts (user_id) VALUES ($1) RETURNING point_account_id', [actor])).rows[0].point_account_id;
  await owner.query("INSERT INTO point_accounts (account_status) SELECT 'system' WHERE NOT EXISTS (SELECT 1 FROM point_accounts WHERE account_status='system')");
  const channel = (await owner.query(`INSERT INTO payment_channels (channel_code, channel_type, provider_code, display_name)
    VALUES ('w57-fixture','card','stripe','Fixture') RETURNING payment_channel_id`)).rows[0].payment_channel_id;
  const createOrder = async () => {
    const order = (await owner.query(`INSERT INTO point_topup_orders (point_account_id,points_amount,fiat_amount,currency_code,topup_no)
      VALUES ($1,10,100,'usd',$2) RETURNING topup_order_id`, [account, randomUUID()])).rows[0].topup_order_id;
    const session = 'cs_fixture_' + randomUUID();
    const payment = (await owner.query(`INSERT INTO payment_transactions
      (topup_order_id,payment_channel_id,amount,currency_code,provider_transaction_id,idempotency_key)
      VALUES ($1,$2,100,'usd',$3,$4) RETURNING payment_transaction_id`, [order, channel, session, randomUUID()])).rows[0].payment_transaction_id;
    return { id: session, mode: 'payment', payment_status: 'paid', amount_total: 100, currency: 'usd',
      metadata: { topUpOrderId: order, paymentTransactionId: payment, userId: actor } };
  };
  const send = (session, eventId = randomUUID(), valid = true) => {
    const payload = JSON.stringify({ id: eventId, type: 'checkout.session.completed', livemode: false, data: { object: session } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: valid ? env.STRIPE_WEBHOOK_SECRET : 'wrong-fixture' });
    return request(app).post('/api/v1/payments/stripe/webhook').set('Content-Type', 'application/json').set('stripe-signature', header).send(payload);
  };
  const findings = async () => (await owner.query("SELECT decision,context_json FROM security_events WHERE actor_user_id=$1 AND event_type='finance.topup_velocity'", [actor])).rows;
  const aged = await createOrder(); await send(aged).expect(200);
  await owner.query("UPDATE point_topup_orders SET credited_at=now()-interval '11 minutes' WHERE topup_order_id=$1", [aged.metadata.topUpOrderId]);
  const orders = await Promise.all(Array.from({ length: 7 }, createOrder));
  await send(orders[0], randomUUID(), false).expect(400);
  const eventId = randomUUID();
  await send(orders[0], eventId).expect(200); await send(orders[0], eventId).expect(200); await send(orders[0]).expect(200);
  for (const item of orders.slice(1, 4)) await send(item).expect(200);
  assert.equal((await findings()).length, 0);
  await Promise.all(orders.slice(4, 6).map(session => send(session).expect(200)));
  assert.deepEqual(await findings(), [{ decision: 'allow', context_json: { creditedOrders: 5, windowMinutes: 10 } }]);
  assert.equal((await owner.query('SELECT available_balance FROM point_accounts WHERE point_account_id=$1', [account])).rows[0].available_balance, '70');
  // An unavailable audit sink must not roll back the next real credit.
  await owner.query("UPDATE security_events SET occurred_at=occurred_at-interval '11 minutes' WHERE actor_user_id=$1 AND event_type='finance.topup_velocity'", [actor]);
  await owner.query(`CREATE FUNCTION fixture_w57_reject_finding() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'test-only sink failure'; END $$;
    CREATE TRIGGER fixture_w57_reject_finding BEFORE INSERT ON security_events
      FOR EACH ROW WHEN (NEW.event_type='finance.topup_velocity') EXECUTE FUNCTION fixture_w57_reject_finding()`);
  try {
    await send(orders[6]).expect(200);
    assert.equal((await owner.query('SELECT available_balance FROM point_accounts WHERE point_account_id=$1', [account])).rows[0].available_balance, '80');
    assert.equal((await findings()).length, 1);
  } finally {
    await owner.query('DROP TRIGGER fixture_w57_reject_finding ON security_events; DROP FUNCTION fixture_w57_reject_finding()');
  }
}
