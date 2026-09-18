import { confirmedProgress } from "../../utils/videoContract";

export default function VideoEvidence({ evidence }) {
  const progress = confirmedProgress(evidence);
  const eligibility = evidence?.refundEligibility || evidence?.eligibility;
  return <section className="video-evidence" aria-label="Server refund evidence"><b>Recorded refund evidence</b>
    <dl className="receipt-details">
      <div><dt>Purchased video version</dt><dd>{evidence?.videoVersionId || evidence?.courseVideoVersionId || evidence?.video?.id || "Not supplied"}</dd></div>
      <div><dt>Verified duration</dt><dd>{progress ? `${progress.durationSeconds} seconds` : "Not supplied"}</dd></div>
      <div><dt>Unique content watched</dt><dd>{progress ? `${progress.uniqueContentWatchedSeconds} seconds` : "Not supplied"}</dd></div>
      <div><dt>Recorded viewing ratio</dt><dd>{progress ? `${(progress.watchedRatio * 100).toFixed(3)}% (display rounded)` : "Not supplied"}</dd></div>
      <div><dt>Protected attachment downloads</dt><dd>{typeof evidence?.hasProtectedAttachmentDownload === "boolean" ? evidence.hasProtectedAttachmentDownload ? "Downloaded" : "No recorded download" : "Not supplied"}</dd></div>
      <div><dt>Refund eligibility</dt><dd>{eligibility?.eligible === true ? "Eligible" : eligibility?.eligible === false ? "Not eligible" : "Awaiting server decision"}</dd></div>
      <div><dt>Eligibility code</dt><dd>{eligibility?.code || "Not supplied"}</dd></div>
    </dl>{eligibility?.explanation && <p>{eligibility.explanation}</p>}
    <small>Only the service decides eligibility, using unrounded viewing evidence and protected attachment downloads.</small>
  </section>;
}
