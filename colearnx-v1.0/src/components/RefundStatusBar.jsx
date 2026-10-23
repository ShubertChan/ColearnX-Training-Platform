import { useTranslation } from "../i18n/LanguageContext";
import { refundStatus } from "../utils/refundStatus";
import { Badge } from "./ui";

export default function RefundStatusBar({ item, showEmpty = false }) {
  const { t } = useTranslation();
  const state = refundStatus(item);
  if (!state && !showEmpty) return null;
  return <div className="refund-status-bar" role="status" data-state={state?.code || "none"}>
    <div className="refund-status-heading"><span>{t("Refund status")}</span><Badge tone={state?.tone || "neutral"}>{t(state?.label || "No refund requested")}</Badge></div>
    <p>{t(state?.description || "No refund request has been submitted for this purchase.")}</p>
    {state?.record?.decisionReason && <p className="refund-status-reason"><strong>{t("Review reason")}: </strong>{state.record.decisionReason}</p>}
  </div>;
}
