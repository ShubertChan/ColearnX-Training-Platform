import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  BookOpen,
  FileText,
  GraduationCap,
  Send,
  ShieldCheck,
} from "lucide-react";
import { usePlatform } from "../context/PlatformContext";
import { Link, useSearchParams } from "react-router-dom";
import { contentDraftFromListing, isEditableContentDraft } from "../utils/contentDraft";
import { createContent, submitContent } from "../api/catalog";
import PrivateAssetUploader from "../components/uploads/PrivateAssetUploader";
import { Badge, Button, Card, EmptyState, FormField } from "../components/ui";

const roleCopy = {
  Trainer: {
    description: "Create courses after your application and trainer certification are approved.",
  },
  Creator: {
    description: "Create digital-content metadata and submit it for catalogue review.",
  },
};

function normalizePortfolioUrl(value) {
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    const normalized = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (normalized.protocol !== "http:" && normalized.protocol !== "https:") return null;
    return normalized.toString();
  } catch {
    return null;
  }
}

function ServerStatus({ value }) {
  const tone = value === "Approved" || value === "Published" ? "success" : value === "Rejected" ? "danger" : "warning";
  return <Badge tone={tone}>{value}</Badge>;
}

function RoleApplicationCard({ type, status, onSubmit }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ category: "", portfolio: "", experience: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    const portfolio = normalizePortfolioUrl(form.portfolio);
    if (portfolio === null) {
      setError("Enter a valid portfolio URL, for example https://example.com or www.example.com.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ ...form, portfolio });
      setOpen(false);
    } catch (submissionError) {
      setError(submissionError.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="application-card">
      <header>
        <span className={`application-icon ${type === "Creator" ? "creator" : ""}`}>
          {type === "Trainer" ? <GraduationCap size={23} /> : <FileText size={23} />}
        </span>
        <div>
          <div className="badge-row"><ServerStatus value={status} /></div>
          <h3>{type}</h3>
          <p>{roleCopy[type].description}</p>
        </div>
      </header>
      {status === "Not applied" || status === "Rejected" ? (
        <Button variant="secondary" onClick={() => setOpen((value) => !value)}>
          {open ? "Cancel" : `Apply for ${type}`}
        </Button>
      ) : null}
      {open && (
        <form className="application-form" onSubmit={submit}>
          <p className="muted">Complete the three required fields below. A portfolio link is optional and accepts either a full URL or a www. address.</p>
          <FormField label="Subject category *">
            <input required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
          </FormField>
          <FormField label="Portfolio or professional profile URL (optional)">
            <input type="text" inputMode="url" autoComplete="url" placeholder="https://example.com or www.example.com" value={form.portfolio} onChange={(event) => setForm({ ...form, portfolio: event.target.value })} />
          </FormField>
          <FormField label="Relevant experience *">
            <textarea required value={form.experience} onChange={(event) => setForm({ ...form, experience: event.target.value })} />
          </FormField>
          <FormField label="Why are you applying? *">
            <textarea required value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
          </FormField>
          {error && <p className="form-error">{error}</p>}
          <Button disabled={busy} type="submit">
            <Send size={16} /> {busy ? "Submitting…" : "Submit application"}
          </Button>
        </form>
      )}
    </Card>
  );
}

export function RoleApplicationPage() {
  const {
    applications,
    approvedRoles,
    applyFor,
    submitTrainerCertification,
    trainerCertifications,
  } = usePlatform();
  return (
    <>
      <section className="role-intro">
        <div>
          <span className="eyebrow">Platform roles</span>
          <h2>Apply to contribute</h2>
          <p>Applications are stored in CoLearnX and reviewed by an administrator.</p>
        </div>
        <ShieldCheck size={38} />
      </section>
      <div className="role-application-grid">
        {["Trainer", "Creator"].map((type) => (
          <RoleApplicationCard
            key={type}
            type={type}
            status={approvedRoles.includes(type) ? "Approved" : applications[type] || "Not applied"}
            onSubmit={(form) => applyFor(type, form)}
          />
        ))}
      </div>
      {approvedRoles.includes("Trainer") && (
        <TrainerCertificationCard
          certifications={trainerCertifications}
          onSubmit={submitTrainerCertification}
        />
      )}
    </>
  );
}

function TrainerCertificationCard({ certifications, onSubmit }) {
  const latest = certifications[0];
  const [form, setForm] = useState({ certificationName: "", certificationReference: "", evidenceUrl: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        certificationName: form.certificationName,
        certificationReference: form.certificationReference || undefined,
        evidenceUrl: form.evidenceUrl || undefined,
      });
      setForm({ certificationName: "", certificationReference: "", evidenceUrl: "" });
    } catch (submissionError) {
      setError(submissionError.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="application-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Trainer prerequisite</span>
          <h3>Certification review</h3>
          <p>Course creation is enabled only after an administrator approves this certification record.</p>
        </div>
        {latest && <ServerStatus value={latest.status === "pending" ? "Pending" : latest.status === "approved" ? "Approved" : "Rejected"} />}
      </div>
      {latest?.status === "approved" ? (
        <p className="success-note">Your trainer certification is approved. You may create a course for review.</p>
      ) : (
        <form className="application-form" onSubmit={submit}>
          <FormField label="Certification name"><input required value={form.certificationName} onChange={(event) => setForm({ ...form, certificationName: event.target.value })} /></FormField>
          <FormField label="Reference number (optional)"><input value={form.certificationReference} onChange={(event) => setForm({ ...form, certificationReference: event.target.value })} /></FormField>
          <FormField label="Evidence URL (optional)"><input type="url" value={form.evidenceUrl} onChange={(event) => setForm({ ...form, evidenceUrl: event.target.value })} /></FormField>
          {error && <p className="form-error">{error}</p>}
          <Button disabled={busy || latest?.status === "pending"} type="submit"><BadgeCheck size={16} /> {busy ? "Submitting…" : latest?.status === "pending" ? "Certification pending" : "Submit certification"}</Button>
        </form>
      )}
    </Card>
  );
}

function DeliverySelector({ value, onChange }) {
  const options = ["cloud", "local", "live", "record"];
  return (
    <fieldset className="delivery-mode-picker">
      <legend>Delivery modes</legend>
      {options.map((mode) => (
        <label className="delivery-mode-option" key={mode}>
          <input
            type="checkbox"
            checked={value.includes(mode)}
            onChange={() => onChange(value.includes(mode) ? value.filter((item) => item !== mode) : [...value, mode])}
          />
          <span><b>{mode[0].toUpperCase() + mode.slice(1)}</b></span>
        </label>
      ))}
    </fieldset>
  );
}

function CourseListingEditor() {
  const { savePublishedItem, refreshMyListings } = usePlatform();
  const [form, setForm] = useState({
    title: "",
    description: "",
    price: "",
    capacity: "",
    startsAt: "",
    endsAt: "",
    deliveryModes: ["cloud"],
  });
  const [submitForReview, setSubmitForReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await savePublishedItem({
        ...form,
        kind: "course",
        status: submitForReview ? "Published" : "Draft",
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      });
      await refreshMyListings();
      setForm({ ...form, title: "", description: "", price: "", capacity: "", startsAt: "", endsAt: "" });
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="content-grid editor-layout" onSubmit={save}>
      <Card className="stack">
        <div><span className="eyebrow">Course details</span><h2>Create a server-side draft</h2></div>
        <FormField label="Course title"><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormField>
        <FormField label="Description"><textarea required value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></FormField>
        <FormField label="Price in points"><input required min="0" type="number" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></FormField>
        <DeliverySelector value={form.deliveryModes} onChange={(deliveryModes) => setForm({ ...form, deliveryModes })} />
        <FormField label="Capacity (optional)"><input min="1" type="number" value={form.capacity} onChange={(event) => setForm({ ...form, capacity: event.target.value })} /></FormField>
        <div className="form-grid two">
          <FormField label="Start time (optional)"><input type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} /></FormField>
          <FormField label="End time (optional)"><input type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} /></FormField>
        </div>
        <label className="check-label"><input type="checkbox" checked={submitForReview} onChange={(event) => setSubmitForReview(event.target.checked)} />Submit for administrator review after creating the draft</label>
        {error && <p className="form-error">{error}</p>}
        <Button type="submit" disabled={busy || !form.deliveryModes.length}><Send size={16} /> {busy ? "Saving…" : submitForReview ? "Create and submit" : "Create draft"}</Button>
      </Card>
      <Card className="editor-summary"><span className="eyebrow">Publication workflow</span><h3>Server-enforced review</h3><p>A draft is stored in PostgreSQL. Submission does not publish it; an administrator must approve it before it appears in the marketplace.</p></Card>
    </form>
  );
}

function ContentListingEditor() {
  const { refreshMyListings, notify } = usePlatform();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedDraftId = searchParams.get("draft");
  const [form, setForm] = useState({ title: "", price: "", contentType: "digital" });
  const [draft, setDraft] = useState(null);
  const [asset, setAsset] = useState(null);
  const [uploadStatus, setUploadStatus] = useState("idle");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const assetReady = asset?.status === "ready";

  const restoreDraft = useCallback(async () => {
    if (!requestedDraftId) return false;
    setBusy(true);
    setError("");
    try {
      const listings = await refreshMyListings();
      const restored = contentDraftFromListing(
        listings.find((item) => item.kind === "content" && item.id === requestedDraftId),
      );
      if (!restored) {
        setError("This content draft is no longer editable. Refresh My listings to see its current status.");
        return false;
      }
      setForm({ title: restored.title, price: restored.price, contentType: restored.contentType });
      setDraft({ id: restored.id, contentVersionId: restored.contentVersionId });
      setAsset(restored.asset);
      setSubmitted(false);
      return true;
    } catch (restoreError) {
      setError(restoreError.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [refreshMyListings, requestedDraftId]);

  useEffect(() => {
    if (requestedDraftId) void restoreDraft();
  }, [requestedDraftId, restoreDraft]);

  const createDraft = async (event) => {
    event.preventDefault();
    if (draft) return;
    if (!form.title.trim() || form.price === "" || Number(form.price) < 0) {
      setError("Enter a title and a valid non-negative point price before creating the draft.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await createContent({
        title: form.title.trim(),
        contentType: form.contentType.trim() || "digital",
        pricePoints: Number(form.price),
      });
      setDraft(created);
      setAsset(null);
      setSearchParams({ draft: created.id }, { replace: true });
      await refreshMyListings();
      notify("Content draft created. Upload and verify the private file before submission.");
    } catch (createError) {
      setError(createError.message);
    } finally {
      setBusy(false);
    }
  };

  const handleAssetChange = (nextAsset) => {
    setAsset(nextAsset);
    void refreshMyListings().catch(() => {
      // The current upload response remains the source of truth until a manual refresh succeeds.
    });
  };

  const submitForReview = async () => {
    if (!draft?.id || !assetReady || submitted) return;
    setBusy(true);
    setError("");
    try {
      await submitContent(draft.id);
      setSubmitted(true);
      await refreshMyListings();
      notify("Content submitted for administrator review.");
    } catch (submissionError) {
      setError(submissionError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="content-grid editor-layout" onSubmit={createDraft}>
      <Card className="stack">
        <div><span className="eyebrow">Content details</span><h2>Create a private content draft</h2></div>
        <FormField label="Content title"><input required disabled={Boolean(draft)} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormField>
        <FormField label="Price in points"><input required min="0" disabled={Boolean(draft)} type="number" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></FormField>
        <FormField label="Content type"><input required disabled={Boolean(draft)} value={form.contentType} onChange={(event) => setForm({ ...form, contentType: event.target.value })} /></FormField>
        {!draft && <p className="policy-note">Create the server-side draft first. The file is then uploaded directly to private R2 storage and verified by the API; no browser-supplied storage URL is accepted.</p>}
        {draft && (
          <>
            <PrivateAssetUploader
              contentVersionId={draft.contentVersionId}
              existingAsset={asset}
              onAssetChange={handleAssetChange}
              onStatusChange={setUploadStatus}
              disabled={submitted || busy}
            />
            <div className="button-row">
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={restoreDraft}>Refresh server status</Button>
            </div>
            <p className="policy-note">Only a verified private file can be submitted. The API validates the actual object size and MIME type before review.</p>
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!draft ? (
          <Button type="submit" disabled={busy}><Send size={16} /> {busy ? "Creating draft…" : "Create content draft"}</Button>
        ) : (
          <Button type="button" onClick={submitForReview} disabled={busy || submitted || !assetReady || ["preparing", "uploading", "verifying"].includes(uploadStatus)}>
            <Send size={16} /> {submitted ? "Submitted for administrator review" : busy ? "Submitting…" : "Submit for administrator review"}
          </Button>
        )}
      </Card>
      <Card className="editor-summary">
        <span className="eyebrow">Private-file workflow</span>
        <h3>{submitted ? "Submitted for review" : draft ? assetReady ? "Verified file ready" : "Awaiting private file" : "Draft required"}</h3>
        <p>Files are not stored in PostgreSQL and their R2 object keys are never exposed to the browser. Upload authorisation and buyer download links are short-lived.</p>
        {draft?.contentVersionId && <small className="draft-reference">Draft version: {draft.contentVersionId}</small>}
      </Card>
    </form>
  );
}

export const CourseEditorPage = () => <CourseListingEditor />;
export const ContentEditorPage = () => <ContentListingEditor />;

export function PublishedPage() {
  const { publishedItems, refreshMyListings, role } = usePlatform();
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try {
      await refreshMyListings();
    } finally {
      setLoading(false);
    }
  };
  if (!publishedItems.length)
    return <EmptyState icon={BookOpen} title="No listings yet" description="Server-side drafts and submissions will appear here after you create them." action={<Button onClick={refresh} disabled={loading}>Refresh</Button>} />;
  return (
    <Card>
      <div className="card-heading">
        <div><span className="eyebrow">My listings</span><h2>{role} catalogue records</h2></div>
        <Button variant="secondary" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>
      </div>
      <div className="queue-list">
        {publishedItems.map((item) => {
          const editableDraft = isEditableContentDraft(item);
          return (
            <div key={`${item.kind}-${item.id}`}>
              {item.kind === "course" ? <GraduationCap size={19} /> : <FileText size={19} />}
              <div>
                <b>{item.title}</b>
                <small>{item.format} · {item.price} points · last updated {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "—"}</small>
                {item.kind === "content" && <span className="queue-detail">{item.asset?.status === "ready" ? `Verified file: ${item.asset.filename}` : `File status: ${item.fileStatus}`}</span>}
              </div>
              {editableDraft ? (
                <Link className="button secondary sm" to={`/creator/content-editor?draft=${encodeURIComponent(item.id)}`}>Continue draft</Link>
              ) : (
                <ServerStatus value={item.status} />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
