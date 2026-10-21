// W8 malicious-file test set (F-09 / F-09b).
//
// Every sample is BUILT AT RUNTIME, in memory, and never written to disk or
// committed as a binary. That matters twice over: the repository stays free of
// real payloads, and a developer's desktop antivirus does not quarantine
// source files out of the working tree. The EICAR string in particular is
// assembled from a reversed literal so the source file itself never contains
// the contiguous signature.

import { crc32, deflateRawSync } from 'node:zlib';

/** The industry-standard, harmless antivirus test file (68 bytes). */
export function eicarTestFile(): Buffer {
  const reversed = '*H+H$!ELIF-TSET-SURIVITNA-DRADNATS-RACIE$}7)CC7)^P(45XZP\\4[PA@%P!O5X';
  return Buffer.from([...reversed].reverse().join(''), 'latin1');
}

/** A minimal Windows PE header: "MZ" and a DOS stub, as any .exe begins. */
export function fakeWindowsExecutable(size = 512): Buffer {
  const stub = Buffer.alloc(Math.max(size, 128), 0);
  stub.write('MZ', 0, 'latin1');
  stub.write('This program cannot be run in DOS mode.', 0x4e, 'latin1');
  return stub.subarray(0, size);
}

export const minimalPdf = () => Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
export const minimalPng = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56)]);
export const minimalMp4 = () => {
  const box = Buffer.alloc(64, 0);
  box.writeUInt32BE(24, 0);
  box.write('ftypisom', 4, 'latin1');
  return box;
};

export type ZipEntrySpec = {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  // Override what the central directory claims -- how a lying header is built.
  declaredUncompressedSize?: number;
  flags?: number;
};

/**
 * Builds a zip archive byte by byte. Deliberately able to produce hostile
 * archives that real tools refuse to write: lying sizes, encrypted flags,
 * traversal names, and central-directory entries that all point at one local
 * entry (the overlapping-entries bomb).
 */
export function buildZip(entries: ZipEntrySpec[], options: { overlapCopies?: number; trailing?: Buffer } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const centralFor = (spec: ZipEntrySpec, name: Buffer, raw: Buffer, compressed: Buffer, method: number, localOffset: number) => {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE((spec.flags ?? 0) | 0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(spec.declaredUncompressedSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    return Buffer.concat([central, name]);
  };
  for (const spec of entries) {
    const name = Buffer.from(spec.name, 'utf8');
    const raw = spec.data ?? Buffer.alloc(0);
    const method = spec.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE((spec.flags ?? 0) | 0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(spec.declaredUncompressedSize ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    centrals.push(centralFor(spec, name, raw, compressed, method, offset));
    for (let copy = 1; copy <= (options.overlapCopies ?? 0); copy += 1) {
      centrals.push(centralFor({ ...spec }, Buffer.from(`${copy}-${spec.name}`, 'utf8'), raw, compressed, method, offset));
    }
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end, options.trailing ?? Buffer.alloc(0)]);
}

const contentTypes = Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
const documentXml = Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>');

export const minimalDocx = (extra: ZipEntrySpec[] = []) => buildZip([
  { name: '[Content_Types].xml', data: contentTypes },
  { name: 'word/document.xml', data: documentXml },
  ...extra,
]);
