// W8 (F-09): inspect files that were already `ready` before W8 deployed.
//
// The completion-time inspection only protects uploads finished after it
// shipped. A file uploaded earlier -- say an executable renamed to .pdf --
// stayed `ready` and downloadable. This one-off (re-runnable) job walks every
// ready downloadable asset, runs the same inspection, and reports or
// quarantines what fails.
//
// Dry run by default: it reports and records security events but changes
// nothing, so an operator sees the blast radius before anything a learner has
// paid for disappears. `--apply` quarantines (status only: the object is kept
// for review, and quarantined assets are never served). The quarantine UPDATE
// is conditional on the row still being ready on the same key, so it cannot
// clobber a concurrent change.
//
// Takes all I/O as parameters, like the W7 jobs, so the control flow is
// unit-tested without a database or R2.

import type { InspectionVerdict } from './upload-inspection.js';

export type BackfillAsset = {
  kind: 'content' | 'course';
  id: string;
  ownerUserId: string;
  bucketName: string;
  objectKey: string;
  mediaType: string;
  byteSize: number;
};

export type BackfillDependencies = {
  // Ready assets of one kind with id > afterId, in id order.
  listReady(kind: BackfillAsset['kind'], afterId: string | null, limit: number): Promise<BackfillAsset[]>;
  inspect(asset: BackfillAsset): Promise<InspectionVerdict>;
  quarantine(asset: BackfillAsset): Promise<boolean>;
  record(asset: BackfillAsset, verdict: Extract<InspectionVerdict, { accepted: false }>, quarantined: boolean): Promise<void>;
};

export type BackfillSummary = {
  inspected: number;
  rejected: number;
  quarantined: number;
  // Assets that could not be inspected (storage or scanner unavailable,
  // object missing). They are NOT cleared; the run must be repeated.
  inspectionErrors: number;
  recordFailures: number;
  rejectedAssets: Array<{ kind: string; id: string; reason: string }>;
};

export async function runUploadBackfill(
  dependencies: BackfillDependencies,
  options: { apply: boolean; batchSize?: number; onError?: (asset: BackfillAsset, error: unknown) => void },
): Promise<BackfillSummary> {
  const batchSize = options.batchSize ?? 100;
  const summary: BackfillSummary = {
    inspected: 0, rejected: 0, quarantined: 0, inspectionErrors: 0, recordFailures: 0, rejectedAssets: [],
  };
  for (const kind of ['content', 'course'] as const) {
    let afterId: string | null = null;
    for (;;) {
      const batch = await dependencies.listReady(kind, afterId, batchSize);
      if (!batch.length) break;
      for (const asset of batch) {
        afterId = asset.id;
        let verdict: InspectionVerdict;
        try {
          verdict = await dependencies.inspect(asset);
        } catch (error) {
          summary.inspectionErrors += 1;
          options.onError?.(asset, error);
          continue;
        }
        summary.inspected += 1;
        if (verdict.accepted) continue;
        summary.rejected += 1;
        summary.rejectedAssets.push({ kind, id: asset.id, reason: verdict.reason });
        let quarantined = false;
        if (options.apply) {
          quarantined = await dependencies.quarantine(asset);
          if (quarantined) summary.quarantined += 1;
        }
        try {
          await dependencies.record(asset, verdict, quarantined);
        } catch (error) {
          summary.recordFailures += 1;
          options.onError?.(asset, error);
        }
      }
      if (batch.length < batchSize) break;
    }
  }
  return summary;
}
