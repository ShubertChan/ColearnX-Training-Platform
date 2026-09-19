import { useCallback, useEffect, useRef, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { abortVideoParts, createVideoUpload, deleteVideo, getCourseVideo, retryVideo } from "../../api/video";
import { canSubmitVideo, videoError } from "../../utils/videoContract";
import { identifyVideoFile, readUpload, sameVideoFile, saveUpload, uploadStorage, uploadStorageKey, uploadVideo } from "../../utils/videoUpload";
import { Button, Modal, Progress } from "../ui";
import VideoMetadata from "../video/VideoMetadata";

export default function CourseVideoUploader(props) {
  const { profile } = usePlatform();
  return <VideoUploadForm key={uploadStorageKey(profile.id, props.courseId)} {...props} accountId={profile.id} />;
}
function VideoUploadForm({ courseId, accountId, disabled = false, onStateChange }) {
  const storageKey = uploadStorageKey(accountId, courseId);
  const [saved, setSaved] = useState(() => readUpload(uploadStorage(), storageKey));
  const [summary, setSummary] = useState(null), [error, setError] = useState("");
  const [loadError, setLoadError] = useState(""), [storageWarning, setStorageWarning] = useState(false);
  const [loading, setLoading] = useState(true), [active, setActive] = useState(false), [mutation, setMutation] = useState(false);
  const [percent, setPercent] = useState(0), [file, setFile] = useState(null), [replacement, setReplacement] = useState(null);
  const controller = useRef(null), alive = useRef(false), revision = useRef(0), request = useRef(null);
  const persist = useCallback(value => {
    const stored = saveUpload(uploadStorage(), storageKey, value);
    if (alive.current) { setSaved(value); setStorageWarning(!stored); }
  }, [storageKey]);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    request.current?.abort(); request.current = new AbortController();
    try { const value = await getCourseVideo(courseId, request.current.signal); if (alive.current && current === revision.current) { setSummary(value); setLoadError(""); } }
    catch (error) { if (alive.current && current === revision.current && !request.current.signal.aborted) { setLoadError(videoError(error)); setSummary(null); } }
    finally { if (alive.current && current === revision.current) setLoading(false); }
  }, [courseId]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; revision.current++; controller.current?.abort(); request.current?.abort(); }; }, [refresh]);
  useEffect(() => {
    if (!summary?.versions.some(v => ["upload_pending", "queued", "transcoding", "delete_pending"].includes(v.status))) return;
    const timer = setTimeout(() => void refresh(), 5000); return () => clearTimeout(timer);
  }, [summary, refresh]);
  useEffect(() => { onStateChange?.({ ready: canSubmitVideo(summary), busy: active || mutation || loading || Boolean(saved), error: Boolean(error || loadError), summary }); }, [summary, active, mutation, loading, saved, error, loadError, onStateChange]);
  useEffect(() => {
    const version = summary?.versions.find(v => v.id === saved?.versionId);
    if (!active && saved && version && ["queued", "transcoding", "ready", "failed", "superseded", "deleted"].includes(version.status)) {
      persist(null); setFile(null); setError("");
    }
  }, [summary, saved, active, persist]);
  const start = async (chosen, resume = saved) => {
    if (controller.current || disabled) return;
    const abort = new AbortController(); controller.current = abort; setActive(true); setError(""); setFile(chosen);
    try {
      const metadata = await identifyVideoFile(chosen);
      if (abort.signal.aborted) return;
      if (resume && !sameVideoFile(resume.file, metadata)) { setError("Choose the exact original file to resume, or cancel the previous upload."); return; }
      const next = resume || { requestKey: crypto.randomUUID(), file: metadata };
      persist(next);
      await uploadVideo({ courseId, file: chosen, saved: next, signal: abort.signal, onSaved: persist, onProgress: p => { if (alive.current) setPercent(p); } });
      persist(null); if (alive.current) { setFile(null); await refresh(); }
    } catch (error) { if (alive.current && !abort.signal.aborted) setError(videoError(error)); }
    finally { controller.current = null; if (alive.current) setActive(false); }
  };
  const choose = event => {
    const chosen = event.target.files?.[0]; event.target.value = "";
    if (!chosen || active || disabled) return;
    if (!saved && summary?.versions.some(v => v.status === "ready" || v.status === "superseded")) setReplacement(chosen);
    else void start(chosen);
  };
  const mutate = async action => {
    setMutation(true); setError("");
    try { await action(); await refresh(); } catch (error) { if (alive.current) setError(videoError(error)); }
    finally { if (alive.current) setMutation(false); }
  };
  const cancel = () => void mutate(async () => {
    if (saved?.versionId) await abortVideoParts(courseId, saved.versionId);
    // An uncertain intent creation must be resolved with its same key before cancellation.
    else if (saved) { const intent = await createVideoUpload(courseId, { name: saved.file.name, type: saved.file.mediaType, size: saved.file.size }, saved.requestKey); await abortVideoParts(courseId, intent.videoVersionId); }
    persist(null); setFile(null); setPercent(0);
  });
  const blocked = disabled || mutation || loading;
  return <section className="course-video-uploader stack" aria-label="Course video upload">
    <div><h3>Main course video</h3><p>Upload one video, up to 4 hours. Duration is verified after processing. Course attachments are managed separately.</p></div>
    {loading && <p role="status">Loading video versions…</p>}
    {(summary?.canUpload || saved) && <label className="video-file-picker">{saved ? "Choose original video to resume" : "Choose course video"}<input type="file" accept="video/*,.mkv,.mov" disabled={blocked || active} onChange={choose} /></label>}
    {saved && <div><p>{saved.file.name} · {active ? "Uploading" : "Upload paused. Select the original file to continue after reopening this page."}</p><Progress value={percent} label="Video upload" />
      <div className="button-row">{active ? <Button type="button" variant="secondary" onClick={() => controller.current?.abort()}>Pause upload</Button> : <>
        {file && <Button type="button" disabled={blocked} onClick={() => void start(file)}>Resume upload</Button>}
        <Button type="button" variant="danger" disabled={blocked} onClick={cancel}>Cancel upload</Button></>}</div></div>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {loadError && <p role="alert" className="form-error">{loadError}</p>}
    {storageWarning && saved && <p role="status">Browser storage is unavailable. Keep this tab open to pause and resume this upload.</p>}
    <Button type="button" variant="secondary" disabled={active || mutation || disabled} onClick={() => void refresh()}>Refresh video status</Button>
    {summary?.versions.filter(v => v.status !== "deleted").map(v => <article className="video-version" key={v.id}><VideoMetadata version={v} />
      <div className="button-row">{v.canRetry && v.status === "failed" && <Button type="button" variant="secondary" disabled={blocked || active} onClick={() => void mutate(() => retryVideo(courseId, v.id))}>Retry processing</Button>}
        {v.canDelete && !v.hasOrderReferences && <Button type="button" variant="danger" disabled={blocked || active} onClick={() => { if (window.confirm("Delete this unused video version?")) void mutate(() => deleteVideo(courseId, v.id)); }}>Delete unused version</Button>}</div></article>)}
    {summary && !summary.versions.length && <p>No video has been uploaded yet.</p>}
    {summary?.versions.some(v => v.status === "queued") && <p>Waiting for processing. You can leave this page and return later.</p>}
    {replacement && <Modal title="Replace course video" onClose={() => setReplacement(null)} footer={<><Button type="button" variant="secondary" onClick={() => setReplacement(null)}>Cancel</Button><Button type="button" onClick={() => { const next = replacement; setReplacement(null); void start(next, null); }}>Upload new version</Button></>}>
      <p>{replacement.name}</p><p>The new version must finish processing and be reviewed. It applies to future purchases after publication. Existing buyers keep their purchased version.</p></Modal>}
  </section>;
}
