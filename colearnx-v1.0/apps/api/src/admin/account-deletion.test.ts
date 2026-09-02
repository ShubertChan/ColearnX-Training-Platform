import assert from 'node:assert/strict';
import test from 'node:test';
import { deletedAccountEmail } from './account-deletion.js';

test('deletion creates a unique non-routable replacement email', () => {
  const email = deletedAccountEmail('9f0a1b2c-3d4e-5f67-8a90-b1c2d3e4f5a6');
  assert.equal(email, 'deleted+9f0a1b2c-3d4e-5f67-8a90-b1c2d3e4f5a6@deleted.invalid');
  assert.match(email, /@deleted\.invalid$/);
});
