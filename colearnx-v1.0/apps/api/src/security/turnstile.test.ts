import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTurnstileSettings, verifyHumanToken } from './turnstile.js';

test('empty settings disable rollout; partial pairs and public test credentials in deployments are refused', () => {
  checkTurnstileSettings('', '', true);
  for (const [site, secret] of [['site', ''], ['', 'secret'], ['1x00000000000000000000AA', 'secret'], ['site', '3x0000000000000000000000000000000AA']]) {
    assert.throws(() => checkTurnstileSettings(site, secret, true));
  }
});

test('missing, wrong type and oversized proofs are rejected without contacting Cloudflare', async () => {
  for (const value of [undefined, {}, '', ' ', 'x'.repeat(2049)]) {
    await assert.rejects(verifyHumanToken(value, 'login', 'fixture', 'app.test', () => assert.fail()), { status: 403 });
  }
});

test('only a positive verdict for the exact action and frontend hostname may pass', async () => {
  const verify = (json: unknown, httpStatus = 200) => verifyHumanToken('fixture-proof', 'login', 'fixture-secret', 'app.test', async (url, init) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.deepEqual(Object.fromEntries(init?.body as URLSearchParams), { secret: 'fixture-secret', response: 'fixture-proof' });
    return Response.json(json, { status: httpStatus });
  });
  const valid = { success: true, action: 'login', hostname: 'app.test' };
  await verify(valid);
  for (const reply of [{ ...valid, action: 'register' }, { ...valid, hostname: 'app.test.attacker.test' },
    { success: false, 'error-codes': ['timeout-or-duplicate'] }]) await assert.rejects(verify(reply), { status: 403 });
  for (const reply of [null, {}, { success: 'true' }, { success: false, 'error-codes': ['invalid-input-secret'] }]) {
    await assert.rejects(verify(reply), { status: 503 });
  }
  await assert.rejects(verify(valid, 502), { status: 503 });
  await assert.rejects(verifyHumanToken('fixture', 'login', 'secret', 'app.test', async () => { throw new TypeError('offline'); }), { status: 503 });
});
