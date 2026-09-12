import assert from 'node:assert/strict';
import test from 'node:test';
import { lockDurationSeconds, lockoutAlertThreshold, lockoutLadder } from './lockout-policy.js';

test('the first four failures cost nothing', () => {
  // A real user who mistypes must not be punished; only persistence is.
  for (let failures = 0; failures < 5; failures += 1) {
    assert.equal(lockDurationSeconds(failures), 0, `failures=${failures}`);
  }
});

test('the ladder is monotonic and never decreases', () => {
  let previous = 0;
  for (let failures = 0; failures <= 40; failures += 1) {
    const seconds = lockDurationSeconds(failures);
    assert.ok(seconds >= previous, `lock shortened at ${failures}: ${seconds} < ${previous}`);
    previous = seconds;
  }
});

test('each ladder step takes effect exactly at its threshold', () => {
  for (const step of lockoutLadder) {
    assert.equal(lockDurationSeconds(step.atFailures), step.lockSeconds);
    assert.ok(lockDurationSeconds(step.atFailures - 1) < step.lockSeconds);
  }
});

test('the ladder saturates rather than growing without bound', () => {
  // Unbounded growth would make the lock permanent in practice, which turns
  // the control into the denial-of-service primitive it is meant to avoid.
  const ceiling = lockoutLadder[lockoutLadder.length - 1].lockSeconds;
  assert.equal(lockDurationSeconds(1000), ceiling);
  assert.equal(ceiling, 6 * 60 * 60);
});

test('an attacker is held under one guess per minute once locking starts', () => {
  // The property that actually defeats stuffing: measure the best achievable
  // guess rate over a long run.
  let seconds = 0;
  const attempts = 100;
  for (let failures = 1; failures <= attempts; failures += 1) seconds += lockDurationSeconds(failures);
  const guessesPerHour = attempts / (seconds / 3600);
  assert.ok(guessesPerHour < 1, `attacker achieved ${guessesPerHour.toFixed(2)} guesses/hour`);
});

test('the alert threshold sits above the first lock', () => {
  // Alerting on the first one-minute lock would page an operator for a typo.
  assert.ok(lockoutAlertThreshold > lockoutLadder[0].atFailures);
});
