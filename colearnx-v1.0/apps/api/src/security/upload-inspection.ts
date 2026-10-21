// W8 (threat model F-09 / F-09b): the verdict on one uploaded object.
//
// Combines the three content checks, cheapest first, and stops at the first
// failure:
//
//   1. file-signature.ts  -- do the bytes match the declared type? Is it a
//                            disguised executable?
//   2. zip-inspection.ts  -- for .zip/.docx: bomb, smuggled binaries, macro
//                            project, real Word structure.
//   3. malware-scan.ts    -- clamd, when configured.
//
// It takes its object reader and scanner as parameters and touches no storage,
// database or environment, so every branch is unit-tested with in-memory
// buffers (see upload-inspection.test.ts). storage/upload-verification.ts wires
// it to R2 and decides what a verdict does to the asset row.

import { expectedContainer, isDocx, SNIFF_BYTES, sniffFileType } from './file-signature.js';
import { ScannerUnavailableError, type MalwareScanner } from './malware-scan.js';
import type { SecurityEventType } from './taxonomy.js';
import { inspectZipArchive, type ZipLimits, type ZipRejection } from './zip-inspection.js';

export type ObjectReader = {
  // Leading bytes only -- used for large video files, which are not buffered.
  readHead(bytes: number): Promise<Buffer>;
  // The whole object. Only called for non-video types, which are capped at
  // CONTENT_UPLOAD_MAX_BYTES.
  readAll(): Promise<Buffer>;
  // The whole object as a stream, for scanning a video without buffering it.
  stream(): Promise<AsyncIterable<Buffer>>;
};

export type InspectionRejection =
  | 'type_not_allowed'
  | 'type_mismatch'
  | 'executable_disguised'
  | 'archive_rejected'
  | 'scan_inconclusive'
  | 'malware_detected';

export type InspectionVerdict =
  | { accepted: true; mediaType: string; scanned: boolean }
  | {
    accepted: false;
    reason: InspectionRejection;
    eventType: SecurityEventType;
    detail: string;
    // What the content actually is, when known (e.g. "pe", "image/png").
    detected?: string;
    archiveReason?: ZipRejection;
    signature?: string;
  };

export { ScannerUnavailableError };

const DISGUISED_EXECUTABLE_FORMATS = new Set(['pe', 'elf', 'mach-o', 'script']);

type Rejection = Extract<InspectionVerdict, { accepted: false }>;
const reject = (verdict: Omit<Rejection, 'accepted'>): Rejection => ({ accepted: false, ...verdict });

export async function inspectUpload(
  input: { declaredMediaType: string; byteSize: number },
  reader: ObjectReader,
  scanner: MalwareScanner | null,
  options: { zipLimits?: ZipLimits } = {},
): Promise<InspectionVerdict> {
  const declared = input.declaredMediaType;
  const container = expectedContainer(declared);
  if (!container) {
    return reject({ reason: 'type_not_allowed', eventType: 'upload.type_mismatch', detail: `declared type ${declared} is not accepted` });
  }

  const streamed = declared === 'video/mp4';
  const body = streamed ? undefined : await reader.readAll();
  if (body && body.length !== input.byteSize) {
    // HEAD already matched the size; a different body means the object was
    // replaced in between. Treated as a mismatch, never as accepted.
    return reject({ reason: 'type_mismatch', eventType: 'upload.type_mismatch',
      detail: `object is ${body.length} bytes, expected ${input.byteSize}` });
  }
  const head = body ? body.subarray(0, SNIFF_BYTES) : await reader.readHead(SNIFF_BYTES);

  const sniffed = sniffFileType(head);
  // Native code and interpreter scripts are an attack signal whatever they
  // were declared as. An OLE compound file (.doc/.xls/.msi) or a Java class
  // posing as an allowed type is reported as a mismatch instead: usually a
  // wrongly-saved document, and paging an operator for it would be noise.
  if (sniffed.kind === 'executable' && DISGUISED_EXECUTABLE_FORMATS.has(sniffed.format)) {
    return reject({ reason: 'executable_disguised', eventType: 'upload.executable_blocked', detected: sniffed.format,
      detail: `declared ${declared}, content is a ${sniffed.format} executable` });
  }
  if (sniffed.kind !== 'known' || sniffed.mediaType !== container) {
    const detected = sniffed.kind === 'known' ? sniffed.mediaType : sniffed.kind === 'executable' ? sniffed.format : 'unrecognised';
    return reject({ reason: 'type_mismatch', eventType: 'upload.type_mismatch', detected,
      detail: `declared ${declared}, content is ${detected}` });
  }

  if (body && container === 'application/zip') {
    const archive = await inspectZipArchive(body, { requireDocx: isDocx(declared), limits: options.zipLimits });
    if (!archive.ok) {
      return reject({
        reason: 'archive_rejected',
        eventType: archive.reason === 'executable_entry' ? 'upload.executable_blocked' : 'upload.archive_rejected',
        archiveReason: archive.reason,
        detail: archive.detail,
      });
    }
  }

  if (!scanner) return { accepted: true, mediaType: declared, scanned: false };
  const result = await scanner.scan(body ? [body] : await reader.stream());
  if (!result.clean) {
    // clamd reports policy findings under Heuristics.* -- e.g.
    // Heuristics.Limits.Exceeded (too large or deep to scan, raised because
    // clamd.conf sets AlertExceedsMax) or OLE2 macro heuristics. The file is
    // still refused (it could not be cleared), but it is not a malware
    // signature, so it is not recorded as a critical malware event.
    if (result.signature.startsWith('Heuristics.')) {
      return reject({ reason: 'scan_inconclusive', eventType: 'upload.archive_rejected', signature: result.signature,
        detail: `${scanner.name} could not clear the file: ${result.signature}` });
    }
    return reject({ reason: 'malware_detected', eventType: 'upload.malware_detected', signature: result.signature,
      detail: `${scanner.name} detected ${result.signature}` });
  }
  return { accepted: true, mediaType: declared, scanned: true };
}
