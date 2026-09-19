import { useEffect, useRef, useState } from "react";
import { recordCourseProgress } from "../api/courseDelivery";
import { createPlaybackSession, createPreviewSession } from "../api/video";
import { confirmedProgress, mediaUrl, validatePlaybackSession } from "../utils/videoContract";
import { createHeartbeatReporter } from "../utils/videoHeartbeat";
import { Button, Progress } from "./ui";

const messages = {
  loading: "Authorising video playback…", processing: "This video is still being prepared. Refresh delivery after processing finishes.",
  expired: "Playback authorisation expired. Renew it to continue.", unauthorised: "This video is unavailable for this account or purchase.",
  network_error: "Video playback was interrupted. Check your connection and retry.", unsupported: "This browser cannot play this video. Try a browser with HLS support.",
  unavailable: "This video is unavailable. Refresh delivery for its latest status.",
};
export default function CourseVideoPlayer({ orderItemId, record, onRecorded, onReady, previewCourseId, previewVersionId }) {
  const videoRef = useRef(null), reporterRef = useRef(null), callbackRef = useRef(onRecorded);
  callbackRef.current = onRecorded;
  const readyRef = useRef(onReady); readyRef.current = onReady;
  const [state, setState] = useState("loading"), [progressError, setProgressError] = useState("");
  const [attempt, setAttempt] = useState(0), [progress, setProgress] = useState(() => confirmedProgress(record));
  const preview = Boolean(previewCourseId);
  const expectedVersion = previewVersionId || record?.video?.id || record?.videoVersionId || record?.courseVideoVersionId;
  const versionStatus = record?.video?.status || record?.videoStatus;
  const playbackState = record?.playerState;
  useEffect(() => { setProgress(confirmedProgress(record)); }, [record]);
  useEffect(() => {
    const media = videoRef.current;
    let disposed = false, hls = null, renewal, expiry, reporter, loading = false;
    let session, previousPosition = null, resumePlaying = false, recoveredMedia = false, authRecovery = false, generation = 0, shouldRestore = false;
    const abort = new AbortController(), events = [];
    const report = event => reporter?.report(event, media);
    const detach = () => {
      if (reporter) { void report("pause"); reporter.close(); reporter = null; reporterRef.current = null; }
      clearTimeout(renewal); clearTimeout(expiry);
      hls?.destroy(); hls = null;
      media.pause(); media.removeAttribute("src"); media.load();
    };
    const fail = value => { if (!disposed) { generation++; detach(); session = null; setState(value); } };
    const renewExpired = () => {
      if (loading || disposed) return;
      if (authRecovery) fail("expired");
      else { authRecovery = true; void open(true); }
    };
    const open = async (renewing = false) => {
      if (disposed || loading) return;
      loading = true;
      const current = ++generation;
      if (renewing) { previousPosition = media.currentTime; resumePlaying = !media.paused; }
      detach(); setState("loading");
      try {
        const raw = preview
          ? await createPreviewSession(previewCourseId, previewVersionId, crypto.randomUUID(), abort.signal)
          : await createPlaybackSession(orderItemId, crypto.randomUUID(), abort.signal);
        if (disposed || current !== generation) return;
        session = validatePlaybackSession(raw, expectedVersion || session?.videoVersionId);
        shouldRestore = true; recoveredMedia = false;
        const authorizedSession = session;
        if (!preview) {
          reporter = createHeartbeatReporter({ sessionId: session.sessionId,
            send: body => recordCourseProgress(orderItemId, body),
            onProgress: result => { const confirmed = confirmedProgress(result); if (confirmed && !disposed) { setProgress(confirmed); setProgressError(""); callbackRef.current?.(result); } },
            onError: error => {
              if (disposed) return;
              if (error.code === "PLAYBACK_UNAUTHORISED" || error.status === 403) fail("unauthorised");
              else if (error.code === "PLAYBACK_EXPIRED") renewExpired();
              else if (error.status === 401) fail("unauthorised");
              else setProgressError("Viewing progress could not be confirmed. Reconnect and retry; the displayed total has not changed.");
            },
          }); reporterRef.current = reporter;
        }
        const remaining = Date.parse(session.expiresAt) - Date.now();
        renewal = setTimeout(() => void open(true), Math.max(1000, remaining - Math.min(30000, remaining * 0.2)));
        expiry = setTimeout(() => fail("expired"), remaining);
        const manifest = mediaUrl(session.manifestUrl);
        const Hls = (await import("hls.js")).default;
        if (disposed || current !== generation) return;
        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: true, xhrSetup: (xhr, url) => {
            // Validate every playlist, segment and key request before sending credentials.
            if (!mediaUrl(url) || new URL(url).origin !== new URL(manifest).origin) throw new Error("Unapproved media origin");
            xhr.withCredentials = authorizedSession.authorization.type === "cookie";
            if (authorizedSession.authorization.type === "header") xhr.setRequestHeader("Authorization", "Bearer " + authorizedSession.authorization.token);
          } });
          const engine = hls;
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (disposed || generation !== current || hls !== engine) return;
            const status = data.response?.code || data.networkDetails?.status;
            if (status === 403) { fail("unauthorised"); return; }
            if (status === 401) { renewExpired(); return; }
            if (!data.fatal) return;
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
              recoveredMedia = true; previousPosition = media.currentTime; resumePlaying = !media.paused; shouldRestore = true;
              void report("pause"); hls?.recoverMediaError();
            }
            else fail("network_error");
          });
          hls.loadSource(manifest); hls.attachMedia(media);
        } else if (media.canPlayType("application/vnd.apple.mpegurl") && session.authorization.type === "cookie") {
          media.crossOrigin = "use-credentials"; media.src = manifest; media.load();
        } else fail("unsupported");
      } catch (error) {
        if (!disposed) fail(error.code === "PLAYBACK_EXPIRED" ? "expired" : [401, 403].includes(error.status) || error.code === "PLAYBACK_UNAUTHORISED" ? "unauthorised" : error.code === "VIDEO_NOT_READY" ? "processing" : "network_error");
      } finally { loading = false; }
    };
    const listen = (name, handler) => { media.addEventListener(name, handler); events.push([name, handler]); };
    listen("loadedmetadata", () => {
      if (!session || disposed || !shouldRestore) return;
      shouldRestore = false;
      media.currentTime = Math.min(previousPosition ?? session.resumeAt, session.durationSeconds);
      previousPosition = null; setState("ready"); readyRef.current?.(session.videoVersionId);
      if (resumePlaying) { resumePlaying = false; void media.play().catch(() => {}); }
    });
    listen("play", () => void report("playing"));
    listen("playing", () => { if (session) { authRecovery = false; setState("ready"); } void report("playing"); });
    for (const event of ["pause", "seeking", "seeked", "ended"]) listen(event, () => void report(event));
    listen("waiting", () => void report("pause"));
    listen("ratechange", () => { void report("pause"); if (!media.paused) void report("playing"); });
    listen("error", () => { if (!hls && session && !disposed && !loading) fail(Date.now() >= Date.parse(session.expiresAt) ? "expired" : "network_error"); });
    const interval = setInterval(() => { if (!media.paused && !media.seeking && media.readyState >= 3) void report("playing"); }, 7000);
    const visibility = () => { if (document.hidden) void report(media.seeking ? "seeking" : media.paused ? "pause" : "playing"); };
    const leaving = () => { void report("pause"); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", leaving);
    if (["upload_pending", "queued", "transcoding"].includes(versionStatus) || playbackState === "processing") setState("processing");
    else if (playbackState === "unauthorised") setState("unauthorised");
    else if (["failed", "delete_pending", "deleted"].includes(versionStatus)) setState("unavailable");
    else void open();
    return () => { disposed = true; abort.abort(); detach(); clearInterval(interval); events.forEach(([name, handler]) => media.removeEventListener(name, handler)); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", leaving); };
  }, [orderItemId, previewCourseId, previewVersionId, preview, expectedVersion, versionStatus, playbackState, attempt]);
  return <section className="video-player" aria-label={preview ? "Video review preview" : "Online course video"}>
    <b>{preview ? "Review preview" : "Online video"}</b>
    <video ref={videoRef} controls playsInline preload="metadata" controlsList="nodownload" disablePictureInPicture aria-label="Course video" hidden={state !== "ready" && state !== "loading"} />
    {messages[state] && <p role={state === "loading" || state === "processing" ? "status" : "alert"}>{messages[state]}</p>}
    {!preview && <>
      {progress ? <><Progress value={Math.round(progress.watchedRatio * 10000) / 100} label="Server-confirmed unique viewing progress" /><small>{progress.uniqueContentWatchedSeconds.toFixed(3)} of {progress.durationSeconds.toFixed(3)} seconds confirmed. Seeking and repeat viewing do not add duplicate progress.</small></> : <p>Waiting for confirmed viewing progress.</p>}
      {progressError && <p role="alert" className="form-error">{progressError}</p>}
      {state === "ready" && <Button type="button" variant="secondary" size="sm" onClick={() => { const v = videoRef.current; void reporterRef.current?.report(v.seeking ? "seeking" : v.paused ? "pause" : "playing", v); }}>Sync viewing progress</Button>}
    </>}
    {["expired", "network_error"].includes(state) && <Button type="button" variant="secondary" onClick={() => setAttempt(value => value + 1)}>Retry playback</Button>}
  </section>;
}
