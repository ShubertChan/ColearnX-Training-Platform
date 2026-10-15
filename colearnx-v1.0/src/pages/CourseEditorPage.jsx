import { useTranslation } from "../i18n/LanguageContext";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { createCourse, submitCourse } from "../api/catalog";
import { courseAssetApi } from "../api/uploads";
import { usePlatform } from "../context/PlatformContext";
import CourseFilesUploader from "../components/uploads/CourseFilesUploader";
import { hostedVideoEnabled } from "../config/features";
import { canSubmitCourse } from "../utils/courseSubmission";
import { localDateTime } from "../utils/courseSchedule";
import PrivateAssetUploader from "../components/uploads/PrivateAssetUploader";
import { Button, Card, FormField } from "../components/ui";

const initial = { title: "", description: "", pricePoints: "", capacity: "", startsAt: "", endsAt: "", deliveryModes: hostedVideoEnabled ? ["cloud"] : ["live"], fulfilmentInstructions: "", trainerContact: "", joinUrl: "", onlineVideo: hostedVideoEnabled };
export default function CourseEditorPage() {
  const { t } = useTranslation();
  const { refreshMyListings, notify } = usePlatform();
  const [params, setParams] = useSearchParams();
  const requested = params.get("draft");
  const [form, setForm] = useState(initial), [draft, setDraft] = useState(null);
  const [files, setFiles] = useState({ readyCount: 0, activeCount: 0, unresolvedCount: 0, loading: true });
  const [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false), [error, setError] = useState("");
  const [video, setVideo] = useState({ ready: false, busy: true, error: false });
  const updateFiles = useCallback(setFiles, []);
  useEffect(() => {
    if (!requested || draft?.id === requested) return;
    let current = true; setBusy(true); setError("");
    refreshMyListings().then((items) => {
      if (!current) return;
      const item = items.find((row) => row.id === requested && row.kind === "course" && row.status === "Draft");
      if (!item) throw new Error("This course draft is unavailable. Return to My listings and choose an editable draft.");
      setForm({ ...initial, ...item, startsAt: localDateTime(item.startsAt), endsAt: localDateTime(item.endsAt), pricePoints: item.price }); setDraft({ id: item.id });
    }).catch((error) => { if (current) setError(error.message); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [requested, draft?.id, refreshMyListings]);
  const change = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const selectCourseType = (type) => setForm((current) => type === "video"
    ? { ...current, deliveryModes: ["cloud"], onlineVideo: true, joinUrl: "" }
    : { ...current, deliveryModes: ["live"], onlineVideo: false });
  const selectTeachingMode = (mode) => setForm((current) => ({ ...current, deliveryModes: [mode], onlineVideo: false }));
  const videoCourse = form.onlineVideo;
  const teachingMode = form.deliveryModes.includes("local") ? "local" : "live";
  const coordination = !videoCourse;
  const needsFile = form.deliveryModes.includes("cloud") && !form.onlineVideo;
  const canSubmit = Boolean(form.startsAt) && canSubmitCourse({ files, video, onlineVideo: form.onlineVideo, needsFile, videoEnabled: hostedVideoEnabled });
  const create = async (event) => {
    event.preventDefault(); setError("");
    const deliveryMode = videoCourse ? "cloud" : teachingMode;
    if (coordination && (!form.fulfilmentInstructions.trim() || !form.trainerContact.trim())) return setError("Enter a course announcement and Trainer contact details.");
    if (coordination && !form.startsAt) return setError("Enter a confirmed start time for this instructor-led course. It is required to calculate the 72-hour refund deadline.");
    if (videoCourse && !form.startsAt) return setError("Enter a start time for this video course. Learners cannot watch before it opens.");
    let joinUrl = null;
    if (teachingMode === "live" && form.joinUrl.trim()) {
      try { const url = new URL(form.joinUrl); if (!["http:", "https:"].includes(url.protocol)) throw Error(); joinUrl = url.href; }
      catch { return setError("Enter an HTTP or HTTPS meeting or group URL."); }
    }
    if (form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) return setError("End time must be after start time.");
    setBusy(true);
    try {
      const result = await createCourse({ title: form.title.trim(), description: form.description.trim(), pricePoints: Number(form.pricePoints), capacity: form.capacity ? Number(form.capacity) : null,
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null, endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null, timezone: "Asia/Singapore", deliveryModes: [deliveryMode],
        fulfilmentInstructions: coordination ? form.fulfilmentInstructions.trim() : null, trainerContact: coordination ? form.trainerContact.trim() : null, joinUrl: teachingMode === "live" ? joinUrl : null,
        progressTrackingType: videoCourse ? "online_video" : "none" });
      if (!result?.id) throw new Error("The service did not return a saved draft.");
      setDraft(result); setParams({ draft: result.id }, { replace: true });
      notify("Course draft saved. Complete any required course material before submitting.");
      void refreshMyListings().catch(() => notify("Draft saved. Refresh My listings later to synchronise."));
    } catch (error) { setError(error.message); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (busy || submitted || !canSubmit) return;
    setBusy(true); setError("");
    try {
      await submitCourse(draft.id); setSubmitted(true); notify("Course submitted for administrator review.");
      void refreshMyListings().catch(() => notify("Submission recorded. My listings will refresh later."));
    } catch (error) { setError(error.message); } finally { setBusy(false); }
  };
  return <div className="content-grid editor-layout"><Card>
    <h2>{draft ? t("Course draft") : t("Create course")}</h2>
    <form onSubmit={create} className="stack"><fieldset disabled={Boolean(draft) || busy || Boolean(requested)} className="editor-fields">
      <FormField label={t("Course title")}><input required maxLength={200} value={form.title} onChange={(e) => change("title", e.target.value)} /></FormField>
      <FormField label={t("Public description")}><textarea required value={form.description} onChange={(e) => change("description", e.target.value)} /></FormField>
      <FormField label={t("Price in points")}><input required min={0} step={1} type="number" value={form.pricePoints} onChange={(e) => change("pricePoints", e.target.value)} /></FormField>
      <fieldset className="delivery-mode-picker"><legend>{t("Course type")}</legend>
        <label className="delivery-mode-option"><input type="radio" name="course-type" checked={videoCourse} disabled={!hostedVideoEnabled} onChange={() => selectCourseType("video")} /><span><b>{t("Video course")}</b><small>{t("Upload one protected course video for learners to watch on the platform.")}</small></span></label>
        <label className="delivery-mode-option"><input type="radio" name="course-type" checked={!videoCourse} onChange={() => selectCourseType("teaching")} /><span><b>{t("Instructor-led course")}</b><small>{t("Teach learners live online or arrange an offline session directly.")}</small></span></label>
      </fieldset>
      {!hostedVideoEnabled && <small>{t("Video courses are not enabled for this deployment.")}</small>}
      {videoCourse ? <p className="editor-policy-note">{t("Upload a single main video after saving the draft. The service verifies its duration; the maximum is 4 hours.")}</p> : <>
        <fieldset className="delivery-mode-picker"><legend>{t("Teaching format")}</legend>
          <label className="delivery-mode-option"><input type="radio" name="teaching-format" checked={teachingMode === "live"} onChange={() => selectTeachingMode("live")} /><span><b>{t("Online — live session")}</b><small>{t("Share the live-session details with purchasers after payment.")}</small></span></label>
          <label className="delivery-mode-option"><input type="radio" name="teaching-format" checked={teachingMode === "local"} onChange={() => selectTeachingMode("local")} /><span><b>{t("Offline — arrange directly")}</b><small>{t("Share the venue and meeting arrangements with each learner after payment.")}</small></span></label>
        </fieldset>
        <FormField label={t("Course announcement for purchasers")}><textarea required value={form.fulfilmentInstructions} onChange={(e) => change("fulfilmentInstructions", e.target.value)} /></FormField><FormField label={t("Trainer contact for purchasers")}><input required value={form.trainerContact} onChange={(e) => change("trainerContact", e.target.value)} /></FormField>{teachingMode === "live" && <FormField label={t("Live-session link (optional)")}><input type="url" value={form.joinUrl} onChange={(e) => change("joinUrl", e.target.value)} /></FormField>}
      </>}
      <FormField label={t("Capacity (optional)")}><input min={1} type="number" value={form.capacity || ""} onChange={(e) => change("capacity", e.target.value)} /></FormField>
      <div className="form-grid two"><FormField label={t("Start time (required)")}><input type="datetime-local" required value={form.startsAt || ""} onChange={(e) => change("startsAt", e.target.value)} /></FormField><FormField label={t("End time (optional)")}><input type="datetime-local" value={form.endsAt || ""} onChange={(e) => change("endsAt", e.target.value)} /></FormField></div>
      {videoCourse && <p className="editor-policy-note">{t("Set when learners can start watching. Video playback remains locked until this time; dates use your device’s local time.")}</p>}
      {coordination && <p className="editor-policy-note">{t("Confirm the start time before saving an instructor-led course. It determines the 72-hour refund deadline for both online and offline sessions.")}</p>}
    </fieldset>{!draft && <Button type="submit" disabled={busy || Boolean(requested)}>{busy ? t("Saving…") : t("Create draft")}</Button>}</form>
    {error && <p role="alert" className="form-error">{t(error)}</p>}
    {draft && <>{form.onlineVideo
      ? hostedVideoEnabled ? <CourseFilesUploader key={draft.id} courseId={draft.id} onVideoChange={setVideo} onAssetsChange={updateFiles} disabled={submitted || busy} />
        : <p role="status">{t("Video uploads are not enabled for this deployment.")}</p>
      : <PrivateAssetUploader key={draft.id} contentVersionId={draft.id} assetApi={courseAssetApi} label={t("Course attachments")} onAssetsChange={updateFiles} disabled={submitted || busy} />}
      {!form.onlineVideo && <p>{t("Instructor-led courses show their course announcement only to purchasers.")}</p>}
      <Button disabled={busy || submitted || !canSubmit} onClick={() => void submit()}>{submitted ? t("Submitted for review") : busy ? t("Submitting…") : t("Submit for administrator review")}</Button>
      {submitted && <Button variant="secondary" onClick={() => { setDraft(null); setForm(initial); setSubmitted(false); setParams({}); }}>{t("Create another course")}</Button>}</>}
  </Card><Card><h3>{t("Private delivery")}</h3><p>{t("Video-course files are uploaded directly with a short-lived signed URL. The service must confirm each file before review is enabled.")}</p><p>{t("Instructor-led course announcements and contact details are separate from the public description and displayed only through protected purchase endpoints.")}</p><p>{t("Saved metadata can be revised in Publishing tools. No local change is presented as published until the service accepts it.")}</p></Card></div>;
}
