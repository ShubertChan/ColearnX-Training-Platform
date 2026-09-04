// The database expiry is recorded just before the signed URL is issued.
// Keep a small safety window for signing latency and clock skew before an
// object is considered impossible to recreate through that URL.
export const SIGNED_UPLOAD_EXPIRY_SAFETY_SECONDS = 60;

export function remainingSignedUploadTtlSeconds(uploadExpiresAt: Date | string, now = new Date()) {
  const expiryTime = new Date(uploadExpiresAt).getTime();
  if (!Number.isFinite(expiryTime)) return 0;
  return Math.max(0, Math.floor((expiryTime - now.getTime()) / 1_000));
}

export function canFinalizeStorageAssetDeletion(uploadExpiresAt: Date | string, now = new Date()) {
  const expiryTime = new Date(uploadExpiresAt).getTime();
  if (!Number.isFinite(expiryTime)) return false;
  return expiryTime + SIGNED_UPLOAD_EXPIRY_SAFETY_SECONDS * 1_000 <= now.getTime();
}
