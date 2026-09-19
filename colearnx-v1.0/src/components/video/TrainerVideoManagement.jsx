import { useCallback, useEffect, useRef, useState } from "react";
import { submitCourse } from "../../api/catalog";
import { courseAssetApi } from "../../api/uploads";
import { attachmentInventory, canSubmitCourse } from "../../utils/courseSubmission";
import { Button, Card } from "../ui";
import CourseVideoUploader from "../uploads/CourseVideoUploader";

export default function TrainerVideoManagement({ courseId }) {
  const [video, setVideo] = useState({ ready: false, busy: true }), [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false), [error, setError] = useState("");
  const [files, setFiles] = useState({ loading: true });
  const revision = useRef(0);
  const refreshFiles = useCallback(async () => {
    const current = ++revision.current;
    setFiles({ loading: true });
    try {
      const inventory = attachmentInventory(await courseAssetApi.list(courseId));
      if (current !== revision.current) return null;
      setFiles(inventory); return inventory;
    } catch {
      if (current === revision.current) setFiles({ loading: false, error: true });
      return null;
    }
  }, [courseId]);
  useEffect(() => { void refreshFiles(); return () => { revision.current++; }; }, [refreshFiles]);
  const allowed = inventory => canSubmitCourse({ files: inventory, video, onlineVideo: true, videoEnabled: true });
  const submit = async () => {
    if (busy || submitted || !allowed(files)) return;
    setBusy(true); setError("");
    try {
      if (!allowed(await refreshFiles())) return;
      await submitCourse(courseId); setSubmitted(true);
    } catch (error) { setError(error.message); } finally { setBusy(false); }
  };
  return <Card><CourseVideoUploader courseId={courseId} disabled={busy || submitted} onStateChange={setVideo} />
    <p>New video versions require review. Existing orders remain bound to their purchased video.</p>
    {files.loading && <p role="status">Checking course attachments…</p>}
    {files.error && <p role="alert">Course attachments could not be checked. Refresh attachments before submitting.</p>}
    {files.unresolvedCount > 0 && <p role="alert">Course attachments are not ready. Finish or remove incomplete uploads in the course editor before submitting.</p>}
    <Button variant="secondary" disabled={busy || submitted || files.loading} onClick={() => void refreshFiles()}>Refresh attachments</Button>
    {error && <p role="alert" className="form-error">{error}</p>}
    <Button disabled={!allowed(files) || busy || submitted} onClick={() => void submit()}>{submitted ? "Submitted for review" : "Submit video version for review"}</Button>
  </Card>;
}
