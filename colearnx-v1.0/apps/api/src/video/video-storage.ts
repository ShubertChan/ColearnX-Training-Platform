import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';

export const VIDEO_PART_SIZE_BYTES = 8 * 1024 * 1024;
export const VIDEO_MAX_PARTS = 10_000;

export type VideoSource = { filename: string; mediaType: string; sizeBytes: number };
export type UploadedPart = { partNumber: number; etag: string; sizeBytes: number };

const extensionMediaTypes: Record<string, readonly string[]> = {
  mp4: ['video/mp4', 'application/octet-stream'],
  mov: ['video/quicktime', 'application/octet-stream'],
  m4v: ['video/x-m4v', 'video/mp4', 'application/octet-stream'],
  webm: ['video/webm', 'application/octet-stream'],
  mkv: ['video/x-matroska', 'video/webm', 'application/octet-stream'],
};

let client: S3Client | undefined;

function normalizedMediaType(value: string) {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function extensionOf(filename: string) {
  return /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
}

function storageClient() {
  if (env.OBJECT_STORAGE_PROVIDER !== 'r2') {
    throw new ApiError(503, 'OBJECT_STORAGE_UNAVAILABLE', 'Private object storage is not configured.');
  }
  client ??= new S3Client({
    region: env.R2_REGION,
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  return client;
}

function unavailable() {
  return new ApiError(503, 'OBJECT_STORAGE_UNAVAILABLE', 'Private object storage is temporarily unavailable.');
}

export function validateVideoSource(input: VideoSource, maxBytes: number): VideoSource {
  const filename = input.filename.trim();
  const extension = extensionOf(filename);
  const mediaType = normalizedMediaType(input.mediaType);
  if (!filename || filename.length > 512 || /[\u0000-\u001f\u007f\\/]/.test(filename) || !extensionMediaTypes[extension]?.includes(mediaType)) {
    throw new ApiError(415, 'VIDEO_INVALID_SOURCE', 'Choose a supported MP4, MOV, M4V, WebM, or MKV source file.');
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maxBytes) {
    throw new ApiError(413, 'VIDEO_SOURCE_TOO_LARGE', 'The source file exceeds the configured video upload limit.');
  }
  if (Math.ceil(input.sizeBytes / VIDEO_PART_SIZE_BYTES) > VIDEO_MAX_PARTS) {
    throw new ApiError(413, 'VIDEO_SOURCE_TOO_LARGE', 'The source file requires more than the supported number of upload parts.');
  }
  return { filename, mediaType, sizeBytes: input.sizeBytes };
}

export function createVideoSourceObjectKey(ownerUserId: string, courseRunId: string, filename: string) {
  return `course-video-source/${ownerUserId}/${courseRunId}/${randomUUID()}.${extensionOf(filename)}`;
}

export async function startMultipartVideoUpload(bucketName: string, objectKey: string, mediaType: string) {
  try {
    const output = await storageClient().send(new CreateMultipartUploadCommand({
      Bucket: bucketName, Key: objectKey, ContentType: mediaType,
    }));
    if (!output.UploadId) throw unavailable();
    return output.UploadId;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

export async function listMultipartVideoParts(bucketName: string, objectKey: string, uploadId: string): Promise<UploadedPart[]> {
  try {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await storageClient().send(new ListPartsCommand({ Bucket: bucketName, Key: objectKey, UploadId: uploadId, PartNumberMarker: marker }));
      for (const part of page.Parts ?? []) {
        if (part.PartNumber && part.ETag && part.Size !== undefined) {
          parts.push({ partNumber: part.PartNumber, etag: part.ETag.replaceAll('"', ''), sizeBytes: part.Size });
        }
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker !== undefined);
    return parts;
  } catch {
    throw new ApiError(409, 'UPLOAD_EXPIRED', 'The multipart upload is no longer available.');
  }
}

export async function signMultipartVideoPart(bucketName: string, objectKey: string, uploadId: string, partNumber: number) {
  try {
    const url = await getSignedUrl(storageClient(), new UploadPartCommand({
      Bucket: bucketName, Key: objectKey, UploadId: uploadId, PartNumber: partNumber,
    }), { expiresIn: env.R2_SIGNED_UPLOAD_TTL_SECONDS });
    return { url, headers: {} };
  } catch {
    throw unavailable();
  }
}

export async function completeMultipartVideoUpload(bucketName: string, objectKey: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
  try {
    await storageClient().send(new CompleteMultipartUploadCommand({
      Bucket: bucketName,
      Key: objectKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
    }));
  } catch {
    throw new ApiError(409, 'VIDEO_PARTS_INVALID', 'The supplied multipart upload parts could not be completed.');
  }
}

export async function abortMultipartVideoUpload(bucketName: string, objectKey: string, uploadId: string) {
  try {
    await storageClient().send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: objectKey, UploadId: uploadId }));
  } catch {
    // The operation is intentionally idempotent; a completed or expired upload is already gone.
  }
}

export async function headVideoSource(bucketName: string, objectKey: string) {
  try {
    const object = await storageClient().send(new HeadObjectCommand({ Bucket: bucketName, Key: objectKey }));
    return { contentLength: object.ContentLength, etag: object.ETag?.replaceAll('"', '') };
  } catch {
    throw new ApiError(409, 'UPLOAD_OBJECT_MISMATCH', 'The uploaded source could not be verified.');
  }
}

export async function deleteVideoObject(bucketName: string, objectKey: string) {
  try {
    await storageClient().send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }));
  } catch {
    throw unavailable();
  }
}
