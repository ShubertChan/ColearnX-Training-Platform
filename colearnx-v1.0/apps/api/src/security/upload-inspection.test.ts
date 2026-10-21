// W8 malicious-file test set: every sample below must be stopped, and every
// legitimate sample must pass. Samples are built in memory by
// malicious-samples.test-support.ts; nothing hostile is stored in the repo.

import assert from 'node:assert/strict';
import test from 'node:test';
import { sniffFileType } from './file-signature.js';
import type { MalwareScanner } from './malware-scan.js';
import { ScannerUnavailableError } from './malware-scan.js';
import {
  buildZip,
  eicarTestFile,
  fakeWindowsExecutable,
  minimalDocx,
  minimalMp4,
  minimalPdf,
  minimalPng,
} from './malicious-samples.test-support.js';
import { inspectUpload, type ObjectReader } from './upload-inspection.js';
import { DEFAULT_ZIP_LIMITS, inspectZipArchive } from './zip-inspection.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function reader(bytes: Buffer): ObjectReader & { fullReads: () => number } {
  let fullReads = 0;
  return {
    readHead: async (count) => bytes.subarray(0, count),
    readAll: async () => { fullReads += 1; return bytes; },
    stream: async () => (async function* () { yield bytes; })(),
    fullReads: () => fullReads,
  };
}

// A stand-in for clamd that flags the EICAR test file, exactly as ClamAV does
// ("Eicar-Test-Signature"). The real protocol is covered in malware-scan.test.ts.
const fakeClam: MalwareScanner = {
  name: 'clamav',
  async scan(source) {
    const parts: Buffer[] = [];
    for await (const chunk of source) parts.push(chunk);
    return Buffer.concat(parts).includes(eicarTestFile())
      ? { clean: false, signature: 'Eicar-Test-Signature' }
      : { clean: true };
  },
};

const inspect = (declaredMediaType: string, bytes: Buffer, scanner: MalwareScanner | null = fakeClam) =>
  inspectUpload({ declaredMediaType, byteSize: bytes.length }, reader(bytes), scanner);

// --- file signatures -------------------------------------------------------

test('sniffer recognises every accepted format by its anchored signature', () => {
  assert.deepEqual(sniffFileType(minimalPdf()), { kind: 'known', mediaType: 'application/pdf' });
  assert.deepEqual(sniffFileType(minimalPng()), { kind: 'known', mediaType: 'image/png' });
  assert.deepEqual(sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), { kind: 'known', mediaType: 'image/jpeg' });
  assert.deepEqual(sniffFileType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), { kind: 'known', mediaType: 'image/webp' });
  assert.deepEqual(sniffFileType(minimalMp4()), { kind: 'known', mediaType: 'video/mp4' });
  assert.deepEqual(sniffFileType(minimalDocx()), { kind: 'known', mediaType: 'application/zip' });
});

test('sniffer reports native code and scripts as executables, and does not search past offset 0', () => {
  assert.deepEqual(sniffFileType(fakeWindowsExecutable()), { kind: 'executable', format: 'pe' });
  assert.deepEqual(sniffFileType(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])), { kind: 'executable', format: 'elf' });
  assert.deepEqual(sniffFileType(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), { kind: 'executable', format: 'mach-o' });
  assert.deepEqual(sniffFileType(Buffer.from('#!/bin/sh\nrm -rf ~\n')), { kind: 'executable', format: 'script' });
  // A PE/PDF polyglot: "%PDF" is present, but not at offset 0.
  const polyglot = Buffer.concat([fakeWindowsExecutable(64), minimalPdf()]);
  assert.equal(sniffFileType(polyglot).kind, 'executable');
  assert.deepEqual(sniffFileType(Buffer.concat([Buffer.from('   '), minimalPdf()])), { kind: 'unknown' });
  assert.deepEqual(sniffFileType(Buffer.alloc(0)), { kind: 'unknown' });
});

// --- the malicious test set ------------------------------------------------

test('F-09: an executable renamed to .pdf is blocked as a disguised executable', async () => {
  const verdict = await inspect('application/pdf', fakeWindowsExecutable());
  assert.equal(verdict.accepted, false);
  assert.ok(!verdict.accepted);
  assert.equal(verdict.reason, 'executable_disguised');
  assert.equal(verdict.eventType, 'upload.executable_blocked');
  assert.equal(verdict.detected, 'pe');
});

test('F-09: an executable disguised as an image or a video is blocked too', async () => {
  for (const declared of ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'application/zip', DOCX]) {
    const verdict = await inspect(declared, fakeWindowsExecutable());
    assert.ok(!verdict.accepted, declared);
    assert.equal(verdict.reason, 'executable_disguised', declared);
  }
});

test('F-09: content of another allowed type is still a mismatch (HTML posing as PNG, PNG posing as PDF)', async () => {
  const html = await inspect('image/png', Buffer.from('<html><script>alert(1)</script></html>'));
  assert.ok(!html.accepted);
  assert.equal(html.reason, 'type_mismatch');
  assert.equal(html.detected, 'unrecognised');
  const png = await inspect('application/pdf', minimalPng());
  assert.ok(!png.accepted);
  assert.equal(png.reason, 'type_mismatch');
  assert.equal(png.detected, 'image/png');
});

test('F-09: the EICAR test file is caught by the malware scanner, inside a PDF or inside a zip', async () => {
  const inPdf = await inspect('application/pdf', Buffer.concat([minimalPdf(), eicarTestFile()]));
  assert.ok(!inPdf.accepted);
  assert.equal(inPdf.reason, 'malware_detected');
  assert.equal(inPdf.eventType, 'upload.malware_detected');
  assert.equal(inPdf.signature, 'Eicar-Test-Signature');

  // Stored (method 0), so the signature bytes appear verbatim in the archive,
  // as they would for clamd's own archive unpacking.
  const inZip = await inspect('application/zip', buildZip([{ name: 'eicar.com.txt', data: eicarTestFile(), method: 0 }]));
  assert.ok(!inZip.accepted);
  assert.equal(inZip.reason, 'malware_detected');
});

test('F-09: an executable smuggled inside an otherwise valid zip is blocked, by name or by content', async () => {
  const byName = await inspect('application/zip', buildZip([{ name: 'lesson/setup.exe', data: Buffer.from('harmless?') }]));
  assert.ok(!byName.accepted);
  assert.equal(byName.archiveReason, 'executable_entry');
  assert.equal(byName.eventType, 'upload.executable_blocked');
  const byContent = await inspect('application/zip', buildZip([{ name: 'lesson/notes.txt', data: fakeWindowsExecutable() }]));
  assert.ok(!byContent.accepted);
  assert.equal(byContent.archiveReason, 'executable_entry');
  // Teaching scripts stay allowed: a programming course ships run.sh.
  const scripts = await inspect('application/zip', buildZip([{ name: 'lab/run.sh', data: Buffer.from('#!/bin/sh\necho hi\n') }]));
  assert.equal(scripts.accepted, true);
});

test('F-09b: a compression bomb is stopped by ratio, before it is fully inflated', async () => {
  const zeros = Buffer.alloc(20 * 1024 * 1024);
  const bomb = buildZip([{ name: 'data.bin', data: zeros }]);
  assert.ok(bomb.length < 100 * 1024, 'the sample really is a high-ratio archive');
  const verdict = await inspect('application/zip', bomb);
  assert.ok(!verdict.accepted);
  assert.equal(verdict.archiveReason, 'compression_ratio');
  assert.equal(verdict.eventType, 'upload.archive_rejected');
});

test('F-09b: an overlapping-entries bomb is stopped by the declared total and by the inflate budget', async () => {
  const payload = Buffer.alloc(4 * 1024 * 1024);
  // 200 central entries that all point at one 4 MiB local entry: 800 MiB.
  const overlapping = buildZip([{ name: 'a.bin', data: payload }], { overlapCopies: 199 });
  const declared = await inspectZipArchive(overlapping);
  assert.ok(!declared.ok);
  assert.equal(declared.reason, 'too_large_uncompressed');
  // With honest-looking (tiny) declared sizes, the real inflation catches it.
  const lying = buildZip([{ name: 'a.bin', data: payload, declaredUncompressedSize: 10 }], { overlapCopies: 199 });
  const inflated = await inspectZipArchive(lying);
  assert.ok(!inflated.ok);
  assert.equal(inflated.reason, 'size_mismatch');
});

test('F-09b: the inflate budget bounds work even when every header is consistent', async () => {
  const limits = { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 3 * 1024 * 1024, maxCompressionRatio: 1e9 };
  const random = Buffer.alloc(1024 * 1024, 7);
  const archive = buildZip([1, 2, 3, 4].map((index) => ({ name: `part${index}.bin`, data: random })));
  const verdict = await inspectZipArchive(archive, { limits });
  assert.ok(!verdict.ok);
  assert.equal(verdict.reason, 'too_large_uncompressed');
});

test('archives that cannot be safely inspected are refused', async () => {
  const cases: Array<[Buffer, string]> = [
    [buildZip([{ name: 'secret.txt', data: Buffer.from('x'), flags: 0x0001 }]), 'encrypted'],
    [buildZip([{ name: '../../.bashrc', data: Buffer.from('x') }]), 'path_traversal'],
    [buildZip([{ name: 'C:/Windows/evil.txt', data: Buffer.from('x') }]), 'path_traversal'],
    [buildZip([{ name: 'ok.txt', data: Buffer.from('x') }], { trailing: fakeWindowsExecutable(64) }), 'malformed'],
    [Buffer.from('PK\x03\x04 truncated', 'latin1'), 'malformed'],
  ];
  for (const [archive, reason] of cases) {
    const verdict = await inspectZipArchive(archive);
    assert.ok(!verdict.ok, reason);
    assert.equal(verdict.reason, reason);
  }
});

test('.docx must be a real, macro-free Word document', async () => {
  assert.equal((await inspect(DOCX, minimalDocx())).accepted, true);
  const macro = await inspect(DOCX, minimalDocx([{ name: 'word/vbaProject.bin', data: Buffer.from('macro') }]));
  assert.ok(!macro.accepted);
  assert.equal(macro.archiveReason, 'docx_macro');
  const plainZip = await inspect(DOCX, buildZip([{ name: 'readme.txt', data: Buffer.from('not word') }]));
  assert.ok(!plainZip.accepted);
  assert.equal(plainZip.archiveReason, 'docx_structure');
  // A .zip that happens to contain a document is still a valid .zip.
  assert.equal((await inspect('application/zip', minimalDocx())).accepted, true);
});

// --- legitimate files and fail-closed behaviour ----------------------------

test('legitimate uploads pass and report whether they were malware-scanned', async () => {
  assert.deepEqual(await inspect('application/pdf', minimalPdf()), { accepted: true, mediaType: 'application/pdf', scanned: true });
  assert.deepEqual(await inspect('image/png', minimalPng(), null), { accepted: true, mediaType: 'image/png', scanned: false });
  const zip = buildZip([{ name: 'week1/slides.pdf', data: minimalPdf() }, { name: 'week1/', data: Buffer.alloc(0), method: 0 }]);
  assert.equal((await inspect('application/zip', zip)).accepted, true);
});

test('video is inspected from its head and streamed to the scanner, never buffered whole', async () => {
  const video = Buffer.concat([minimalMp4(), Buffer.alloc(4096)]);
  const source = reader(video);
  const verdict = await inspectUpload({ declaredMediaType: 'video/mp4', byteSize: video.length }, source, fakeClam);
  assert.equal(verdict.accepted, true);
  assert.equal(source.fullReads(), 0);
});

test('a scanner outage propagates (fail closed) rather than accepting the file unscanned', async () => {
  const down: MalwareScanner = { name: 'clamav', scan: async () => { throw new ScannerUnavailableError('connection refused'); } };
  await assert.rejects(inspect('application/pdf', minimalPdf(), down), ScannerUnavailableError);
});

test('a body that differs in size from the HEAD-checked size is never accepted', async () => {
  const verdict = await inspectUpload({ declaredMediaType: 'application/pdf', byteSize: 9999 }, reader(minimalPdf()), fakeClam);
  assert.ok(!verdict.accepted);
  assert.equal(verdict.reason, 'type_mismatch');
});
