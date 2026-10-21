import assert from 'node:assert/strict';
import test from 'node:test';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

// The storage helpers import the shared environment module. Supply only inert
// local test values; this test never connects to PostgreSQL or R2.
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
process.env.OBJECT_STORAGE_PROVIDER = 'r2';
process.env.R2_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.R2_BUCKET_NAME = 'test-bucket';

const { ApiError } = await import('../lib/http.js');
const { contentTypeMatches, createContentObjectKey, findStoredObject, headUploadedObject, promotedObjectKey, safeContentDisposition, validateUploadMetadata } = await import('./r2.js');

test('normalizes the Windows ZIP MIME type and requires a matching extension', () => {
  const metadata = validateUploadMetadata({ filename: 'lesson.ZIP', mediaType: 'application/x-zip-compressed', sizeBytes: 1024 });
  assert.equal(metadata.mediaType, 'application/zip');
  const document = validateUploadMetadata({ filename: 'guide.DOCX', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 1024 });
  assert.equal(document.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.throws(() => validateUploadMetadata({ filename: 'lesson.exe', mediaType: 'application/pdf', sizeBytes: 1024 }), (error: unknown) => {
    return error instanceof ApiError && error.status === 415 && error.code === 'CONTENT_FILE_TYPE_NOT_ALLOWED';
  });
});

test('rejects unsafe names and applies the document and MP4 size limits', () => {
  assert.throws(() => validateUploadMetadata({ filename: '../notes.pdf', mediaType: 'application/pdf', sizeBytes: 1024 }), ApiError);
  assert.throws(() => validateUploadMetadata({ filename: 'notes.pdf', mediaType: 'application/pdf', sizeBytes: 26214401 }), (error: unknown) => {
    return error instanceof ApiError && error.status === 413 && error.code === 'CONTENT_FILE_TOO_LARGE';
  });
  assert.equal(validateUploadMetadata({ filename: 'lesson.mp4', mediaType: 'video/mp4', sizeBytes: 104857600 }).sizeBytes, 104857600);
  assert.throws(() => validateUploadMetadata({ filename: 'huge-lesson.mp4', mediaType: 'video/mp4', sizeBytes: 104857601 }), (error: unknown) => {
    return error instanceof ApiError && error.status === 413 && error.code === 'CONTENT_FILE_TOO_LARGE';
  });
});

test('uses server-generated keys and safe signed-response metadata', () => {
  const key = createContentObjectKey('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'notes.pdf');
  // W8: browsers upload under incoming/; only inspected files are promoted to
  // the served key, which the still-valid PUT URL can no longer overwrite.
  assert.match(key, /^incoming\/content\/11111111-1111-4111-8111-111111111111\/22222222-2222-4222-8222-222222222222\/[0-9a-f-]+\.pdf$/);
  const promoted = promotedObjectKey(key, 'n1');
  assert.equal(promoted, key.slice('incoming/'.length).replace(/\.pdf$/, '.v-n1.pdf'));
  assert.ok(!promoted.startsWith('incoming/'));
  assert.equal(promotedObjectKey('content/a/b/legacy.pdf', 'n2'), 'content/a/b/legacy.v-n2.pdf');
  // Every attempt gets its own key, so a losing attempt can delete its copy safely.
  assert.notEqual(promotedObjectKey(key), promotedObjectKey(key));
  assert.equal(contentTypeMatches('application/zip', 'application/x-zip-compressed; charset=binary'), true);
  assert.equal(safeContentDisposition('notes.pdf', 'attachment'), "attachment; filename=\"download\"; filename*=UTF-8''notes.pdf");
});

test('storage inspection distinguishes a confirmed missing file from an uncertain failure', async (t) => {
  const locator = { bucketName: 'test-bucket', objectKey: 'test/lesson.mp4' };
  const send = t.mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    assert.ok(command instanceof HeadObjectCommand);
    assert.equal(command.input.Bucket, locator.bucketName);
    assert.equal(command.input.Key, locator.objectKey);
    throw { $metadata: { httpStatusCode: 404 } };
  });
  assert.equal(await findStoredObject(locator), null);
  await assert.rejects(headUploadedObject(locator), { status: 409, code: 'UPLOAD_OBJECT_NOT_FOUND' });
  for (const error of [{ $metadata: { httpStatusCode: 403 } }, { $metadata: { httpStatusCode: 500 } }, new Error('Network interrupted')]) {
    send.mock.mockImplementation(async () => { throw error; });
    await assert.rejects(findStoredObject(locator), { status: 503, code: 'OBJECT_STORAGE_UNAVAILABLE' });
  }
  send.mock.mockImplementation(async () => ({ ContentType: 'video/mp4', ContentLength: 100, ETag: '"test-etag"' }));
  assert.deepEqual(await headUploadedObject(locator), { contentType: 'video/mp4', contentLength: 100, etag: 'test-etag' });
});

test('W8: inspection reads and promotion copies are pinned to the HEAD-checked ETag', async (t) => {
  const { CopyObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { copyStoredObject, readStoredObject } = await import('./r2.js');
  const locator = { bucketName: 'test-bucket', objectKey: 'incoming/content/u/v/file name.pdf' };
  const commands: unknown[] = [];
  const send = t.mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    commands.push(command);
    return { Body: { transformToByteArray: async () => new Uint8Array([0x25, 0x50]) } };
  });
  assert.deepEqual([...await readStoredObject(locator, 'etag-1', 64)], [0x25, 0x50]);
  const read = commands[0] as InstanceType<typeof GetObjectCommand>;
  assert.ok(read instanceof GetObjectCommand);
  assert.equal(read.input.IfMatch, '"etag-1"');
  assert.equal(read.input.Range, 'bytes=0-63');

  await copyStoredObject(locator, 'content/u/v/file name.pdf', 'etag-1');
  const copy = commands[1] as InstanceType<typeof CopyObjectCommand>;
  assert.ok(copy instanceof CopyObjectCommand);
  assert.equal(copy.input.Key, 'content/u/v/file name.pdf');
  assert.equal(copy.input.CopySource, 'test-bucket/incoming/content/u/v/file%20name.pdf');
  assert.equal(copy.input.CopySourceIfMatch, '"etag-1"');

  // A replaced (412) or deleted (404) object is "changed", never "unavailable".
  for (const status of [412, 404]) {
    send.mock.mockImplementation(async () => { throw { $metadata: { httpStatusCode: status } }; });
    await assert.rejects(readStoredObject(locator, 'etag-1'), { status: 409, code: 'UPLOAD_OBJECT_CHANGED' });
    await assert.rejects(copyStoredObject(locator, 'content/x.pdf', 'etag-1'), { status: 409, code: 'UPLOAD_OBJECT_CHANGED' });
  }
  send.mock.mockImplementation(async () => { throw new Error('socket hang up'); });
  await assert.rejects(readStoredObject(locator, 'etag-1'), { status: 503, code: 'OBJECT_STORAGE_UNAVAILABLE' });
});
