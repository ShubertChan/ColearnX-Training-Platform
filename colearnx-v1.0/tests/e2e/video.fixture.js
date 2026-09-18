// Contract fixtures only: these routes are installed by tests, never by the application.
export async function mockVideoApi(page, role = "trainer") {
  const state = { role, status: null, submitted: false, calls: [], hasDownload: false, ratio: 0.1, eligible: true, catalogueVisible: true, playback: false, sessions: 0, duration: 100, ttl: 60000, orderRefreshFails: false, attachmentError: false };
  const course = { id: "course", kind: "course", title: "Recorded design workshop", description: "Video course", pricePoints: 100, deliveryModes: ["cloud"], progressTrackingType: "online_video", refundPolicyPreview: { summary: "Watch no more than 10% and download no protected attachments to request a full points refund." }, status: "draft" };
  const evidence = () => ({ videoVersionId: "purchased-old", uniqueContentWatchedSeconds: state.ratio * state.duration, durationSeconds: state.duration, watchedRatio: state.ratio, hasProtectedAttachmentDownload: state.hasDownload, refundEligibility: { eligible: state.eligible, code: state.eligible ? "ELIGIBLE" : "WATCH_LIMIT_EXCEEDED", explanation: state.eligible ? "Full order-item points refund available." : "The recorded viewing limit has been exceeded." } });
  await page.addInitScript(() => { try { sessionStorage.setItem("colearnx-api-access-token", "test-session"); } catch { /* Test the real storage fallback. */ } });
  await page.route("https://fixture.r2.cloudflarestorage.com/**", async route => {
    state.calls.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
    await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "PUT, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Expose-Headers": "ETag", ETag: "fixture-etag" }, body: "" });
  });
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace("/api/v1", ""), method = request.method();
    let input; try { input = request.postDataJSON(); } catch { input = null; }
    state.calls.push({ path, method, input, requestKey: request.headers()["idempotency-key"] });
    let data = [], status = 200;
    if (path === "/me") data = { id: "test-account", roles: [state.role], email: "test@example.test", capabilities: { canCreateCourse: true }, profile: { displayName: "Test account" } };
    else if (path === "/auth/csrf") data = { csrfToken: "test-csrf" };
    else if (path === "/auth/refresh") data = { accessToken: "test-session", csrfToken: "test-csrf", user: { id: "test-account", roles: [state.role], email: "test@example.test", capabilities: { canCreateCourse: true }, profile: { displayName: "Test account" } } };
    else if (path === "/courses") data = state.catalogueVisible ? [course] : [];
    else if (path === "/my/listings") data = [course];
    else if (path === "/wallet") data = { availablePoints: 1000 };
    else if (path === "/courses/course/assets") { status = state.attachmentError ? 503 : 200; data = { assets: [{ assetId: "source", filename: "source.mp4", assetPurpose: "video_source", status: "ready" }] }; }
    else if (path === "/courses/course/video") data = { canUpload: !state.status, canSubmit: state.status === "ready", reviewVersionId: "new-version", versions: state.status ? [{ id: "new-version", versionNo: 2, status: state.status, durationSeconds: state.status === "ready" ? 100 : null, width: 1920, height: 1080 }] : [] };
    else if (path.endsWith("/video-upload-intents")) { state.status = "upload_pending"; data = { videoVersionId: "new-version" }; }
    else if (path.endsWith("/multipart") && method === "GET") data = { partSizeBytes: 5242880, completed: false, parts: [] };
    else if (path.endsWith("/multipart/sign")) data = { url: `https://fixture.r2.cloudflarestorage.com/part-${input.partNumber}`, headers: {} };
    else if (path.endsWith("/multipart/complete")) data = { completed: true };
    else if (path === "/courses/course/video-versions/new-version/complete") { state.status = "queued"; data = { status: "queued" }; }
    else if (path === "/courses/course/submit") { state.submitted = true; data = { status: "submitted" }; }
    else if (path === "/orders") { status = state.orderRefreshFails ? 503 : 200; data = state.role === "member" ? [{ id: "order" }] : []; }
    else if (path === "/orders/order") data = { id: "order", status: "paid", items: [{ id: "order-item", kind: "course", productId: "course", title: course.title, pricePoints: 100, fulfilmentStatus: "fulfilled", deliveryModes: ["cloud"], onlineVideo: true, courseVideoVersionId: "purchased-old", refundPolicySnapshot: { summary: "Purchased video: full points refund at no more than 10% watched and no protected attachment downloads." } }] };
    else if (path === "/order-items/order-item/delivery") data = { ...evidence(), onlineVideo: true, video: { id: "purchased-old", status: "ready" }, assets: [{ assetId: "source", filename: "source.mp4", purpose: "video_source", status: "ready" }, { assetId: "notes", filename: "notes.pdf", purpose: "attachment", status: "ready" }] };
    else if (path.endsWith("/playback-sessions")) {
      if (state.playback) { state.sessions++; data = { sessionId: `session-${state.sessions}`, videoVersionId: "purchased-old", manifestUrl: "/fixture-media/master.m3u8", expiresAt: new Date(Date.now() + state.ttl).toISOString(), durationSeconds: state.duration, resumeAt: 1, authorization: { type: "header", token: `media-token-${state.sessions}` } }; }
      else { status = 403; data = null; }
    }
    else if (path === "/order-items/order-item/progress") data = evidence();
    else if (path === "/admin/course-submissions") data = [{ ...course, reviewVideoVersionId: "new-version" }];
    else if (path === "/refund-requests") data = { id: "refund", status: "pending" };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 403 ? { error: { code: "PLAYBACK_UNAUTHORISED", message: "Purchase is not authorised" } } : { data, meta: { requestId: "fixture" } }) });
  });
  return state;
}
