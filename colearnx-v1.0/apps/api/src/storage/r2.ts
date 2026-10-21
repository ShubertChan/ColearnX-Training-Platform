import { randomUUID } from 'node:crypto';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';

const mediaTypeExtensions: Record<string, readonly string[]> = {
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/zip': ['zip'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'video/mp4': ['mp4'],
};

const mediaTypeAliases: Record<string, string> = {
  'application/x-zip-compressed': 'application/zip',
};

export type UploadMetadata = {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256?: string;
};

export type HeadedObject = {
  contentType: string | undefined;
  contentLength: number | undefined;
  etag: string | undefined;
};

type ObjectLocator = {
  bucketName: string;
  objectKey: string;
};

let r2: S3Client | undefined;

function normalizedMediaType(value: string) {
  const raw = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaTypeAliases[raw] ?? raw;
}

function uploadSizeLimit(mediaType: string) {
  return mediaType === 'video/mp4'
    ? env.CONTENT_VIDEO_UPLOAD_MAX_BYTES
    : env.CONTENT_UPLOAD_MAX_BYTES;
}

function extensionOf(filename: string) {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  return match?.[1]?.toLowerCase() ?? '';
}

export function validateUploadMetadata(input: UploadMetadata): UploadMetadata {
  const filename = input.filename.trim();
  if (!filename || filename.length > 512 || /[\u0000-\u001f\u007f\\/]/.test(filename)) {
    throw new ApiError(415, 'CONTENT_FILE_TYPE_NOT_ALLOWED', 'The filename is not allowed.');
  }
  const mediaType = normalizedMediaType(input.mediaType);
  const extensions = mediaTypeExtensions[mediaType];
  if (!extensions || !extensions.includes(extensionOf(filename))) {
    throw new ApiError(415, 'CONTENT_FILE_TYPE_NOT_ALLOWED', 'The file type is not allowed.');
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The upload size is invalid.');
  }
  if (input.sizeBytes > uploadSizeLimit(mediaType)) {
    throw new ApiError(413, 'CONTENT_FILE_TOO_LARGE', 'The file exceeds the upload size limit.');
  }
  return { filename, mediaType, sizeBytes: input.sizeBytes, sha256: input.sha256 };
}

// W8: the browser uploads to a key under `incoming/`. Only after the content
// has been inspected is it copied to its served key (promotedObjectKey), and
// the row is repointed there. The presigned PUT URL stays valid until it
// expires, so without this split a creator could upload a clean file, have it
// verified, and then overwrite the same key with something else. A re-PUT now
// lands on an incoming key that nothing serves; an R2 lifecycle rule on the
// `incoming/` prefix removes such strays (see docs/security/W8-verification.md).
export const INCOMING_PREFIX = 'incoming/';

export function createContentObjectKey(ownerUserId: string, contentVersionId: string, filename: string) {
  const extension = extensionOf(filename);
  return `${INCOMING_PREFIX}content/${ownerUserId}/${contentVersionId}/${randomUUID()}.${extension}`;
}

export function createCourseObjectKey(ownerUserId: string, courseRunId: string, filename: string) {
  const extension = extensionOf(filename);
  return `${INCOMING_PREFIX}course/${ownerUserId}/${courseRunId}/${randomUUID()}.${extension}`;
}

/**
 * The served key for one verification attempt. Unique per attempt (the nonce)
 * so that an attempt which does not end up committed -- it lost a race with a
 * concurrent completion, or the draft changed meanwhile -- can always delete
 * its own copy without any risk of removing an object another row serves.
 * Keys issued before W8 have no `incoming/` prefix; they are promoted the same
 * way, which still moves the served object off the key the old PUT URL can
 * write to.
 */
export function promotedObjectKey(objectKey: string, nonce: string = randomUUID()) {
  const base = objectKey.startsWith(INCOMING_PREFIX) ? objectKey.slice(INCOMING_PREFIX.length) : objectKey;
  const dot = base.lastIndexOf('.');
  return dot > base.lastIndexOf('/') ? `${base.slice(0, dot)}.v-${nonce}${base.slice(dot)}` : `${base}.v-${nonce}`;
}

export function contentTypeMatches(expected: string, actual: string | undefined) {
  if (!actual) return false;
  return normalizedMediaType(actual) === normalizedMediaType(expected);
}

export function safeContentDisposition(filename: string, mode: 'attachment' | 'inline') {
  // filename has already passed upload validation. The ASCII fallback prevents
  // untrusted text from becoming a raw response header value.
  return `${mode}; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function storageClient() {
  if (env.OBJECT_STORAGE_PROVIDER !== 'r2') {
    throw new ApiError(503, 'OBJECT_STORAGE_UNAVAILABLE', 'Object storage is not configured.');
  }
  r2 ??= new S3Client({
    region: env.R2_REGION,
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return r2;
}

function httpStatus(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

function unavailable() {
  return new ApiError(503, 'OBJECT_STORAGE_UNAVAILABLE', 'Object storage is temporarily unavailable.');
}

export async function signUpload(locator: ObjectLocator, mediaType: string, expiresInSeconds: number) {
  try {
    return await getSignedUrl(storageClient(), new PutObjectCommand({
      Bucket: locator.bucketName,
      Key: locator.objectKey,
      ContentType: mediaType,
    }), { expiresIn: expiresInSeconds });
  } catch {
    throw unavailable();
  }
}

export async function findStoredObject(locator: ObjectLocator): Promise<HeadedObject | null> {
  try {
    const object = await storageClient().send(new HeadObjectCommand({ Bucket: locator.bucketName, Key: locator.objectKey }));
    return { contentType: object.ContentType, contentLength: object.ContentLength, etag: object.ETag?.replaceAll('"', '') };
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    throw unavailable();
  }
}

export async function headUploadedObject(locator: ObjectLocator): Promise<HeadedObject> {
  const object = await findStoredObject(locator);
  if (!object) throw new ApiError(409, 'UPLOAD_OBJECT_NOT_FOUND', 'The file has not reached storage. Retry the upload.');
  return object;
}

function changed() {
  return new ApiError(409, 'UPLOAD_OBJECT_CHANGED', 'The file changed while it was being checked. Retry the upload.');
}

function storageReadError(error: unknown) {
  // 412: the If-Match ETag no longer matches -- the object was replaced after
  // HEAD. 404: it was deleted. Either way the bytes that were checked are not
  // the bytes that would be served.
  const status = httpStatus(error);
  return status === 412 || status === 404 ? changed() : unavailable();
}

/**
 * Reads an object (or its first bytes), pinned to the ETag that HEAD saw, so
 * the inspected bytes are exactly the ones that were size-checked.
 */
export async function readStoredObject(locator: ObjectLocator, etag: string, firstBytes?: number): Promise<Buffer> {
  try {
    const object = await storageClient().send(new GetObjectCommand({
      Bucket: locator.bucketName,
      Key: locator.objectKey,
      IfMatch: `"${etag}"`,
      Range: firstBytes ? `bytes=0-${firstBytes - 1}` : undefined,
    }));
    if (!object.Body) throw unavailable();
    return Buffer.from(await object.Body.transformToByteArray());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw storageReadError(error);
  }
}

export async function streamStoredObject(locator: ObjectLocator, etag: string): Promise<AsyncIterable<Buffer>> {
  try {
    const object = await storageClient().send(new GetObjectCommand({
      Bucket: locator.bucketName, Key: locator.objectKey, IfMatch: `"${etag}"`,
    }));
    if (!object.Body) throw unavailable();
    return object.Body as unknown as AsyncIterable<Buffer>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw storageReadError(error);
  }
}

/**
 * Server-side copy of the inspected object to its served key, conditional on
 * the source still having the inspected ETag.
 */
export async function copyStoredObject(source: ObjectLocator, destinationKey: string, etag: string) {
  try {
    await storageClient().send(new CopyObjectCommand({
      Bucket: source.bucketName,
      Key: destinationKey,
      CopySource: `${source.bucketName}/${source.objectKey.split('/').map(encodeURIComponent).join('/')}`,
      CopySourceIfMatch: `"${etag}"`,
    }));
  } catch (error) {
    throw storageReadError(error);
  }
}

export async function signDownload(locator: ObjectLocator, mediaType: string, filename: string, mode: 'attachment' | 'inline') {
  try {
    return await getSignedUrl(storageClient(), new GetObjectCommand({
      Bucket: locator.bucketName,
      Key: locator.objectKey,
      ResponseContentType: mediaType,
      ResponseContentDisposition: safeContentDisposition(filename, mode),
    }), { expiresIn: env.R2_SIGNED_DOWNLOAD_TTL_SECONDS });
  } catch {
    throw unavailable();
  }
}

export async function deleteStoredObject(locator: ObjectLocator) {
  try {
    await storageClient().send(new DeleteObjectCommand({ Bucket: locator.bucketName, Key: locator.objectKey }));
  } catch {
    throw unavailable();
  }
}
