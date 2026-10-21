// W8 (threat model F-09): identify a file by what it IS, not by what the
// uploader says it is.
//
// Before W8 the upload pipeline only compared the declared Content-Type with
// the Content-Type that R2 echoed back -- which is the same header the client
// chose when it PUT the object. An executable renamed to `notes.pdf` and sent
// with `Content-Type: application/pdf` passed every check and was handed to
// other learners as a PDF.
//
// This module is pure (no I/O, no environment): given the first bytes of an
// object it returns the format those bytes actually encode. The caller decides
// what to do with a mismatch. Only exact, anchored signatures are accepted --
// a "contains %PDF somewhere" rule would let a PE/PDF polyglot through.

export type SniffedType =
  | 'application/pdf'
  | 'application/zip'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'video/mp4';

export type SniffResult =
  | { kind: 'known'; mediaType: SniffedType }
  // Native code or a script interpreter line. Never acceptable as course
  // material, whatever it was declared as, so it is reported separately: a
  // disguised executable is an attack signal, a mislabelled PNG is not.
  | { kind: 'executable'; format: string }
  | { kind: 'unknown' };

// How many leading bytes the sniffer needs. Callers read at least this much.
export const SNIFF_BYTES = 64;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

const EXECUTABLE_SIGNATURES: ReadonlyArray<{ format: string; signature: readonly number[] }> = [
  // Windows PE / DOS MZ (.exe, .dll, .scr, .sys ...)
  { format: 'pe', signature: ascii('MZ') },
  // Linux / BSD ELF
  { format: 'elf', signature: [0x7f, 0x45, 0x4c, 0x46] },
  // Mach-O 32/64-bit, both byte orders
  { format: 'mach-o', signature: [0xfe, 0xed, 0xfa, 0xce] },
  { format: 'mach-o', signature: [0xfe, 0xed, 0xfa, 0xcf] },
  { format: 'mach-o', signature: [0xce, 0xfa, 0xed, 0xfe] },
  { format: 'mach-o', signature: [0xcf, 0xfa, 0xed, 0xfe] },
  // Mach-O universal binary (shares its magic with Java .class files; both are
  // executable code and both are rejected).
  { format: 'mach-o-universal', signature: [0xca, 0xfe, 0xba, 0xbe] },
  // OLE compound file: .msi installers and legacy macro-bearing Office files.
  { format: 'ole-compound', signature: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  // `#!/bin/sh` and friends.
  { format: 'script', signature: ascii('#!') },
];

/**
 * Pure. Classifies a file from its leading bytes.
 */
export function sniffFileType(head: Uint8Array): SniffResult {
  for (const { format, signature } of EXECUTABLE_SIGNATURES) {
    if (startsWith(head, signature)) return { kind: 'executable', format };
  }
  if (startsWith(head, ascii('%PDF-'))) return { kind: 'known', mediaType: 'application/pdf' };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'known', mediaType: 'image/png' };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'known', mediaType: 'image/jpeg' };
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return { kind: 'known', mediaType: 'image/webp' };
  // A local file header, or the end-of-central-directory record of an empty
  // archive. A spanned/split archive marker (PK\x07\x08) is not accepted.
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    return { kind: 'known', mediaType: 'application/zip' };
  }
  if (isMp4(head)) return { kind: 'known', mediaType: 'video/mp4' };
  return { kind: 'unknown' };
}

function isMp4(head: Uint8Array) {
  // ISO base media file: the first box is `ftyp`, whose 32-bit big-endian size
  // must at least cover its own header plus the major brand and minor version.
  if (!startsWith(head, ascii('ftyp'), 4)) return false;
  const boxSize = ((head[0] << 24) >>> 0) + (head[1] << 16) + (head[2] << 8) + head[3];
  return boxSize >= 16 && boxSize <= 4096;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * The container format a declared media type must sniff as. A .docx is a zip
 * archive on the wire; its Word-specific structure is checked separately by
 * zip-inspection.ts, because the first bytes cannot tell a .docx from a .zip.
 */
export function expectedContainer(declaredMediaType: string): SniffedType | undefined {
  switch (declaredMediaType) {
    case 'application/pdf': return 'application/pdf';
    case 'application/zip': return 'application/zip';
    case DOCX: return 'application/zip';
    case 'image/jpeg': return 'image/jpeg';
    case 'image/png': return 'image/png';
    case 'image/webp': return 'image/webp';
    case 'video/mp4': return 'video/mp4';
    default: return undefined;
  }
}

export const isDocx = (mediaType: string) => mediaType === DOCX;
