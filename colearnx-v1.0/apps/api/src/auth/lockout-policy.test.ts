import assert from 'node:assert/strict';
import test from 'node:test';
import { describeLockDuration, lockDurationSeconds, lockoutAlertThreshold, lockoutLadder } from './lockout-policy.js';

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

test('lock durations are described in units a person reads, not seconds', () => {
  // The email says "about 15 minutes", never a timestamp: by the time it is
  // read the remaining time has changed, and a stale countdown is worse than
  // none.
  assert.equal(describeLockDuration(60), '1 minute');
  assert.equal(describeLockDuration(5 * 60), '5 minutes');
  assert.equal(describeLockDuration(15 * 60), '15 minutes');
  assert.equal(describeLockDuration(60 * 60), '1 hour');
  assert.equal(describeLockDuration(6 * 60 * 60), '6 hours');
});

test('every ladder step has a readable description', () => {
  // Guards against a future step landing on a boundary that renders as
  // something like "90 minutes" instead of "2 hours".
  for (const step of lockoutLadder) {
    assert.match(describeLockDuration(step.lockSeconds), /^\d+ (seconds|minute|minutes|hour|hours)$/);
  }
});

test('a non-positive duration never renders as a number', () => {
  assert.equal(describeLockDuration(0), 'a short time');
  assert.equal(describeLockDuration(-5), 'a short time');
});
