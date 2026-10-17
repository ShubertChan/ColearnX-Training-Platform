import { useTranslation } from "../../i18n/LanguageContext";
import { confirmedProgress } from "../../utils/videoContract";

export default function VideoEvidence({ evidence }) {
  const { t } = useTranslation();
  const progress = confirmedProgress(evidence);
  const eligibility = evidence?.refundEligibility || evidence?.eligibility;
  return <section className="video-evidence" aria-label={t("Server refund evidence")}><b>{t("Recorded refund evidence")}</b>
    <dl className="receipt-details">
      <div><dt>{t("Purchased video version")}</dt><dd>{evidence?.videoVersionId || evidence?.courseVideoVersionId || evidence?.video?.id || t("Not supplied")}</dd></div>
      <div><dt>{t("Verified duration")}</dt><dd>{progress ? t("{0} seconds", { 0: progress.durationSeconds }) : t("Not supplied")}</dd></div>
      <div><dt>{t("Unique content watched")}</dt><dd>{progress ? t("{0} seconds", { 0: progress.uniqueContentWatchedSeconds }) : t("Not supplied")}</dd></div>
      <div><dt>{t("Recorded viewing ratio")}</dt><dd>{progress ? t("{0}% (display rounded)", { 0: (progress.watchedRatio * 100).toFixed(3) }) : t("Not supplied")}</dd></div>
      <div><dt>{t("Protected attachment downloads")}</dt><dd>{typeof evidence?.hasProtectedAttachmentDownload === "boolean" ? evidence.hasProtectedAttachmentDownload ? t("Downloaded") : t("No recorded download") : t("Not supplied")}</dd></div>
      <div><dt>{t("Refund eligibility")}</dt><dd>{eligibility?.eligible === true ? t("Eligible") : eligibility?.eligible === false ? t("Not eligible") : t("Awaiting server decision")}</dd></div>
      <div><dt>{t("Eligibility code")}</dt><dd>{eligibility?.code || t("Not supplied")}</dd></div>
    </dl>{eligibility?.explanation && <p>{t(eligibility.explanation)}</p>}
    <small>{t("Only the service decides eligibility, using unrounded viewing evidence and protected attachment downloads.")}</small>
  </section>;
}
