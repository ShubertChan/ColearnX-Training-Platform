import { useState } from "react";
import { usePlatform } from "../context/PlatformContext";
import { submitReport, serviceMessage } from "../api/workflows";
import { Button, FormField, Modal } from "./ui";

export default function ReportButton({ kind, productId }) {
  const { canPurchase } = usePlatform();
  const [open, setOpen] = useState(false), [reason, setReason] = useState("");
  const [category, setCategory] = useState("misleading"), [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState(false);
  if (!canPurchase) return null;
  const send = async () => {
    setBusy(true); setError("");
    try { await submitReport({ kind, productId, category, reason: reason.trim() }); setSuccess(true); }
    catch (error) { setError(serviceMessage(error)); } finally { setBusy(false); }
  };
  return <><Button variant="ghost" onClick={() => { setOpen(true); setSuccess(false); setError(""); setReason(""); }}>Report this {kind === "course" ? "course" : "resource"}</Button>
    {open && <Modal title="Report marketplace item" onClose={() => !busy && setOpen(false)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Close</Button>{!success && <Button disabled={busy || reason.trim().length < 10} onClick={() => void send()}>{busy ? "Submitting…" : "Submit report"}</Button>}</>}>
      {success ? <p role="status">Your report has been received for review.</p> : <><p>Describe the issue without including passwords or unnecessary personal information.</p><FormField label="Report category"><select value={category} onChange={(e) => setCategory(e.target.value)}><option value="misleading">Misleading information</option><option value="copyright">Copyright or licence concern</option><option value="unsafe">Unsafe or inappropriate material</option><option value="other">Other issue</option></select></FormField><FormField label="What happened? (at least 10 characters)"><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} /></FormField>{error && <p role="alert" className="form-error">{error}</p>}</>}
    </Modal>}</>;
}
