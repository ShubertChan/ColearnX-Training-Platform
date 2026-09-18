import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { decideTrainerCertification, getAdminTrainerCertifications } from "../api/governance";
import { useAdminInbox } from "../context/AdminInboxContext";
import { normalizePortfolioUrl } from "../utils/roleApplication";
import { Badge, Button, Card, EmptyState, FormField } from "../components/ui";

function Certification({ item, onDecision, busy }) {
  const [reason, setReason] = useState("");
  const evidenceUrl = normalizePortfolioUrl(item.evidenceUrl);
  return <Card><div className="card-heading"><div><span className="eyebrow">Trainer certification</span><h3>{item.trainer?.displayName || "Trainer"}</h3></div><Badge tone={item.status === "pending" ? "warning" : "neutral"}>{item.status}</Badge></div><dl className="detail-list"><div><dt>Certification</dt><dd>{item.certificationName || "Not supplied"}</dd></div><div><dt>Reference</dt><dd>{item.certificationReference || "Not supplied"}</dd></div><div><dt>Evidence</dt><dd>{evidenceUrl ? <a href={evidenceUrl} target="_blank" rel="noreferrer">Open certification evidence</a> : item.evidenceUrl || "Not supplied"}</dd></div></dl>{item.status === "pending" ? <><FormField label="Decision reason" hint="Required, at least 3 characters"><textarea aria-label={`Decision reason for certification ${item.id}`} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></FormField><div className="button-row"><Button disabled={busy || reason.trim().length < 3} onClick={() => onDecision(item.id, "approved", reason.trim())}>Approve certification</Button><Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => onDecision(item.id, "rejected", reason.trim())}>Reject certification</Button></div></> : <p className="muted">{item.reviewComment || "This request has been reviewed."}</p>}</Card>;
}

export default function AdminCertificationsPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("request");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const { refresh } = useAdminInbox();
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    getAdminTrainerCertifications().then((data) => { if (active) setItems(data); })
      .catch((failure) => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  const decide = async (id, decision, reason) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await decideTrainerCertification(id, { decision, reason });
      setItems((current) => current.map((item) => item.id === id ? { ...item, status: decision, reviewComment: reason } : item));
      void refresh();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const visible = selectedId ? items.filter((item) => item.id === selectedId) : items;
  return <div className="stack"><Card><div className="card-heading"><h2>Certification review</h2><div className="button-row">{selectedId && <Button variant="secondary" onClick={() => setParams({})}>All certifications</Button>}<Button variant="secondary" disabled={loading || busy} onClick={() => setRevision((value) => value + 1)}>Refresh certifications</Button></div></div>{error && <p className="form-error" role="alert">{error}</p>}</Card>{loading ? <p role="status">Loading certifications…</p> : visible.length ? visible.map((item) => <Certification key={item.id} item={item} busy={busy} onDecision={decide} />) : <EmptyState icon={ShieldCheck} title={selectedId ? "Certification unavailable" : "No trainer certifications"} description={selectedId ? "This request could not be found. Refresh or return to all certifications." : "Submitted Trainer certifications will appear here."} />}</div>;
}
