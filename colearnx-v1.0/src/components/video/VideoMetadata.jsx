import { Badge } from "../ui";
import { formatVideoDuration, MAX_VIDEO_SECONDS, mediaUrl, VIDEO_STATUS_LABELS, videoError } from "../../utils/videoContract";

export default function VideoMetadata({ version }) {
  if (!version) return <p>No video version has been uploaded.</p>;
  const thumbnail = version.thumbnailUrl && mediaUrl(version.thumbnailUrl);
  return <div className="video-metadata">
    {thumbnail && <img src={thumbnail} alt={`Video version ${version.versionNo} thumbnail`} referrerPolicy="no-referrer" />}
    <div><div className="badge-row"><b>Version {version.versionNo}</b><Badge tone={version.status === "ready" ? "success" : version.status === "failed" ? "danger" : "warning"}>{VIDEO_STATUS_LABELS[version.status]}</Badge>{version.isCurrent && <Badge>Current for new orders</Badge>}</div>
      <p>{formatVideoDuration(version.durationSeconds)}{version.width && version.height ? ` · ${version.width} × ${version.height}` : ""}</p>
      {Number.isFinite(version.durationSeconds) && version.durationSeconds > 0 && <small>{version.durationSeconds <= MAX_VIDEO_SECONDS ? "Verified duration is within the 4-hour limit." : "Exceeds the 4-hour limit and cannot be submitted."}</small>}
      {version.errorCode && <p role="alert" className="form-error">{videoError({ code: version.errorCode })}</p>}
      {version.hasOrderReferences && <small>Retained for existing purchases. Deletion is unavailable.</small>}
    </div>
  </div>;
}
