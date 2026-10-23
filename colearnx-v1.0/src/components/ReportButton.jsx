import { useTranslation } from "../i18n/LanguageContext";
import { useState } from "react";
import { usePlatform } from "../context/PlatformContext";
import { submitReport, serviceMessage } from "../api/workflows";
import { Button, FormField, Modal } from "./ui";

export default function ReportButton({ kind, productId }) {
  const { t } = useTranslation();
  const { authenticated, canPurchase } = usePlatform();
  const [open, setOpen] = useState(false), [reason, setReason] = useState("");
  const [category, setCategory] = useState("misleading"), [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState(false), [requestKey, setRequestKey] = useState("");
  if (!authenticated || !canPurchase) return null;
  const send = async () => {
    setBusy(true); setError("");
    try { await submitReport({ kind, productId, category, reason: reason.trim() }, requestKey); setSuccess(true); }
    catch (error) { setError(serviceMessage(error)); } finally { setBusy(false); }
  };
  return <><Button variant="ghost" onClick={() => { setOpen(true); setSuccess(false); setError(""); setReason(""); setRequestKey(globalThis.crypto.randomUUID()); }}>{t("Report this ")}{kind === "course" ? t("course") : t("resource")}</Button>
    {open && <Modal title={t("Report marketplace item")} onClose={() => !busy && setOpen(false)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>{t("Close")}</Button>{!success && <Button disabled={busy || reason.trim().length < 10} onClick={() => void send()}>{busy ? t("Submitting…") : t("Submit report")}</Button>}</>}>
      {success ? <p role="status">{t("Your report has been received for review.")}</p> : <><p>{t("Describe the issue without including passwords or unnecessary personal information.")}</p><FormField label={t("Report category")}><select value={category} onChange={(e) => setCategory(e.target.value)}><option value="misleading">{t("Misleading information")}</option><option value="copyright">{t("Copyright or licence concern")}</option><option value="unsafe">{t("Unsafe or inappropriate material")}</option><option value="other">{t("Other issue")}</option></select></FormField><FormField label={t("What happened? (at least 10 characters)")}><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} /></FormField>{error && <p role="alert" className="form-error">{t(error)}</p>}</>}
    </Modal>}</>;
}
