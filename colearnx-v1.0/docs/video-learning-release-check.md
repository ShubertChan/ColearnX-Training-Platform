# Video learning and course start-time release

## Deploy together

- Deploy the API changes and frontend bundle together; no new schema migration is needed for this change (`course_runs.starts_at` already exists).
- Learner route: `/purchases/:orderItemId/watch`. My Learning links here instead of embedding playback.
- Video creation, draft update, submission and publication require a start time. Playback and heartbeat APIs use database time and reject access before it, including session renewal.
- Protected delivery returns course metadata, `startsAt`, `serverTime`, and `playerState` (`ready`, `scheduled`, `schedule_required`, or processing). A refresh at opening time rechecks the server; the browser clock never grants access.
- Administrator review preview retains its separate MFA-protected endpoint; learning-page changes do not alter review permissions or refund rules.

## Historical courses

Do not automatically assign dates to existing courses. Video courses with no start time stay locked. The Trainer can fix an owned draft in Publishing tools. Published/submitted dates remain read-only and need an Administrator-approved operational correction; this change does not implement a new schedule-change approval workflow.

Read-only inventory for deployment review:

```sql
SELECT cr.course_run_id, c.title, cr.run_status, cr.starts_at
FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
WHERE cr.progress_tracking_type = 'online_video' AND cr.starts_at IS NULL;
```

Tokens issued by the old deployment can remain valid until their existing TTL expires. For immediate invalidation, coordinate rotation of the same playback secret on the API and media gateway, following the deployment team's secret-management procedure. Never put secrets in source, logs, screenshots or the PR.

## Verification

```text
npm test
npm run test:components
npm run build -- --configLoader native
npx playwright test tests/e2e/learning-page.spec.js tests/e2e/video.spec.js tests/e2e/course-upload.spec.js --project=chromium --workers=1
npx playwright test tests/e2e/learning-page.spec.js tests/e2e/course-upload.spec.js --project=webkit --workers=1
cd apps/api
npm test
npm run typecheck
```

For the real database/API check, create a NEW empty disposable LOCAL PostgreSQL database named `colearnx_release_check_video_<unique>`, in a cluster containing no non-test databases. Set `VIDEO_START_CHECK_DATABASE_URL` to its owner URL, then run:

```text
node --import tsx scripts/video-start-integration-check.mjs
```

The script uses a real restricted `colearnx_app` login, blocks external HTTP, and retains fixture data. It must never run against staging/production. Local verification used PostgreSQL 18.6; run the same check on the deployment's PostgreSQL version before release.

Check 375/768/1024/1440px layouts, keyboard navigation, real play/pause, seeking, renewal, direct-route refresh, missing/future start times, draft-date editing, and stable category options/reset. WebKit builds without H.264 MediaSource cannot decode header-authorised HLS; verify actual Safari playback on supported deployment hardware separately.
