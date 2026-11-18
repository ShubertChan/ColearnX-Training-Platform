import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mock } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { env } from '../src/config/env.ts';

export async function runFileTransferChecks({ owner, app, buyerId, sellerId, version, courseItem, workbookItem, courseAsset, accessToken, passed, transport = globalThis.fetch }) {
  const bytes = randomBytes(128 * 1024);
  const contentAsset = randomUUID();
  await owner.query(`INSERT INTO storage_assets(storage_asset_id,content_version_id,owner_user_id,bucket_name,object_key,
    original_filename,declared_content_type,declared_byte_size,verified_content_type,verified_byte_size,verified_at,asset_status,upload_expires_at)
    VALUES ($1,$2,$3,'fixture',$4,'workbook.pdf','application/pdf',$5,'application/pdf',$5,now(),'ready',now()+interval '1 hour')`,
  [contentAsset, version, sellerId, 'fixture/' + contentAsset, bytes.length]);
  await owner.query('UPDATE course_delivery_assets SET declared_byte_size=$2, verified_byte_size=$2 WHERE course_delivery_asset_id=$1', [courseAsset, bytes.length]);
  let interruptNext = false;
  let storageEtag = '"fixture-v1"';
  const objectRead = mock.method(S3Client.prototype, 'send', async (command, { abortSignal }) => {
    assert.ok(command instanceof GetObjectCommand);
    const range = command.input.Range?.match(/^bytes=(\d+)-(\d+)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range ? Number(range[2]) + 1 : bytes.length;
    const stall = interruptNext;
    interruptNext = false;
    async function* stream() {
      const firstEnd = Math.min(start + 8192, end);
      yield bytes.subarray(start, firstEnd);
      if (stall && !abortSignal.aborted) await once(abortSignal, 'abort');
      if (!abortSignal.aborted && firstEnd < end) yield bytes.subarray(firstEnd, end);
    }
    return { Body: stream(), ETag: storageEtag, ContentLength: end - start, ContentRange: range && `bytes ${start}-${end - 1}/${bytes.length}` };
  });
  const previous = { API_ORIGIN: env.API_ORIGIN, OBJECT_STORAGE_PROVIDER: env.OBJECT_STORAGE_PROVIDER };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  env.API_ORIGIN = 'http://127.0.0.1:' + server.address().port;
  env.OBJECT_STORAGE_PROVIDER = 'r2';
  // The release harness blocks external fetches. Exercise real sockets only
  // on this ephemeral loopback origin, including every redirect hop.
  const localOrigin = env.API_ORIGIN;
  async function readFile(url, options) {
    let target = new URL(url);
    for (let hop = 0; hop < 3; hop++) {
      assert.equal(target.origin, localOrigin);
      const response = await transport(target, { ...options, redirect: 'manual' });
      if (response.status !== 307) return response;
      await response.arrayBuffer();
      target = new URL(response.headers.get('location'), target);
    }
    assert.fail('Too many local download redirects');
  }
  async function getLink(path, assetId) {
    const result = await request(app).post('/api/v1/' + path).auth(accessToken(buyerId), { type: 'bearer' }).send({ assetId }).expect(200);
    return new URL(result.body.data.downloadUrl);
  }
  async function countIs(item, expected) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const { rows } = await owner.query('SELECT completed_file_downloads FROM order_items WHERE order_item_id=$1', [item]);
      if (Number(rows[0].completed_file_downloads) === expected) return;
      await wait(25);
    }
    assert.fail('File transfer count did not reach ' + expected);
  }
  try {
    const course = await getLink('order-items/' + courseItem + '/delivery/download-url', courseAsset);
    const contentRoute = 'content-versions/' + version + '/download-url';
    const content = await getLink(contentRoute, contentAsset);
    const second = await getLink(contentRoute, contentAsset);
    assert.notEqual(content.href, second.href);
    await owner.query("UPDATE file_download_links SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",
      [createHash('sha256').update(second.searchParams.get('ticket')).digest('hex')]);
    const expired = await readFile(second);
    assert.equal(expired.status, 404);
    await expired.arrayBuffer();
    assert.equal((await readFile(content, { method: 'HEAD' })).headers.get('content-length'), String(bytes.length));
    const invalid = await readFile(content, { headers: { Range: 'bytes=999999999-' } });
    assert.equal(invalid.status, 416);
    await invalid.arrayBuffer();
    await countIs(workbookItem, 0);
    // Two independent readers must not be combined into one fictitious download.
    const half = bytes.length / 2;
    const ranges = await Promise.all([readFile(content, { headers: { Range: 'bytes=0-' + (half - 1) } }),
      readFile(content, { headers: { Range: 'bytes=' + half + '-' } })]);
    assert.notEqual(ranges[0].url, ranges[1].url);
    for (const part of ranges) { assert.equal(part.status, 206); await part.arrayBuffer(); }
    await countIs(workbookItem, 0);
    storageEtag = '"fixture-v2"';
    const changed = await readFile(ranges[0].url, { headers: { Range: 'bytes=' + half + '-' } });
    assert.equal(changed.status, 409);
    await changed.arrayBuffer();
    storageEtag = '"fixture-v1"';
    for (const downloaded of await Promise.all([readFile(content), readFile(content)])) {
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    }
    await countIs(workbookItem, 2);
    passed('claim, expiry and HEAD transfer no files; independent partial reads stay separate; two complete GETs on the same link count twice');

    interruptNext = true;
    const stop = new AbortController();
    const first = await readFile(course, { signal: stop.signal });
    const etag = first.headers.get('etag');
    const received = (await first.body.getReader().read()).value;
    assert.deepEqual(Buffer.from(received), bytes.subarray(0, received.length));
    stop.abort();
    await countIs(courseItem, 0);
    const offset = received.length - 4; // A real resume can overlap the last bytes.
    const tail = await readFile(course, { headers: { Range: 'bytes=' + offset + '-', 'If-Range': etag } });
    assert.equal(tail.status, 206);
    const remainder = Buffer.from(await tail.arrayBuffer());
    assert.deepEqual(Buffer.concat([received.subarray(0, offset), remainder]), bytes);
    await countIs(courseItem, 1);
    const duplicates = await Promise.all([readFile(first.url, { headers: { Range: 'bytes=-32' } }),
      readFile(course, { headers: { Range: 'bytes=-32', 'If-Range': etag } })]);
    for (const duplicate of duplicates) {
      assert.equal(duplicate.status, 206);
      assert.deepEqual(Buffer.from(await duplicate.arrayBuffer()), bytes.subarray(-32));
    }
    await countIs(courseItem, 1);
    passed('a disconnected file counts zero, an overlapping resume reconstructs the file, and repeating its final range counts no extra download');
    return course.pathname + course.search;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    objectRead.mock.restore();
    Object.assign(env, previous);
  }
}
