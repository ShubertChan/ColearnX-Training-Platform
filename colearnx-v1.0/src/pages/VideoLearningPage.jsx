import { getFormatLocale, useTranslation } from "../i18n/LanguageContext";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, Download, FileText, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { usePlatform } from "../context/PlatformContext";
import { getCourseDelivery, requestCourseDownloadUrl } from "../api/courseDelivery";
import { hostedVideoEnabled } from "../config/features";
import { confirmedProgress, isVideoAsset, videoProgressPercent } from "../utils/videoContract";
import CourseVideoPlayer from "../components/CourseVideoPlayer";
import { Button, Progress } from "../components/ui";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "../styles/video-learning.css";

gsap.registerPlugin(useGSAP, ScrollTrigger);
const dateLabel = value => new Date(value).toLocaleString(getFormatLocale(), { dateStyle: "medium", timeStyle: "short" });
const durationLabel = seconds => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

export default function VideoLearningPage() {
  const { t } = useTranslation();
  const progressSeconds = seconds => t(seconds === 1 ? "{seconds} second" : "{seconds} seconds", { seconds: Number(seconds.toFixed(3)) });
  const { orderItemId } = useParams();
  const { orders } = usePlatform();
  const item = orders.flatMap(order => order.items).find(row => row.id === orderItemId);
  const scope = useRef(null), generation = useRef(0), downloadGeneration = useRef(0);
  const [record, setRecord] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [downloading, setDownloading] = useState(""), [downloadError, setDownloadError] = useState("");
  const load = useCallback(async () => {
    const request = ++generation.current; setLoading(true); setError("");
    try {
      const data = await getCourseDelivery(orderItemId);
      if (!data.onlineVideo && data.progressTrackingType !== "online_video") throw new Error("This purchase is not a video course. Open its delivery from My Learning.");
      if (request === generation.current) setRecord(data);
    } catch (err) { if (request === generation.current) { setRecord(null); setError(err.message || "Could not load this purchased course."); } }
    finally { if (request === generation.current) setLoading(false); }
  }, [orderItemId]);
  useEffect(() => { setRecord(null); setDownloadError(""); setDownloading(""); void load(); return () => { generation.current++; downloadGeneration.current++; }; }, [load]);
  useEffect(() => {
    if (record?.playerState !== "scheduled") return;
    // The delay is derived from server time; the next response still decides access.
    const delay = Date.parse(record.startsAt) - Date.parse(record.serverTime);
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => void load(), Math.min(2147483647, Math.max(1000, delay + 250)));
    return () => clearTimeout(timer);
  }, [record, load]);
  useGSAP(() => {
    if (!record) return;
    const motion = gsap.matchMedia();
    motion.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from(".course-learning-info", { y: 12, opacity: 0, duration: 0.35, clearProps: "all" });
      gsap.from(".course-learning-overview p", { opacity: 0.65, duration: 0.4, scrollTrigger: { trigger: ".course-learning-overview", start: "top 95%", once: true }, clearProps: "all" });
    });
    return () => motion.revert();
  }, { scope, dependencies: [Boolean(record)], revertOnUpdate: true });
  const missingStart = record && !Number.isFinite(Date.parse(record.startsAt));
  const scheduled = record?.playerState === "scheduled";
  const progress = confirmedProgress(record);
  const percent = progress ? videoProgressPercent(progress) : null;
  const updateProgress = value => {
    const confirmed = confirmedProgress(value);
    if (confirmed) setRecord(current => current ? { ...current, progress: confirmed } : current);
  };
  const attachments = (record?.assets || []).filter(asset => !isVideoAsset(asset) && (!asset.status || asset.status === "ready"));
  const download = async asset => {
    const request = downloadGeneration.current;
    setDownloading(asset.assetId); setDownloadError("");
    try {
      const result = await requestCourseDownloadUrl(orderItemId, asset.assetId);
      if (request !== downloadGeneration.current) return;
      const url = new URL(result.downloadUrl);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error("The service returned an unsafe download link.");
      const link = document.createElement("a"); link.href = url.href; link.download = result.filename || asset.filename;
      link.target = "_blank"; link.rel = "noopener noreferrer"; document.body.appendChild(link); link.click(); link.remove();
    } catch (err) { if (request === downloadGeneration.current) setDownloadError(err.message || "Download unavailable. Try again."); }
    finally { if (request === downloadGeneration.current) setDownloading(""); }
  };
  return <div className="course-learning" ref={scope}>
    <nav className="course-learning-nav" aria-label={t("Course navigation")}><Link to="/purchases"><ArrowLeft size={16} />{t(" Back to My Learning")}</Link><Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw size={15} />{loading ? t("Refreshing…") : t("Refresh course")}</Button></nav>
    <header className="course-learning-header"><span className="course-learning-kicker">{t("Video course")}</span><h1>{record?.title || item?.title || t("Course learning")}</h1>{(record?.trainer || item?.trainer) && <p>{t("With ")}{record?.trainer || item.trainer}</p>}</header>
    {loading && !record && <div className="course-learning-notice" role="status">{t("Checking your purchase and course availability…")}</div>}
    {error && <div className="course-learning-notice" role="alert"><h2>{t("Course unavailable")}</h2><p>{t(error)}</p><Button variant="secondary" onClick={() => void load()}>{t("Try again")}</Button></div>}
    {record && <>
      <div className="course-learning-grid">
        <div className="course-learning-screen">
          {missingStart || record.playerState === "schedule_required" ? <div className="course-learning-locked"><LockKeyhole size={32} /><h2>{t("Start time not set")}</h2><p>{t("Your Trainer needs to set a start time before this course can be watched.")}</p></div>
            : scheduled ? <div className="course-learning-locked"><CalendarDays size={32} /><h2>{t("Your course opens soon")}</h2><p>{t("Available from ")}<time dateTime={record.startsAt}>{dateLabel(record.startsAt)}</time></p><small>{t("Times are shown in your local timezone. This page will check again when the course opens.")}</small></div>
            : hostedVideoEnabled ? <CourseVideoPlayer orderItemId={orderItemId} record={record} showHeading={false} showProgress={false} onRecorded={updateProgress} />
            : <div className="course-learning-locked"><h2>{t("Video temporarily unavailable")}</h2><p>{t("Playback is not enabled for this deployment.")}</p></div>}
        </div>
        <aside className="course-learning-info" aria-label={t("Your learning progress")}>
          <div className="course-learning-info-heading"><ShieldCheck size={18} /><span>{t("Purchased access")}</span></div>
          <h2>{t("Your progress")}</h2>
          {percent !== null ? <><strong className="course-learning-percent">{percent}<span>{t("% watched")}</span></strong><Progress value={percent} label={t("Server-confirmed unique viewing progress")} /><p>{progressSeconds(progress.uniqueContentWatchedSeconds)}{t(" of ")}{progressSeconds(progress.durationSeconds)}{t(" confirmed")}</p></> : <p>{t("Progress appears after the server confirms your viewing.")}</p>}
          <small>{t("Only unique viewing counts. Skipping ahead or replaying does not add duplicate progress.")}</small>
          {record.startsAt && <dl><dt>{t("Course opens")}</dt><dd><time dateTime={record.startsAt}>{dateLabel(record.startsAt)}</time></dd></dl>}
          {record.durationSeconds > 0 && <dl><dt>{t("Video length")}</dt><dd>{durationLabel(record.durationSeconds)}</dd></dl>}
        </aside>
      </div>
      <section className="course-learning-overview" aria-label={t("About this course")}><h2>{t("About this course")}</h2><p>{record.description || t("Watch the protected course video at your own pace after the course opens. Your confirmed viewing progress is saved automatically.")}</p></section>
      {attachments.length > 0 && <section className="course-learning-resources" aria-label={t("Course resources")}><h2>{t("Course resources")}</h2><p>{t("Downloading a protected attachment can affect refund eligibility. Review your purchase-time policy before downloading.")}</p>{attachments.map(asset => <div className="course-learning-resource" key={asset.assetId}><FileText size={20} /><span>{asset.filename}</span><Button variant="secondary" size="sm" disabled={Boolean(downloading)} onClick={() => void download(asset)}><Download size={15} />{downloading === asset.assetId ? t("Requesting…") : t("Download")}</Button></div>)}{downloadError && <p role="alert" className="form-error">{t(downloadError)}</p>}</section>}
      <footer className="course-learning-footer"><span>{t("Playback is purchase-authorised. Videos cannot be downloaded.")}</span>{item && <Link to={`/refund/${encodeURIComponent(item.productId)}?orderItem=${encodeURIComponent(orderItemId)}`}>{t("Review refund policy")}</Link>}</footer>
    </>}
  </div>;
}
