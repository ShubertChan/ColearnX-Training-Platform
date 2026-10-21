import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { acknowledgeRefundNotification, getRefundNotifications } from "../api/notifications";
import { usePlatform } from "../context/PlatformContext";
import { useTranslation } from "../i18n/LanguageContext";
import { Button, Modal } from "./ui";

function AccountRefundNotice() {
  const { refreshWallet, refreshOrders } = usePlatform();
  const { t, formatLocale } = useTranslation();
  const navigate = useNavigate();
  const [notice, setNotice] = useState(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const acknowledgement = useRef(null);

  useEffect(() => () => acknowledgement.current?.abort(), []);

  useEffect(() => {
    let stopped = false, timer, request, generation = 0, failures = 0, showing = false;
    async function poll(wait = false) {
      const current = ++generation;
      request = new AbortController();
      try {
        const messages = await getRefundNotifications({ wait, signal: request.signal });
        if (stopped || current !== generation) return;
        failures = 0;
        if (messages.length) {
          showing = true;
          setNotice(messages[0]);
          // A refresh failure must not prevent delivery or acknowledge the notice.
          void Promise.allSettled([refreshWallet(), refreshOrders()]);
        } else {
          timer = setTimeout(() => poll(true), 250);
        }
      } catch {
        if (stopped || current !== generation) return;
        timer = setTimeout(() => poll(), Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)));
      }
    }
    const resume = () => {
      if (showing || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      request?.abort();
      void poll();
    };
    void poll(); // Read persisted decisions immediately after login, before waiting.
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [revision, refreshWallet, refreshOrders]);

  async function dismiss(viewOrder = false) {
    if (!notice || acknowledgement.current) return;
    const controller = new AbortController();
    acknowledgement.current = controller;
    setSaving(true);
    setError(false);
    try {
      await acknowledgeRefundNotification(notice.id, controller.signal);
      if (controller.signal.aborted) return;
      setNotice(null);
      setRevision(value => value + 1);
      if (viewOrder) navigate("/orders");
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        acknowledgement.current = null;
        setSaving(false);
      }
    }
  }

  if (!notice) return null;
  const approved = notice.status === "approved";
  return <Modal key={notice.id} title={approved ? t("Refund approved") : t("Refund rejected")} onClose={() => dismiss()}
    footer={<><Button variant="secondary" disabled={saving} onClick={() => dismiss(true)}>{t("View order")}</Button>
      <Button disabled={saving} onClick={() => dismiss()}>{saving ? t("Saving…") : t("Got it")}</Button></>}>
    <p><strong>{notice.itemTitle}</strong></p>
    <p>{approved
      ? t("Your refund of {points} points has been credited to your wallet.", { points: notice.points.toLocaleString(formatLocale) })
      : t("Your refund request was rejected. No points were refunded.")}</p>
    <p><strong>{t("Review reason")}</strong></p>
    <p className="refund-decision-reason">{notice.decisionReason}</p>
    {error && <p role="alert">{t("We could not save your confirmation. Please try again.")}</p>}
  </Modal>;
}

export default function RefundDecisionNotice() {
  const { authenticated, accountLoading, accountError, profile } = usePlatform();
  if (!authenticated || accountLoading || accountError || !profile?.id) return null;
  return <AccountRefundNotice key={profile.id} />;
}
