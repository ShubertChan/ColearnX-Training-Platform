import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { createCourse, submitCourse } from "../api/catalog";
import { courseAssetApi } from "../api/uploads";
import { usePlatform } from "../context/PlatformContext";
import CourseVideoUploader from "../components/uploads/CourseVideoUploader";
import { hostedVideoEnabled } from "../config/features";
import { canSubmitCourse } from "../utils/courseSubmission";
import PrivateAssetUploader from "../components/uploads/PrivateAssetUploader";
import { Button, Card, FormField } from "../components/ui";

const initial = { title: "", description: "", pricePoints: "", capacity: "", startsAt: "", endsAt: "", deliveryModes: ["cloud"], fulfilmentInstructions: "", trainerContact: "", joinUrl: "", onlineVideo: false };
export default function CourseEditorPage() {
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
      setForm({ ...initial, ...item, pricePoints: item.price }); setDraft({ id: item.id });
    }).catch((error) => { if (current) setError(error.message); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [requested, draft?.id, refreshMyListings]);
  const change = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const coordination = form.deliveryModes.some((mode) => ["local", "live"].includes(mode));
  const needsFile = form.deliveryModes.includes("cloud") && !form.onlineVideo;
  const canSubmit = canSubmitCourse({ files, video, onlineVideo: form.onlineVideo, needsFile, videoEnabled: hostedVideoEnabled });
  const create = async (event) => {
    event.preventDefault(); setError("");
    if (!form.deliveryModes.length) return setError("Select at least one delivery method.");
    if (coordination && (!form.fulfilmentInstructions.trim() || !form.trainerContact.trim())) return setError("Enter buyer-only instructions and Trainer contact details.");
    let joinUrl = null;
    if (form.joinUrl.trim()) {
      try { const url = new URL(form.joinUrl); if (!["http:", "https:"].includes(url.protocol)) throw Error(); joinUrl = url.href; }
      catch { return setError("Enter an HTTP or HTTPS meeting or group URL."); }
    }
    if (form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) return setError("End time must be after start time.");
    setBusy(true);
    try {
      const result = await createCourse({ title: form.title.trim(), description: form.description.trim(), pricePoints: Number(form.pricePoints), capacity: form.capacity ? Number(form.capacity) : null,
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null, endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null, timezone: "Asia/Singapore", deliveryModes: form.deliveryModes,
        fulfilmentInstructions: coordination ? form.fulfilmentInstructions.trim() : null, trainerContact: coordination ? form.trainerContact.trim() : null, joinUrl: coordination ? joinUrl : null,
        progressTrackingType: form.onlineVideo ? "online_video" : "none" });
      if (!result?.id) throw new Error("The service did not return a saved draft.");
      setDraft(result); setParams({ draft: result.id }, { replace: true });
      notify("Course draft saved. Add the required private files before submitting.");
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
    <h2>{draft ? "Course draft" : "Create course"}</h2>
    <form onSubmit={create} className="stack"><fieldset disabled={Boolean(draft) || busy || Boolean(requested)} className="editor-fields">
      <FormField label="Course title"><input required maxLength={200} value={form.title} onChange={(e) => change("title", e.target.value)} /></FormField>
      <FormField label="Public description"><textarea required value={form.description} onChange={(e) => change("description", e.target.value)} /></FormField>
      <FormField label="Price in points"><input required min={0} step={1} type="number" value={form.pricePoints} onChange={(e) => change("pricePoints", e.target.value)} /></FormField>
      <fieldset className="delivery-mode-picker"><legend>Delivery modes</legend>{[["cloud", "Cloud: protected download"], ["local", "Local: arrange with learner"], ["live", "Live: arrange the session"]].map(([mode, label]) => <label key={mode} className="check-label"><input type="checkbox" checked={form.deliveryModes.includes(mode)} onChange={() => change("deliveryModes", form.deliveryModes.includes(mode) ? form.deliveryModes.filter((value) => value !== mode) : [...form.deliveryModes, mode])} />{label}</label>)}</fieldset>
      {coordination && <><FormField label="Buyer-only fulfilment instructions"><textarea required value={form.fulfilmentInstructions} onChange={(e) => change("fulfilmentInstructions", e.target.value)} /></FormField><FormField label="Trainer contact for purchasers"><input required value={form.trainerContact} onChange={(e) => change("trainerContact", e.target.value)} /></FormField><FormField label="Meeting or group link (optional)"><input type="url" value={form.joinUrl} onChange={(e) => change("joinUrl", e.target.value)} /></FormField></>}
      <label className="check-label"><input type="checkbox" disabled={!hostedVideoEnabled} checked={form.onlineVideo} onChange={(e) => change("onlineVideo", e.target.checked)} />Includes platform-hosted online video</label>
      {form.onlineVideo && <p>Upload a single main video after saving the draft. The service verifies its duration; the maximum is 4 hours.</p>}{!hostedVideoEnabled && <small>Online video is not enabled for this deployment.</small>}
      <FormField label="Capacity (optional)"><input min={1} type="number" value={form.capacity || ""} onChange={(e) => change("capacity", e.target.value)} /></FormField>
      <div className="form-grid two"><FormField label="Start time (optional)"><input type="datetime-local" value={form.startsAt || ""} onChange={(e) => change("startsAt", e.target.value)} /></FormField><FormField label="End time (optional)"><input type="datetime-local" value={form.endsAt || ""} onChange={(e) => change("endsAt", e.target.value)} /></FormField></div>
    </fieldset>{!draft && <Button type="submit" disabled={busy || Boolean(requested)}>{busy ? "Saving…" : "Create draft"}</Button>}</form>
    {error && <p role="alert" className="form-error">{error}</p>}
    {draft && <>{form.onlineVideo && hostedVideoEnabled && <CourseVideoUploader key={`video:${draft.id}`} courseId={draft.id} onStateChange={setVideo} disabled={submitted || busy} />}<PrivateAssetUploader key={draft.id} contentVersionId={draft.id} assetApi={courseAssetApi} label="Course attachments" onAssetsChange={updateFiles} disabled={submitted || busy} />
      <p>Video courses require a processed, ready main video. Attachments are optional for video courses and remain separate. Cloud courses without video require a verified attachment.</p>
      <Button disabled={busy || submitted || !canSubmit} onClick={() => void submit()}>{submitted ? "Submitted for review" : busy ? "Submitting…" : "Submit for administrator review"}</Button>
      {submitted && <Button variant="secondary" onClick={() => { setDraft(null); setForm(initial); setSubmitted(false); setParams({}); }}>Create another course</Button>}</>}
  </Card><Card><h3>Private delivery</h3><p>Cloud files are uploaded directly with a short-lived signed URL. The service must confirm each file before review is enabled.</p><p>Local and Live instructions are sent separately from the public description and displayed only through protected purchase endpoints.</p><p>Saved metadata can be revised in Publishing tools. No local change is presented as published until the service accepts it.</p></Card></div>;
}
