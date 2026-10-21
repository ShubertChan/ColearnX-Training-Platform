import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { createInspectionLimiter, discardUncommittedPromotion } = await import('./upload-verification.js');

test('the inspection limiter never runs more than its limit, even when a newcomer races a released slot', async () => {
  for (const limit of [1, 2]) {
    const withSlot = createInspectionLimiter(() => limit);
    let active = 0;
    let peak = 0;
    const job = async () => withSlot(async () => {
      active += 1; peak = Math.max(peak, active);
      // Yield across several microtask turns so continuations interleave.
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      active -= 1;
    });
    // Start some jobs now and more on later microtask turns, so newcomers
    // arrive exactly while slots are being handed over.
    const jobs = [job(), job(), job()];
    for (let index = 0; index < 6; index += 1) { await Promise.resolve(); jobs.push(job()); }
    await Promise.all(jobs);
    assert.equal(peak, limit);
    assert.equal(active, 0);
  }
});

test('a released slot survives a failing job', async () => {
  const withSlot = createInspectionLimiter(() => 1);
  await assert.rejects(withSlot(async () => { throw new Error('boom'); }));
  assert.equal(await withSlot(async () => 'next'), 'next');
});

test('an uncommitted promoted copy is deleted; the committed one never is', async () => {
  const deleted: string[] = [];
  const deleteObject = async ({ objectKey }: { objectKey: string }) => { deleted.push(objectKey); };
  const accepted = { kind: 'accepted' as const, objectKey: 'content/a.v-1.pdf', mediaType: 'application/pdf', scanned: false };
  await discardUncommittedPromotion(accepted, 'b', 'content/a.v-1.pdf', deleteObject);
  assert.deepEqual(deleted, []);
  await discardUncommittedPromotion(accepted, 'b', 'content/a.v-0.pdf', deleteObject); // lost a race
  await discardUncommittedPromotion(accepted, 'b', null, deleteObject); // step 3 failed
  assert.deepEqual(deleted, ['content/a.v-1.pdf', 'content/a.v-1.pdf']);
  await discardUncommittedPromotion({ kind: 'rejected', verdict: { accepted: false, reason: 'type_mismatch',
    eventType: 'upload.type_mismatch', detail: 'x' } }, 'b', null, deleteObject);
  assert.equal(deleted.length, 2);
});
