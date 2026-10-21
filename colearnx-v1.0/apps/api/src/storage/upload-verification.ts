// W8 (F-09): wires the content inspection to R2 and to the security ledger.
//
// Both upload paths (content assets and course attachments) complete in three
// steps, and this module is the middle one:
//
//   1. short transaction: lock the draft, HEAD the object, size check
//   2. NO transaction:    inspect the bytes (this module), promote on success
//   3. short transaction: re-lock, re-check the row is still pending, commit
//                         ready (pointing at the promoted key) or quarantined
//
// Step 2 is outside any transaction on purpose. Inspection reads up to
// CONTENT_UPLOAD_MAX_BYTES and may wait on clamd; holding a pooled database
// connection and row locks for that long would let a handful of concurrent
// uploads starve the pool for every other request.

import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';
import { recordSecurityEvent, securityContext } from '../security/events.js';
import { createClamdScanner, type MalwareScanner } from '../security/malware-scan.js';
import { inspectUpload, ScannerUnavailableError, type InspectionVerdict } from '../security/upload-inspection.js';
import { copyStoredObject, promotedObjectKey, readStoredObject, streamStoredObject } from './r2.js';

export type UploadedObject = {
  bucketName: string;
  objectKey: string;
  declaredContentType: string;
  byteSize: number;
  etag: string | undefined;
};

export type VerificationOutcome =
  | { kind: 'accepted'; objectKey: string; mediaType: string; scanned: boolean }
  | { kind: 'rejected'; verdict: Extract<InspectionVerdict, { accepted: false }> };

export type UploadVerifier = (object: UploadedObject) => Promise<VerificationOutcome>;

let scanner: MalwareScanner | null | undefined;
function configuredScanner(): MalwareScanner | null {
  if (scanner === undefined) {
    scanner = env.UPLOAD_MALWARE_SCANNER === 'clamav'
      ? createClamdScanner({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT, timeoutMs: env.CLAMAV_TIMEOUT_MS })
      : null;
  }
  return scanner;
}

/**
 * A small in-process semaphore: each inspection may buffer a whole upload, so
 * the number running at once is what bounds memory. A released slot is handed
 * DIRECTLY to the next waiter (the count is not decremented in between), so a
 * newcomer can never slip in ahead of the woken waiter and exceed the limit.
 */
export function createInspectionLimiter(limit: () => number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= limit()) await new Promise<void>((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

const withInspectionSlot = createInspectionLimiter(() => env.UPLOAD_INSPECTION_CONCURRENCY);

export const verifyUploadedObject: UploadVerifier = async (object) => {
  if (!object.etag) {
    throw new ApiError(503, 'OBJECT_STORAGE_UNAVAILABLE', 'Object storage did not identify the uploaded file.');
  }
  const etag = object.etag;
  const locator = { bucketName: object.bucketName, objectKey: object.objectKey };
  let verdict: InspectionVerdict;
  try {
    verdict = await withInspectionSlot(() => inspectUpload(
      { declaredMediaType: object.declaredContentType, byteSize: object.byteSize },
      {
        readHead: (bytes) => readStoredObject(locator, etag, bytes),
        readAll: () => readStoredObject(locator, etag),
        stream: () => streamStoredObject(locator, etag),
      },
      configuredScanner(),
    ));
  } catch (error) {
    if (error instanceof ScannerUnavailableError) {
      throw new ApiError(503, 'UPLOAD_SCAN_UNAVAILABLE',
        'The file could not be checked for malware right now. Try completing the upload again shortly.',
        { reason: error.message });
    }
    throw error;
  }
  if (!verdict.accepted) return { kind: 'rejected', verdict };
  const servedKey = promotedObjectKey(object.objectKey);
  await copyStoredObject(locator, servedKey, etag);
  return { kind: 'accepted', objectKey: servedKey, mediaType: verdict.mediaType, scanned: verdict.scanned };
};

/**
 * After step 3: removes the promoted copy unless the row now serves exactly
 * that key. Promoted keys are unique per attempt (promotedObjectKey), so this
 * never touches an object some other row points to. Best-effort: a failure
 * leaves an unreferenced object, never a broken row.
 */
export async function discardUncommittedPromotion(outcome: VerificationOutcome, bucketName: string,
  committedKey: string | null, deleteObject: (locator: { bucketName: string; objectKey: string }) => Promise<unknown>) {
  if (outcome.kind !== 'accepted' || committedKey === outcome.objectKey) return;
  await deleteObject({ bucketName, objectKey: outcome.objectKey }).catch(() => undefined);
}

/**
 * Request-path telemetry for a verification outcome. Never throws (it uses the
 * request-path recordSecurityEvent), so a ledger outage cannot turn a clean
 * rejection into a 500.
 */
export async function recordUploadRejection(req: Request, res: Response, actorUserId: string,
  details: { assetId: string; kind: 'content' | 'course'; declaredContentType: string;
    verdict: Extract<InspectionVerdict, { accepted: false }> }) {
  const { verdict } = details;
  await recordSecurityEvent(securityContext(req, res), {
    type: verdict.eventType,
    actorUserId,
    decision: 'deny',
    ruleHits: [verdict.reason, ...(verdict.archiveReason ? [verdict.archiveReason] : [])],
    context: {
      assetId: details.assetId,
      assetKind: details.kind,
      declaredType: details.declaredContentType,
      detected: verdict.detected ?? null,
      malware: verdict.signature ?? null,
      detail: verdict.detail,
    },
  }, res);
}

export async function recordScanUnavailable(req: Request, res: Response, actorUserId: string, assetId: string, kind: 'content' | 'course') {
  await recordSecurityEvent(securityContext(req, res), {
    type: 'upload.scan_unavailable', actorUserId, decision: 'challenge',
    context: { assetId, assetKind: kind, scanner: env.UPLOAD_MALWARE_SCANNER },
  }, res);
}

export const UPLOAD_REJECTED_MESSAGE = 'This file was blocked by the security check. Upload the original document in a supported format.';

export function uploadRejectedError() {
  // The specific reason goes to the security ledger, not to the client: telling
  // an attacker which check fired is a free oracle for evading it.
  return new ApiError(422, 'UPLOAD_CONTENT_REJECTED', UPLOAD_REJECTED_MESSAGE);
}
