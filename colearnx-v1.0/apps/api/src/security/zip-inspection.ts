// W8 (threat model F-09 / F-09b): structural inspection of zip containers.
//
// Course materials accept .zip and .docx, and a .docx is a zip. Three things
// can go wrong with an archive that a file-header check cannot see:
//
//   1. Decompression bomb (F-09b): a few hundred kilobytes that inflate to
//      gigabytes and exhaust the disk or memory of whoever extracts it -- the
//      learner's machine, or our own malware scanner.
//   2. Smuggled executables: a perfectly valid zip whose payload is setup.exe.
//   3. A .docx that is not a Word document, or one carrying a VBA macro
//      project (a real .docx cannot contain macros; that is what .docm is for).
//
// The central directory is attacker-written, so its declared sizes are only a
// cheap first filter. The authoritative check actually INFLATES every entry
// through a streaming counter and aborts the moment the real output exceeds
// what was declared or the total budget -- so neither a lying header nor the
// "overlapping entries" non-recursive bomb gets past it, and memory use stays
// bounded because inflated bytes are counted and dropped, never kept.
//
// Pure apart from zlib: no storage, no database, no environment.

import { createInflateRaw } from 'node:zlib';
import { SNIFF_BYTES, sniffFileType } from './file-signature.js';

export type ZipLimits = {
  maxEntries: number;
  // Sum of the real inflated sizes of every entry.
  maxTotalUncompressedBytes: number;
  // Overall inflated/archive ratio. Only applied once the inflated total is
  // above ratioFloorBytes: a 2 KB text file legitimately compresses 50:1.
  maxCompressionRatio: number;
  ratioFloorBytes: number;
};

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioFloorBytes: 10 * 1024 * 1024,
};

export type ZipRejection =
  | 'malformed'
  | 'zip64_unsupported'
  | 'too_many_entries'
  | 'encrypted'
  | 'unsupported_compression'
  | 'path_traversal'
  | 'size_mismatch'
  | 'too_large_uncompressed'
  | 'compression_ratio'
  | 'executable_entry'
  | 'docx_structure'
  | 'docx_macro';

export type ZipVerdict =
  | { ok: true; entries: number; totalUncompressedBytes: number }
  | { ok: false; reason: ZipRejection; detail: string };

// Windows will run these on a double-click from an extracted folder. Scripts
// used in programming courses (.sh, .py, .js, .bat) are deliberately NOT here:
// rejecting them would break legitimate material, and their content is still
// covered by the malware scan. Native binaries are caught by content, below,
// whatever their name.
const BLOCKED_ENTRY_EXTENSIONS = new Set([
  'exe', 'dll', 'scr', 'com', 'pif', 'msi', 'msp', 'hta', 'lnk', 'vbs', 'vbe', 'jse', 'wsf', 'wsh', 'cpl', 'reg',
]);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

type CentralEntry = {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const reject = (reason: ZipRejection, detail: string): ZipVerdict => ({ ok: false, reason, detail });

function findEndOfCentralDirectory(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - EOCD_SIZE - MAX_COMMENT);
  for (let offset = archive.length - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) === SIG_EOCD) return offset;
  }
  return -1;
}

function unsafePath(name: string) {
  const normalised = name.replaceAll('\\', '/');
  return normalised.startsWith('/')
    || /^[a-z]:/i.test(normalised)
    || normalised.split('/').some((segment) => segment === '..')
    || name.includes('\u0000');
}

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

type InflateOutcome = { length: number; exceeded: boolean; head: Buffer };

/**
 * Inflates `data` and counts the output without keeping it. Stops as soon as
 * the output passes `limit` bytes, so a bomb costs at most `limit` bytes of
 * CPU work, never its full expansion.
 */
function countInflated(data: Buffer, limit: number): Promise<InflateOutcome> {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    let length = 0;
    let settled = false;
    const headParts: Buffer[] = [];
    let headLength = 0;
    const head = () => Buffer.concat(headParts).subarray(0, SNIFF_BYTES);
    inflater.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (headLength < SNIFF_BYTES) { headParts.push(chunk); headLength += chunk.length; }
      length += chunk.length;
      if (length > limit) {
        settled = true;
        inflater.destroy();
        resolve({ length, exceeded: true, head: head() });
      }
    });
    inflater.on('end', () => { if (!settled) { settled = true; resolve({ length, exceeded: false, head: head() }); } });
    inflater.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    inflater.end(data);
  });
}

function readCentralDirectory(archive: Buffer, limits: ZipLimits): CentralEntry[] | ZipVerdict {
  if (archive.length < EOCD_SIZE) return reject('malformed', 'archive is shorter than an end-of-central-directory record');
  const eocd = findEndOfCentralDirectory(archive);
  if (eocd < 0) return reject('malformed', 'no end-of-central-directory record');
  const commentLength = archive.readUInt16LE(eocd + 20);
  // Bytes appended after the archive are how zip/other-format polyglots are
  // built; a well-formed upload ends exactly at the comment.
  if (eocd + EOCD_SIZE + commentLength !== archive.length) return reject('malformed', 'trailing data after the archive');
  if (eocd >= 20 && archive.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
    return reject('zip64_unsupported', 'ZIP64 archives are not accepted');
  }
  const diskNumber = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return reject('zip64_unsupported', 'ZIP64 archives are not accepted');
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    return reject('malformed', 'multi-volume archives are not accepted');
  }
  if (totalEntries > limits.maxEntries) return reject('too_many_entries', `${totalEntries} entries exceeds ${limits.maxEntries}`);
  if (centralOffset + centralSize > eocd) return reject('malformed', 'central directory overlaps its end record');

  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || archive.readUInt32LE(cursor) !== SIG_CENTRAL) {
      return reject('malformed', `central directory entry ${index} is corrupt`);
    }
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLen = archive.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLen;
    if (end > centralOffset + centralSize) return reject('malformed', `central directory entry ${index} overruns`);
    const flags = archive.readUInt16LE(cursor + 8);
    // Bit 11 marks UTF-8 names; anything else is CP437, for which latin1 is a
    // safe stand-in for the ASCII checks made here.
    const name = archive.toString(flags & 0x0800 ? 'utf8' : 'latin1', cursor + 46, cursor + 46 + nameLength);
    entries.push({
      name,
      flags,
      method: archive.readUInt16LE(cursor + 10),
      compressedSize: archive.readUInt32LE(cursor + 20),
      uncompressedSize: archive.readUInt32LE(cursor + 24),
      localHeaderOffset: archive.readUInt32LE(cursor + 42),
    });
    cursor = end;
  }
  return entries;
}

/**
 * Inspects an in-memory zip archive. `requireDocx` additionally checks that it
 * is a macro-free Word document.
 */
export async function inspectZipArchive(
  archive: Buffer,
  options: { requireDocx?: boolean; limits?: ZipLimits } = {},
): Promise<ZipVerdict> {
  const limits = options.limits ?? DEFAULT_ZIP_LIMITS;
  const parsed = readCentralDirectory(archive, limits);
  if (!Array.isArray(parsed)) return parsed;
  const entries = parsed;
  const centralOffset = archive.readUInt32LE(findEndOfCentralDirectory(archive) + 16);

  // Cheap pre-filter on declared sizes before any inflation work.
  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localHeaderOffset === 0xffffffff) {
      return reject('zip64_unsupported', `entry ${entry.name} uses ZIP64 sizes`);
    }
    if (entry.flags & 0x0001 || entry.flags & 0x0040) return reject('encrypted', `entry ${entry.name} is encrypted and cannot be scanned`);
    if (entry.method !== 0 && entry.method !== 8) {
      return reject('unsupported_compression', `entry ${entry.name} uses compression method ${entry.method}`);
    }
    if (unsafePath(entry.name)) return reject('path_traversal', `entry name ${JSON.stringify(entry.name.slice(0, 80))} escapes the extraction folder`);
    if (BLOCKED_ENTRY_EXTENSIONS.has(extensionOf(entry.name))) return reject('executable_entry', `entry ${entry.name} is a Windows executable type`);
    declaredTotal += entry.uncompressedSize;
  }
  if (declaredTotal > limits.maxTotalUncompressedBytes) {
    return reject('too_large_uncompressed', `declared uncompressed size ${declaredTotal} exceeds ${limits.maxTotalUncompressedBytes}`);
  }

  if (options.requireDocx) {
    const names = new Set(entries.map((entry) => entry.name));
    if (entries.some((entry) => /(^|\/)vbaProject\.bin$/i.test(entry.name))) {
      return reject('docx_macro', 'document contains a VBA macro project');
    }
    if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
      return reject('docx_structure', 'archive is not a Word document');
    }
  }

  // Authoritative pass: inflate everything, trusting nothing that was declared.
  let inflatedTotal = 0;
  for (const entry of entries) {
    const local = entry.localHeaderOffset;
    if (local + 30 > centralOffset || archive.readUInt32LE(local) !== SIG_LOCAL) {
      return reject('malformed', `local header for ${entry.name} is missing`);
    }
    const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > centralOffset) return reject('malformed', `data for ${entry.name} overruns the central directory`);
    const data = archive.subarray(dataStart, dataEnd);

    const budget = limits.maxTotalUncompressedBytes - inflatedTotal;
    let outcome: InflateOutcome;
    if (entry.method === 0) {
      outcome = { length: data.length, exceeded: data.length > Math.min(entry.uncompressedSize, budget), head: data.subarray(0, SNIFF_BYTES) };
    } else {
      try {
        outcome = await countInflated(data, Math.min(entry.uncompressedSize, budget));
      } catch {
        return reject('malformed', `entry ${entry.name} does not inflate`);
      }
    }
    if (outcome.exceeded) {
      return entry.uncompressedSize <= budget
        ? reject('size_mismatch', `entry ${entry.name} inflates past its declared ${entry.uncompressedSize} bytes`)
        : reject('too_large_uncompressed', `inflated content exceeds ${limits.maxTotalUncompressedBytes} bytes`);
    }
    if (outcome.length !== entry.uncompressedSize) {
      return reject('size_mismatch', `entry ${entry.name} inflates to ${outcome.length}, declared ${entry.uncompressedSize}`);
    }
    if (outcome.length > 0) {
      const sniffed = sniffFileType(outcome.head);
      // Only native binaries are rejected by content here: a shebang script in
      // a programming course is legitimate (see BLOCKED_ENTRY_EXTENSIONS).
      if (sniffed.kind === 'executable' && sniffed.format !== 'script') {
        return reject('executable_entry', `entry ${entry.name} is a ${sniffed.format} executable`);
      }
    }
    inflatedTotal += outcome.length;
    if (inflatedTotal > limits.ratioFloorBytes && inflatedTotal / archive.length > limits.maxCompressionRatio) {
      return reject('compression_ratio', `inflates more than ${limits.maxCompressionRatio}x its archive size`);
    }
  }
  return { ok: true, entries: entries.length, totalUncompressedBytes: inflatedTotal };
}
