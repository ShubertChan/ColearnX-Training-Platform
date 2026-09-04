import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

export function createContentObjectKey(ownerUserId: string, contentVersionId: string, filename: string) {
  const extension = extensionOf(filename);
  return `content/${ownerUserId}/${contentVersionId}/${randomUUID()}.${extension}`;
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

export async function headUploadedObject(locator: ObjectLocator): Promise<HeadedObject> {
  try {
    const object = await storageClient().send(new HeadObjectCommand({ Bucket: locator.bucketName, Key: locator.objectKey }));
    return { contentType: object.ContentType, contentLength: object.ContentLength, etag: object.ETag?.replaceAll('"', '') };
  } catch (error) {
    if (httpStatus(error) === 404) {
      throw new ApiError(409, 'UPLOAD_OBJECT_MISMATCH', 'The uploaded file could not be verified.');
    }
    throw unavailable();
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
