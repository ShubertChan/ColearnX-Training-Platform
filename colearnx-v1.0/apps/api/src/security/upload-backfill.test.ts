import assert from 'node:assert/strict';
import test from 'node:test';
import { runUploadBackfill, type BackfillAsset } from './upload-backfill.js';
import type { InspectionVerdict } from './upload-inspection.js';

const asset = (kind: 'content' | 'course', id: string): BackfillAsset => ({
  kind, id, ownerUserId: 'owner', bucketName: 'b', objectKey: `${kind}/${id}.pdf`, mediaType: 'application/pdf', byteSize: 10,
});
const clean: InspectionVerdict = { accepted: true, mediaType: 'application/pdf', scanned: true };
const bad: InspectionVerdict = { accepted: false, reason: 'executable_disguised', eventType: 'upload.executable_blocked', detail: 'pe' };

function fixture() {
  const rows = { content: ['c1', 'c2', 'c3'].map((id) => asset('content', id)), course: ['k1', 'k2'].map((id) => asset('course', id)) };
  const verdicts: Record<string, InspectionVerdict | 'error'> = { c1: clean, c2: bad, c3: 'error', k1: bad, k2: clean };
  const quarantined: string[] = [];
  const recorded: Array<{ id: string; quarantined: boolean }> = [];
  return {
    quarantined, recorded,
    dependencies: {
      listReady: async (kind: 'content' | 'course', afterId: string | null, limit: number) => {
        const list = rows[kind];
        const start = afterId ? list.findIndex((row) => row.id === afterId) + 1 : 0;
        return list.slice(start, start + limit);
      },
      inspect: async (row: BackfillAsset) => {
        const verdict = verdicts[row.id];
        if (verdict === 'error') throw new Error('scanner unavailable');
        return verdict;
      },
      quarantine: async (row: BackfillAsset) => { quarantined.push(row.id); return true; },
      record: async (row: BackfillAsset, _verdict: unknown, wasQuarantined: boolean) => { recorded.push({ id: row.id, quarantined: wasQuarantined }); },
    },
  };
}

test('dry run reports failing pre-W8 files without changing anything, and pages through every batch', async () => {
  const f = fixture();
  const summary = await runUploadBackfill(f.dependencies, { apply: false, batchSize: 2 });
  assert.equal(summary.inspected, 4);
  assert.equal(summary.rejected, 2);
  assert.equal(summary.quarantined, 0);
  assert.equal(summary.inspectionErrors, 1);
  assert.deepEqual(summary.rejectedAssets.map((row) => row.id), ['c2', 'k1']);
  assert.deepEqual(f.quarantined, []);
  assert.deepEqual(f.recorded, [{ id: 'c2', quarantined: false }, { id: 'k1', quarantined: false }]);
});

test('--apply quarantines exactly the failing files; an uninspectable file is never treated as clean', async () => {
  const f = fixture();
  const summary = await runUploadBackfill(f.dependencies, { apply: true, batchSize: 2 });
  assert.deepEqual(f.quarantined, ['c2', 'k1']);
  assert.equal(summary.quarantined, 2);
  assert.equal(summary.inspectionErrors, 1);
});
