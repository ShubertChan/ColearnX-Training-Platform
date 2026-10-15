import { useTranslation } from "../../i18n/LanguageContext";
import { Badge } from "../ui";
import { formatVideoDuration, MAX_VIDEO_SECONDS, mediaUrl, VIDEO_STATUS_LABELS, videoError } from "../../utils/videoContract";

export default function VideoMetadata({ version }) {
  const { t } = useTranslation();
  if (!version) return <p>{t("No video version has been uploaded.")}</p>;
  const thumbnail = version.thumbnailUrl && mediaUrl(version.thumbnailUrl);
  return <div className="video-metadata">
    {thumbnail && <img src={thumbnail} alt={t("Video version {0} thumbnail", { 0: version.versionNo })} referrerPolicy="no-referrer" />}
    <div><div className="badge-row"><b>{t("Version ")}{version.versionNo}</b><Badge tone={version.status === "ready" ? "success" : version.status === "failed" ? "danger" : "warning"}>{t(VIDEO_STATUS_LABELS[version.status])}</Badge>{version.isCurrent && <Badge>{t("Current for new orders")}</Badge>}</div>
      <p>{t(formatVideoDuration(version.durationSeconds))}{version.width && version.height ? ` · ${version.width} × ${version.height}` : ""}</p>
      {Number.isFinite(version.durationSeconds) && version.durationSeconds > 0 && <small>{version.durationSeconds <= MAX_VIDEO_SECONDS ? t("Verified duration is within the 4-hour limit.") : t("Exceeds the 4-hour limit and cannot be submitted.")}</small>}
      {version.errorCode && <p role="alert" className="form-error">{t(videoError({ code: version.errorCode }))}</p>}
      {version.hasOrderReferences && <small>{t("Retained for existing purchases. Deletion is unavailable.")}</small>}
    </div>
  </div>;
}
