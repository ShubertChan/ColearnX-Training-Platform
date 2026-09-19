import { useCallback, useEffect, useState } from "react";
import { getVideoOperations, retryVideo } from "../../api/video";
import { videoError, JOB_STATUSES } from "../../utils/videoContract";
import { Button, Card } from "../ui";

export default function VideoOperations() {
  const [data, setData] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const refresh = useCallback(async signal => {
    try {
      const result = await getVideoOperations(signal);
      if (!Array.isArray(result.jobs) || result.jobs.some(job => !JOB_STATUSES.includes(job.status))) throw Error("Invalid operations contract");
      if (!signal?.aborted) { setData(result); setError(""); }
    } catch (error) { if (!signal?.aborted) setError(videoError(error)); }
  }, []);
  useEffect(() => { const abort = new AbortController(); void refresh(abort.signal); return () => abort.abort(); }, [refresh]);
  const retry = async job => {
    setBusy(true); setError("");
    try { await retryVideo(job.courseRunId, job.videoVersionId); await refresh(); } catch (error) { setError(videoError(error)); } finally { setBusy(false); }
  };
  return <Card><h3>Video processing operations</h3><Button variant="secondary" disabled={busy} onClick={() => void refresh()}>Refresh video operations</Button>
    {error && <p role="alert" className="form-error">{error}</p>}
    {data && <><dl className="receipt-details">{[["queued", "Queued jobs"], ["failed", "Failed jobs"], ["orphanCandidates", "Orphan candidates"], ["pendingCleanup", "Pending cleanup"]].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{data.counts?.[key] ?? "Not supplied"}</dd></div>)}</dl>
      <div className="responsive-table"><table><thead><tr><th>Video version</th><th>Job status</th><th>Last updated</th><th>Action</th></tr></thead><tbody>{data.jobs.map(job => <tr key={job.id}><td>{job.videoVersionId}</td><td>{job.status}</td><td>{job.updatedAt ? new Date(job.updatedAt).toLocaleString() : "Not supplied"}</td><td>{job.canRetry && ["retryable_failed", "dead"].includes(job.status) && <Button disabled={busy} variant="secondary" onClick={() => void retry(job)}>Retry processing</Button>}</td></tr>)}</tbody></table></div>
      <h4>Cleanup tasks</h4>{(data.cleanupTasks || []).map(task => <p key={task.id}>{task.id} · {task.status} · {task.reason}</p>)}{!data.cleanupTasks?.length && <p>No cleanup tasks returned.</p>}</>}
  </Card>;
}
