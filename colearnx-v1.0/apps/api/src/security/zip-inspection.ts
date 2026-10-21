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
// what was declared or the budget, verifying each entry's CRC-32 -- so a lying
// header cannot get past it, and memory stays bounded because inflated bytes
// are counted and dropped, never kept.
//
// Extractors disagree about which structure to trust: streaming extractors
// (Java's ZipInputStream, many browsers' "open zip" views) walk the LOCAL
// headers front to back, while unzip/7-Zip/Windows read the CENTRAL directory,
// and Info-ZIP honours a Unicode-path extra field over either name. A file
// that means different things to different extractors defeats any inspection
// that only reads one view. So the archive must be unambiguous: every local
// header must agree with its central entry (name bytes, method, encryption),
// the local entries must tile the file exactly from offset 0 to the central
// directory with no gaps, duplicates or hidden extra entries, and alternative
// name fields are refused outright.
//
// Pure apart from zlib: no storage, no database, no environment.

import { crc32, createInflateRaw } from 'node:zlib';
import { SNIFF_BYTES, sniffFileType } from './file-signature.js';

export type ZipLimits = {
  maxEntries: number;
  // Sum of the real inflated sizes of every entry.
  maxTotalUncompressedBytes: number;
  // One entry's real inflated size. Kept BELOW clamd's MaxFileSize (110M in
  // deploy/clamav/clamd.conf): clamd skips files over its limit, so an entry
  // larger than that would reach learners unscanned.
  maxEntryUncompressedBytes: number;
  // Overall inflated/archive ratio. Only applied once the inflated total is
  // above ratioFloorBytes: a 2 KB text file legitimately compresses 50:1.
  maxCompressionRatio: number;
  ratioFloorBytes: number;
};

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxEntryUncompressedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioFloorBytes: 10 * 1024 * 1024,
};

export type ZipRejection =
  | 'malformed'
  | 'ambiguous_structure'
  | 'zip64_unsupported'
  | 'too_many_entries'
  | 'encrypted'
  | 'unsupported_compression'
  | 'path_traversal'
  | 'unsafe_name'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'entry_too_large'
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

// Native code is rejected by content inside an archive. OLE compound files
// (.doc/.xls, embedded Office objects) and Java class files are not: they are
// ordinary course material, and the malware scan covers their content.
const NATIVE_FORMATS = new Set(['pe', 'elf', 'mach-o']);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
// Extra fields that substitute a different filename for the one checked here.
const ALTERNATIVE_NAME_FIELDS = new Set([0x7075 /* Info-ZIP Unicode Path */, 0x6375 /* Info-ZIP Unicode Comment */]);
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
// [Content_Types].xml is tiny; this only bounds what is kept for inspection.
const CONTENT_TYPES_KEEP_BYTES = 1024 * 1024;

type CentralEntry = {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  extraIds: number[];
};

const reject = (reason: ZipRejection, detail: string): ZipVerdict => ({ ok: false, reason, detail });

function findEndOfCentralDirectory(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - EOCD_SIZE - MAX_COMMENT);
  for (let offset = archive.length - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) === SIG_EOCD) return offset;
  }
  return -1;
}

/** Extra-field header ids, or null when the fields overrun their area. */
function extraFieldIds(archive: Buffer, start: number, length: number): number[] | null {
  const ids: number[] = [];
  let cursor = start;
  const end = start + length;
  while (cursor < end) {
    if (cursor + 4 > end) return null;
    const id = archive.readUInt16LE(cursor);
    const size = archive.readUInt16LE(cursor + 2);
    cursor += 4 + size;
    if (cursor > end) return null;
    ids.push(id);
  }
  return ids;
}

function unsafePath(name: string) {
  const normalised = name.replaceAll('\\', '/');
  return normalised.startsWith('/')
    || /^[a-z]:/i.test(normalised)
    || normalised.split('/').some((segment) => segment === '..')
    || name.includes('\u0000');
}

/**
 * Names Windows would silently rewrite on extraction: a trailing dot or space
 * is dropped (`evil.vbs.` becomes `evil.vbs`, slipping past the extension
 * check), and `:` addresses an NTFS alternate data stream.
 */
function unsafeName(name: string) {
  if (name.includes(':')) return true;
  return name.replaceAll('\\', '/').split('/').some((segment, index, segments) => {
    const isLastAndEmpty = index === segments.length - 1 && segment === ''; // directory entry "dir/"
    return !isLastAndEmpty && segment !== '' && /[. ]$/.test(segment);
  });
}

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

type InflateOutcome = { length: number; exceeded: boolean; head: Buffer; crc: number; kept: Buffer };

/**
 * Inflates `data` and counts the output without keeping it (beyond the first
 * `keep` bytes). Stops as soon as the output passes `limit` bytes, so a bomb
 * costs at most `limit` bytes of CPU work, never its full expansion.
 */
function countInflated(data: Buffer, limit: number, keep: number): Promise<InflateOutcome> {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    let length = 0;
    let crc = 0;
    let settled = false;
    const keptParts: Buffer[] = [];
    let keptLength = 0;
    const want = Math.max(keep, SNIFF_BYTES);
    const finish = (exceeded: boolean) => {
      settled = true;
      const kept = Buffer.concat(keptParts);
      resolve({ length, exceeded, head: kept.subarray(0, SNIFF_BYTES), crc, kept: kept.subarray(0, keep) });
    };
    inflater.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (keptLength < want) { keptParts.push(chunk.subarray(0, want - keptLength)); keptLength += Math.min(chunk.length, want - keptLength); }
      length += chunk.length;
      crc = crc32(chunk, crc);
      if (length > limit) {
        inflater.destroy();
        finish(true);
      }
    });
    inflater.on('end', () => { if (!settled) finish(false); });
    inflater.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    inflater.end(data);
  });
}

function readCentralDirectory(archive: Buffer, limits: ZipLimits): { entries: CentralEntry[]; centralOffset: number } | ZipVerdict {
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
  // The central directory must end exactly where the end record begins: no
  // bytes hidden between them.
  if (centralOffset + centralSize !== eocd) return reject('ambiguous_structure', 'central directory does not end at its end record');

  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== SIG_CENTRAL) {
      return reject('malformed', `central directory entry ${index} is corrupt`);
    }
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLen = archive.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLen;
    if (end > eocd) return reject('malformed', `central directory entry ${index} overruns`);
    const flags = archive.readUInt16LE(cursor + 8);
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const extraIds = extraFieldIds(archive, cursor + 46 + nameLength, extraLength);
    if (!extraIds) return reject('malformed', `central directory entry ${index} has corrupt extra fields`);
    // Bit 11 marks UTF-8 names; anything else is CP437, for which latin1 is a
    // safe stand-in for the ASCII checks made here.
    entries.push({
      name: nameBytes.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1'),
      nameBytes,
      flags,
      method: archive.readUInt16LE(cursor + 10),
      crc: archive.readUInt32LE(cursor + 16),
      compressedSize: archive.readUInt32LE(cursor + 20),
      uncompressedSize: archive.readUInt32LE(cursor + 24),
      localHeaderOffset: archive.readUInt32LE(cursor + 42),
      extraIds,
    });
    cursor = end;
  }
  if (cursor !== eocd) return reject('ambiguous_structure', 'central directory holds more than its declared entries');
  return { entries, centralOffset };
}

type LocatedEntry = CentralEntry & { dataStart: number; dataEnd: number; recordEnd: number };

/**
 * Checks that each local header agrees with its central entry and that the
 * local records tile [0, centralOffset) exactly -- the "one archive, one
 * meaning" rule that stops extractor-confusion tricks.
 */
function locateEntries(archive: Buffer, entries: CentralEntry[], centralOffset: number): LocatedEntry[] | ZipVerdict {
  const located: LocatedEntry[] = [];
  for (const entry of entries) {
    const local = entry.localHeaderOffset;
    if (local + 30 > centralOffset || archive.readUInt32LE(local) !== SIG_LOCAL) {
      return reject('malformed', `local header for ${entry.name} is missing`);
    }
    const localFlags = archive.readUInt16LE(local + 6);
    const localMethod = archive.readUInt16LE(local + 8);
    const nameLength = archive.readUInt16LE(local + 26);
    const extraLength = archive.readUInt16LE(local + 28);
    const localName = archive.subarray(local + 30, local + 30 + nameLength);
    if (!localName.equals(entry.nameBytes)) return reject('ambiguous_structure', `local and central names differ for ${entry.name}`);
    if (localMethod !== entry.method) return reject('ambiguous_structure', `local and central compression differ for ${entry.name}`);
    if ((localFlags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== (entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION))) {
      return reject('ambiguous_structure', `local and central encryption flags differ for ${entry.name}`);
    }
    const localExtra = extraFieldIds(archive, local + 30 + nameLength, extraLength);
    if (!localExtra) return reject('malformed', `local header for ${entry.name} has corrupt extra fields`);
    if ([...localExtra, ...entry.extraIds].some((id) => ALTERNATIVE_NAME_FIELDS.has(id))) {
      return reject('ambiguous_structure', `entry ${entry.name} carries an alternative filename field`);
    }
    const dataStart = local + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    let recordEnd = dataEnd;
    if (entry.flags & FLAG_DATA_DESCRIPTOR) {
      if (dataEnd + 4 <= centralOffset && archive.readUInt32LE(dataEnd) === SIG_DATA_DESCRIPTOR) recordEnd += 16;
      else recordEnd += 12;
    }
    if (recordEnd > centralOffset) return reject('malformed', `data for ${entry.name} overruns the central directory`);
    located.push({ ...entry, dataStart, dataEnd, recordEnd });
  }
  // Tiling: sorted by offset, each record starts exactly where the previous
  // ended, the first at 0 and the last ending at the central directory. This
  // rejects hidden local entries (seen by streaming extractors only),
  // duplicated offsets (overlapping-entry bombs) and padding between records.
  let cursor = 0;
  for (const entry of [...located].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset)) {
    if (entry.localHeaderOffset !== cursor) {
      return reject('ambiguous_structure', `unreferenced or overlapping data before ${entry.name}`);
    }
    cursor = entry.recordEnd;
  }
  if (cursor !== centralOffset) return reject('ambiguous_structure', 'unreferenced data before the central directory');
  return located;
}

const MACRO_CONTENT_TYPE = /vbaProject|macroEnabled/i;

/**
 * Inspects an in-memory zip archive. `requireDocx` additionally checks that it
 * is a macro-free Word document.
 */
export async function inspectZipArchive(
  archive: Buffer,
  options: { requireDocx?: boolean; limits?: ZipLimits } = {},
): Promise<ZipVerdict> {
  const limits = options.limits ?? DEFAULT_ZIP_LIMITS;
  const directory = readCentralDirectory(archive, limits);
  if ('ok' in directory) return directory;
  const { entries, centralOffset } = directory;

  // Cheap pre-filter on declared sizes and names before any inflation work.
  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localHeaderOffset === 0xffffffff) {
      return reject('zip64_unsupported', `entry ${entry.name} uses ZIP64 sizes`);
    }
    if (entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      return reject('encrypted', `entry ${entry.name} is encrypted and cannot be scanned`);
    }
    if (entry.method !== 0 && entry.method !== 8) {
      return reject('unsupported_compression', `entry ${entry.name} uses compression method ${entry.method}`);
    }
    if (unsafePath(entry.name)) return reject('path_traversal', `entry name ${JSON.stringify(entry.name.slice(0, 80))} escapes the extraction folder`);
    if (unsafeName(entry.name)) return reject('unsafe_name', `entry name ${JSON.stringify(entry.name.slice(0, 80))} is rewritten on extraction`);
    if (BLOCKED_ENTRY_EXTENSIONS.has(extensionOf(entry.name))) return reject('executable_entry', `entry ${entry.name} is a Windows executable type`);
    if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
      return reject('entry_too_large', `entry ${entry.name} declares ${entry.uncompressedSize} bytes`);
    }
    declaredTotal += entry.uncompressedSize;
  }
  if (declaredTotal > limits.maxTotalUncompressedBytes) {
    return reject('too_large_uncompressed', `declared uncompressed size ${declaredTotal} exceeds ${limits.maxTotalUncompressedBytes}`);
  }

  const located = locateEntries(archive, entries, centralOffset);
  if (!Array.isArray(located)) return located;

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
  for (const entry of located) {
    const data = archive.subarray(entry.dataStart, entry.dataEnd);
    const budget = Math.min(limits.maxTotalUncompressedBytes - inflatedTotal, limits.maxEntryUncompressedBytes);
    const keep = options.requireDocx && entry.name === '[Content_Types].xml' ? CONTENT_TYPES_KEEP_BYTES : 0;
    let outcome: InflateOutcome;
    if (entry.method === 0) {
      outcome = { length: data.length, exceeded: data.length > Math.min(entry.uncompressedSize, budget),
        head: data.subarray(0, SNIFF_BYTES), crc: crc32(data), kept: data.subarray(0, keep) };
    } else {
      try {
        outcome = await countInflated(data, Math.min(entry.uncompressedSize, budget), keep);
      } catch {
        return reject('malformed', `entry ${entry.name} does not inflate`);
      }
    }
    if (outcome.exceeded) {
      return entry.uncompressedSize <= budget
        ? reject('size_mismatch', `entry ${entry.name} inflates past its declared ${entry.uncompressedSize} bytes`)
        : reject('too_large_uncompressed', `inflated content exceeds the inspection budget`);
    }
    if (outcome.length !== entry.uncompressedSize) {
      return reject('size_mismatch', `entry ${entry.name} inflates to ${outcome.length}, declared ${entry.uncompressedSize}`);
    }
    if ((outcome.crc >>> 0) !== (entry.crc >>> 0)) {
      return reject('checksum_mismatch', `entry ${entry.name} fails its CRC-32`);
    }
    if (outcome.length > 0) {
      const sniffed = sniffFileType(outcome.head);
      // Only native binaries are rejected by content here: a shebang script in
      // a programming course is legitimate (see BLOCKED_ENTRY_EXTENSIONS).
      if (sniffed.kind === 'executable' && NATIVE_FORMATS.has(sniffed.format)) {
        return reject('executable_entry', `entry ${entry.name} is a ${sniffed.format} executable`);
      }
    }
    // A macro part can be stored under any name; the content-types manifest
    // is what tells Word it is there.
    if (keep && MACRO_CONTENT_TYPE.test(outcome.kept.toString('utf8'))) {
      return reject('docx_macro', 'document declares a macro-enabled content type');
    }
    inflatedTotal += outcome.length;
    if (inflatedTotal > limits.ratioFloorBytes && inflatedTotal / archive.length > limits.maxCompressionRatio) {
      return reject('compression_ratio', `inflates more than ${limits.maxCompressionRatio}x its archive size`);
    }
  }
  return { ok: true, entries: entries.length, totalUncompressedBytes: inflatedTotal };
}
