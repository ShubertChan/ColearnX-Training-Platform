export type StorageQuotaInput = {
  usedBytes: number;
  pendingUploads: number;
  requestedBytes: number;
  maxBytes: number;
  maxPendingUploads: number;
};

export type StorageQuotaViolation = {
  status: 413 | 429;
  code: 'CONTENT_STORAGE_QUOTA_EXCEEDED' | 'CONTENT_UPLOAD_PENDING_LIMIT';
  message: string;
};

export function storageQuotaViolation(input: StorageQuotaInput): StorageQuotaViolation | null {
  if (input.pendingUploads >= input.maxPendingUploads) {
    return {
      status: 429,
      code: 'CONTENT_UPLOAD_PENDING_LIMIT',
      message: 'Finish or remove an existing upload before starting another one.',
    };
  }
  if (input.usedBytes + input.requestedBytes > input.maxBytes) {
    return {
      status: 413,
      code: 'CONTENT_STORAGE_QUOTA_EXCEEDED',
      message: 'Your storage limit has been reached. Remove an existing file or choose a smaller file.',
    };
  }
  return null;
}
