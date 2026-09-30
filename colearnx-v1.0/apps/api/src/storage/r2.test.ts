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
const { contentTypeMatches, createContentObjectKey, findStoredObject, headUploadedObject, safeContentDisposition, validateUploadMetadata } = await import('./r2.js');

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
  assert.match(key, /^content\/11111111-1111-4111-8111-111111111111\/22222222-2222-4222-8222-222222222222\/[0-9a-f-]+\.pdf$/);
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
