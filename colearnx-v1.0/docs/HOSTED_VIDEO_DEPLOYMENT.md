# Hosted-video deployment (V1)

This implementation uses private R2 source/HLS objects, the existing PostgreSQL database with pg-boss, a self-hosted Docker FFmpeg worker, and a Cloudflare Worker gateway. It does not use Cloudflare Stream, Mux, public `r2.dev`, Redis, or a new paid queue.

## 1. Apply database and prepare the queue

Apply migrations through the existing migration process, including `016_hosted_video.sql`. Do not edit an already-applied migration.

Before applying the migration, have the controlled Neon owner create the login role `colearnx_video_worker` (do not reuse `colearnx_app`). Migration `016` grants that role only the video state and object-metadata columns it needs. From `apps/api`, run `npm run video:queue:prepare` once with `VIDEO_QUEUE_MIGRATION_DATABASE_URL` set to a migration-owner database role. This creates/migrates the `pgboss` schema and grants the API and Worker only their queue permissions. The Render API role must use `VIDEO_QUEUE_DATABASE_URL` with only the privileges it needs to submit jobs; do not give it schema-owner privileges.

## 2. Configure the API

Keep `ENABLE_HOSTED_VIDEO=false` until all services below are ready. Before enabling it, set these Render secrets:

- `VIDEO_SOURCE_MAX_BYTES` — source cap; default is 20 GiB.
- `VIDEO_PLAYBACK_GATEWAY_ORIGIN` — deployed `colearnx-media-gateway` origin.
- `VIDEO_PLAYBACK_TOKEN_SECRET` — a unique 32+ character HMAC secret, shared only with the gateway.
- `VIDEO_PLAYBACK_TTL_SECONDS` — fixed at no more than five minutes (V1 defaults to 300 seconds); a self-contained gateway ticket cannot be revoked per segment without violating the Free Plan boundary.
- `VIDEO_HEARTBEAT_MAX_GAP_SECONDS` — server-receive-time gap that resets the watch interval; default 30 seconds.
- `VIDEO_QUEUE_DATABASE_URL` — pg-boss connection for the web service.

Keep `R2_*` credentials server-only. The API returns only short-lived R2 multipart `PUT` URLs to the trainer, never source URLs to learners.

## 3. Run the FFmpeg worker on owned hardware

Build/run `apps/video-worker` on a team-controlled computer with Docker and outbound TLS access to Neon and R2. Its environment needs:

- `VIDEO_WORKER_DATABASE_URL` — worker-only database role.
- `VIDEO_QUEUE_DATABASE_URL` (or omit to reuse the worker URL).
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_REGION`.
- `VIDEO_HLS_BUCKET_NAME` — private R2 bucket for `course-video-hls/<videoVersionId>/` objects.
- optional `VIDEO_WORKER_CONCURRENCY` (default `1`) and `DATABASE_SSL=true`.

The worker claims only `queued` versions, validates duration and dimensions with `ffprobe`, produces HLS plus a thumbnail with FFmpeg, verifies the playlist/segments and decodability, writes a non-public staging prefix, then publishes the verified output to the immutable version prefix and makes the version current. It also retries `delete_pending` cleanup for both source and HLS objects. A replacement supersedes the former current version but leaves its HLS objects available for orders already bound to it.

## 4. Deploy the media gateway

In `apps/media-gateway/wrangler.jsonc`, replace the placeholder private HLS bucket and application origin. Set the Worker secret with:

```powershell
npx wrangler secret put PLAYBACK_TOKEN_SECRET
```

Its value must exactly match `VIDEO_PLAYBACK_TOKEN_SECRET`. Deploy with `npx wrangler deploy`. The gateway accepts only Bearer HMAC tokens, validates expiry and video-version/path binding for every manifest and segment, and reads through the private `HLS_BUCKET` binding. It never exposes an R2 URL or accesses Neon/Render per segment.

## 5. Historical inventory and reconciliation

Migration `016` backfills only a course run with exactly one legacy `online_video` asset that is already `ready`, has verified `video/*` metadata and has no video version. It changes that asset to `video_source` and creates a `failed` version with `LEGACY_REPROCESS_REQUIRED`; an authorised retry then runs the same Worker validation as a new source. It never marks legacy media ready and never updates historical `order_items`.

Before enabling the feature, inventory rows left for manual review:

```sql
SELECT asset.course_run_id, count(*) AS legacy_assets,
  array_agg(asset.course_delivery_asset_id ORDER BY asset.created_at) AS asset_ids,
  array_agg(asset.asset_status ORDER BY asset.created_at) AS statuses
FROM course_delivery_assets asset
WHERE asset.asset_purpose = 'online_video'
GROUP BY asset.course_run_id
ORDER BY asset.course_run_id;
```

After processing, reconciliation must return no invalid current version, cross-bound order binding or ready version without complete media metadata:

```sql
SELECT course_video_version_id, course_run_id, video_status
FROM course_video_versions
WHERE (is_current AND video_status <> 'ready')
   OR (video_status = 'ready' AND (duration_seconds IS NULL OR hls_master_key IS NULL OR thumbnail_key IS NULL));

SELECT oi.order_item_id, oi.course_run_id, cv.course_run_id AS video_course_run_id
FROM order_items oi
JOIN course_video_versions cv ON cv.course_video_version_id = oi.course_video_version_id
WHERE oi.course_run_id IS DISTINCT FROM cv.course_run_id;
```
## 6. Release gates

Before setting `ENABLE_HOSTED_VIDEO=true`, verify:

1. A trainer can upload a multipart source, and the API cannot return an R2 source download URL.
2. A successful worker job reports `ready` duration/dimensions; a corrupt source becomes `failed`.
3. Admin preview works only after administrator MFA.
4. Checkout stores `order_items.course_video_version_id`; replacement does not change an old order's version.
5. No token, expired token, cross-version token, source path, and direct R2 host all fail.
6. Repeat/overlapping heartbeats do not increase unique watch time; seeking creates no credit; a post-10% refund request is rejected.
7. Refund approval revokes active DB sessions and new sessions are denied.

Watch Worker request volume and failures under the Workers Free Plan. V1 capacity is deliberately bounded: do not automatically upgrade a service or introduce a paid media SaaS.
