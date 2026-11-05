import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { normalizeCoverImage } from './cover-image.js';

test('a PNG cover becomes a small, metadata-free JPEG', async () => {
  const png = await sharp({ create: { width: 800, height: 960, channels: 3, background: '#5465d0' } })
    .png().withMetadata({ density: 300 }).toBuffer();
  const jpeg = await normalizeCoverImage(png, 'image/png');
  const metadata = await sharp(jpeg).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.deepEqual([metadata.width, metadata.height], [640, 768]);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.exif, undefined);
  assert.ok(jpeg.length <= 262144);
});

test('empty, spoofed and truncated images are rejected before storage', async () => {
  await assert.rejects(normalizeCoverImage(undefined, 'image/png'), { code: 'COVER_SIZE_INVALID' });
  await assert.rejects(normalizeCoverImage(Buffer.from('<svg/>'), 'image/png'), { code: 'COVER_TYPE_INVALID' });
  await assert.rejects(normalizeCoverImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'), { code: 'COVER_IMAGE_INVALID' });
});
