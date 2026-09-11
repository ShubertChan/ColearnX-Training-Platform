import { useEffect, useRef, useState } from "react";
import { recordCourseProgress } from "../api/courseDelivery";
import { samplePlayback, watchedDuration } from "../utils/frontendState";
import { Button, Progress } from "./ui";

export default function CourseVideoPlayer({ orderItemId, playbackUrl, record, onRecorded }) {
  const previous = useRef(null), intervals = useRef([]), acknowledged = useRef(0), pending = useRef(false);
  const sessionId = useRef(globalThis.crypto.randomUUID());
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const syncRef = useRef(null);
  const total = Number(record.totalDurationSeconds || 0);
  const watched = Number(record.watchedSeconds || 0);
  const sync = async () => {
    const seconds = Math.round(watchedDuration(intervals.current) * 1000) / 1000;
    if (pending.current || seconds <= acknowledged.current || total <= 0) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await recordCourseProgress(orderItemId, {
        sessionId: sessionId.current, watchedSeconds: seconds,
        watchedRanges: intervals.current.map(([start, end]) => [start, end]),
        totalDurationSeconds: total,
      });
      acknowledged.current = seconds;
      // Only server-issued aggregates are presented as recorded progress.
      if (Number.isFinite(result?.watchedSeconds) && Number.isFinite(result?.totalDurationSeconds)) onRecorded(result);
      else setError("Progress was submitted. Refresh protected delivery to retrieve the recorded total.");
    } catch {
      setError("Viewing progress could not be saved. Keep this tab open and retry synchronisation.");
    } finally { pending.current = false; setBusy(false); }
  };
  syncRef.current = sync;
  useEffect(() => {
    const flush = () => { if (document.hidden) { previous.current = null; void syncRef.current?.(); } };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, []);
  const sample = (event) => {
    const video = event.currentTarget;
    const next = { position: video.currentTime, now: performance.now(), rate: video.playbackRate, paused: video.paused, seeking: video.seeking };
    intervals.current = samplePlayback(previous.current, next, intervals.current);
    previous.current = next;
    if (watchedDuration(intervals.current) - acknowledged.current >= 10) void sync();
  };
  const finishInterval = (event) => {
    const video = event.currentTarget;
    intervals.current = samplePlayback(previous.current, { position: video.currentTime, now: performance.now(), rate: video.playbackRate, paused: false, seeking: video.seeking }, intervals.current);
    previous.current = null; void sync();
  };
  return <section className="video-player">
    <b>Online video</b>
    {playbackUrl ? <video controls preload="metadata" src={playbackUrl} onTimeUpdate={sample}
      onPlay={sample} onSeeking={() => { previous.current = null; }} onSeeked={sample}
      onPause={finishInterval} onEnded={finishInterval} />
      : <p>The authorised player link is not available yet.</p>}
    <Progress value={total > 0 ? watched / total * 100 : 0} label="Server-recorded watched progress" />
    <small>{Math.round(watched)} of {Math.round(total)} seconds recorded. Seeking does not count as watching. The server verifies viewing intervals and decides the 10% refund condition.</small>
    {error && <p role="alert" className="form-error">{error}</p>}
    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void sync()}>{busy ? "Saving progress…" : "Sync viewing progress"}</Button>
  </section>;
}
