import { closeDatabase, withTransaction } from '../db/database.js';
import { deleteStoredObject } from './r2.js';
import { reconcileStorage } from './storage-reconciliation.js';

reconcileStorage({ withTransaction, deleteObject: deleteStoredObject }).then(({ removed, deferred, skipped }) => {
  process.stdout.write(`R2 reconciliation complete: removed=${removed} deferred=${deferred} skipped=${skipped}\n`);
  // A scheduler must see failed object deletion as a failure, not a successful no-op.
  if (deferred > 0) process.exitCode = 1;
}).catch(() => {
  // Provider exceptions can contain connection or object details; do not print arbitrary errors.
  process.stderr.write('R2 reconciliation failed. Inspect the protected maintenance environment.\n');
  process.exitCode = 1;
}).finally(closeDatabase);
