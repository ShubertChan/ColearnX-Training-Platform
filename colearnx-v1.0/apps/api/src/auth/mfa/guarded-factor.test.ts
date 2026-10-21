import assert from 'node:assert/strict';
import test from 'node:test';
import type { FailureOutcome, LockState } from '../lockout.js';
import type { FactorResult } from './service.js';

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { verifyFactorWithLockout } = await import('./guarded-factor.js');

function fakes({ locked = false, factor = { ok: false, reason: 'invalid' } as FactorResult } = {}) {
  const calls: string[] = [];
  let failures = 0;
  return {
    calls,
    dependencies: {
      readLockState: async (): Promise<LockState> => { calls.push('read'); return { locked, lockedUntil: locked ? new Date(Date.now() + 60_000) : null, consecutiveFailures: failures }; },
      verifySecondFactor: async () => { calls.push('verify'); return factor; },
      registerFailure: async (): Promise<FailureOutcome> => {
        calls.push('fail'); failures += 1;
        return { consecutiveFailures: failures, lockedUntil: failures >= 5 ? new Date() : null, newlyLocked: failures === 5 };
      },
      clearFailures: async () => { calls.push('clear'); },
    },
  };
}

test('a locked account is refused before the code is checked, so no TOTP step or recovery code is consumed', async () => {
  const f = fakes({ locked: true, factor: { ok: true, usedRecoveryCode: false, recoveryCodesRemaining: 10 } });
  const result = await verifyFactorWithLockout('u1', '123456', 3600, f.dependencies);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === 'locked');
  assert.deepEqual(f.calls, ['read']);
});

test('every wrong code counts toward the lockout ladder; the fifth one locks the account', async () => {
  const f = fakes();
  let last;
  for (let attempt = 1; attempt <= 5; attempt += 1) last = await verifyFactorWithLockout('u1', '000000', 3600, f.dependencies);
  assert.ok(last && !last.ok && last.reason === 'invalid');
  assert.equal(last.failure.consecutiveFailures, 5);
  assert.equal(last.failure.newlyLocked, true);
  assert.equal(f.calls.filter((call) => call === 'fail').length, 5);
});

test('a correct code clears the counter and returns the factor', async () => {
  const f = fakes({ factor: { ok: true, usedRecoveryCode: true, recoveryCodesRemaining: 9 } });
  const result = await verifyFactorWithLockout('u1', 'ABCD-EFGH', 3600, f.dependencies);
  assert.deepEqual(result, { ok: true, usedRecoveryCode: true, recoveryCodesRemaining: 9 });
  assert.deepEqual(f.calls, ['read', 'verify', 'clear']);
});
