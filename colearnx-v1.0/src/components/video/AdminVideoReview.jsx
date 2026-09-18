import { useEffect, useState } from "react";
import { getCourseVideo } from "../../api/video";
import { videoError, MAX_VIDEO_SECONDS } from "../../utils/videoContract";
import { hostedVideoEnabled } from "../../config/features";
import CourseVideoPlayer from "../CourseVideoPlayer";
import VideoMetadata from "./VideoMetadata";
import { Button } from "../ui";

export default function AdminVideoReview({ item, busy, onDecision }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [reason, setReason] = useState("");
  const [attempt, setAttempt] = useState(0), [previewed, setPreviewed] = useState(null);
  const [reviewed, setReviewed] = useState(null);
  useEffect(() => {
    if (!hostedVideoEnabled) return;
    const abort = new AbortController(); let timer;
    const load = async () => {
      try { const result = await getCourseVideo(item.id, abort.signal); if (!abort.signal.aborted) { setData(result); setError(""); timer = setTimeout(load, 5000); } }
      catch (error) { if (!abort.signal.aborted) { setData(null); setError(videoError(error)); } }
    };
    void load(); return () => { abort.abort(); clearTimeout(timer); };
  }, [item.id, attempt]);
  const version = data?.versions.find(v => v.id === (item.reviewVideoVersionId || data.reviewVersionId));
  const stale = item.reviewVideoVersionId && data?.reviewVersionId && item.reviewVideoVersionId !== data.reviewVersionId;
  const ready = !stale && version?.status === "ready" && Number.isFinite(version.durationSeconds) && version.durationSeconds > 0 && version.durationSeconds <= MAX_VIDEO_SECONDS;
  return <section className="admin-video-review stack" aria-label="Course video review">
    {!hostedVideoEnabled ? <p>Video review is temporarily disabled.</p> : <><VideoMetadata version={version} />
      {error && <p role="alert" className="form-error">{error}</p>}
      {stale && <p role="alert" className="form-error">The submitted video version changed. Refresh the review queue before deciding.</p>}
      <div className="button-row"><Button type="button" variant="secondary" disabled={!ready || busy} onClick={() => setPreviewed(version.id)}>Preview ready video</Button>
        <Button type="button" variant="secondary" onClick={() => setAttempt(v => v + 1)}>Refresh video</Button></div>
      {ready && previewed === version.id && <CourseVideoPlayer key={version.id} previewCourseId={item.id} previewVersionId={version.id} onReady={setReviewed} />}</>}
    <label>Decision reason<input value={reason} onChange={e => setReason(e.target.value)} /></label>
    <div className="button-row"><Button disabled={busy || !ready || reviewed !== version?.id || reason.trim().length < 3} onClick={() => onDecision("published", reason.trim())}>Approve</Button>
      <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => onDecision("rejected", reason.trim())}>Reject</Button></div>
  </section>;
}
