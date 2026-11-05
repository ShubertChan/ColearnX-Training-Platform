import sharp from 'sharp';
import { ApiError } from '../lib/http.js';
import { sniffFileType } from '../security/file-signature.js';

export const MAX_COVER_UPLOAD_BYTES = 5 * 1024 * 1024;
export const coverMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];

export async function normalizeCoverImage(body: unknown, mime: string) {
  if (!Buffer.isBuffer(body) || !body.length || body.length > MAX_COVER_UPLOAD_BYTES) {
    throw new ApiError(400, 'COVER_SIZE_INVALID', 'Choose an image up to 5 MB.');
  }
  const detected = sniffFileType(body);
  if (detected.kind !== 'known' || !coverMimeTypes.includes(mime) || detected.mediaType !== mime) {
    throw new ApiError(415, 'COVER_TYPE_INVALID', 'Choose a JPG, PNG or WebP image.');
  }
  try {
    // Decode and re-encode to remove metadata, trailing payloads and animation.
    const image = await sharp(body, { limitInputPixels: 25_000_000, failOn: 'warning' })
      .autoOrient().resize(640, 768, { fit: 'cover', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
    if (image.length > 262144) throw new Error('Cover exceeds storage budget');
    return image;
  } catch {
    throw new ApiError(422, 'COVER_IMAGE_INVALID', 'This image could not be processed. Try a smaller JPG, PNG or WebP image.');
  }
}
