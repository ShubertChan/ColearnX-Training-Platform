import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  BookOpen,
  FileText,
  GraduationCap,
  Send,
  Trash2,
  ShieldCheck,
} from "lucide-react";
import { usePlatform } from "../context/PlatformContext";
import { Link, useSearchParams } from "react-router-dom";
import { contentDraftFromListing, isDeletableDraftListing, isEditableContentDraft, isMissingContentDraftFile } from "../utils/contentDraft";
import { listingsForWorkspace, workspaceListingCopy } from "../utils/listingWorkspace";
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
        <div><span className="eyebrow">Course details</span><h2>Create course</h2></div>
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
      <Card className="editor-summary"><span className="eyebrow">Publication workflow</span><h3>Review before publishing</h3><p>Your course is saved for review before it appears in the marketplace.</p></Card>
    </form>
  );
}

function ContentListingEditor() {
  const { refreshMyListings, notify } = usePlatform();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedDraftId = searchParams.get("draft");
  const [form, setForm] = useState({ title: "", price: "", contentType: "digital" });
  const [draft, setDraft] = useState(null);
  const [uploadSummary, setUploadSummary] = useState({ readyCount: 0, activeCount: 0 });
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const restoreDraft = useCallback(async () => {
    if (!requestedDraftId) return false;
    setBusy(true);
    setError("");
    try {
      const listings = await refreshMyListings();
      const listing = listings.find((item) => item.kind === "content" && item.id === requestedDraftId);
      if (isMissingContentDraftFile(listing)) {
        setError("This draft is missing its required file. Delete it from My listings and create a new draft.");
        return false;
      }
      const restored = contentDraftFromListing(listing);
      if (!restored) {
        setError("This content draft is no longer editable. Refresh My listings to see its current status.");
        return false;
      }
      setForm({ title: restored.title, price: restored.price, contentType: restored.contentType });
      setDraft({ id: restored.id, contentVersionId: restored.contentVersionId });
      setUploadSummary({ readyCount: 0, activeCount: 0 });
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
      setUploadSummary({ readyCount: 0, activeCount: 0 });
      setSearchParams({ draft: created.id }, { replace: true });
      await refreshMyListings();
      notify("Content created. Selected files will now upload automatically.");
    } catch (createError) {
      setError(createError.message);
    } finally {
      setBusy(false);
    }
  };

  const handleAssetsChange = useCallback((nextSummary) => {
    setUploadSummary(nextSummary);
  }, []);

  const submitForReview = async () => {
    if (!draft?.id || uploadSummary.readyCount < 1 || uploadSummary.activeCount > 0 || submitted) return;
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
        <div><span className="eyebrow">Content details</span><h2>Create content</h2></div>
        <FormField label="Content title"><input required disabled={Boolean(draft)} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormField>
        <FormField label="Price in points"><input required min="0" disabled={Boolean(draft)} type="number" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></FormField>
        <FormField label="Content type"><input required disabled={Boolean(draft)} value={form.contentType} onChange={(event) => setForm({ ...form, contentType: event.target.value })} /></FormField>
        <PrivateAssetUploader
          contentVersionId={draft?.contentVersionId}
          onAssetsChange={handleAssetsChange}
          disabled={submitted || busy}
        />
        {!draft && <p className="policy-note">Choose or drop files now. They upload automatically immediately after you create the content.</p>}
        {draft && <p className="policy-note">Files upload one at a time and are checked by the server. You can remove any file with the × button.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!draft ? (
          <Button type="submit" disabled={busy}><Send size={16} /> {busy ? "Creating content…" : "Create content"}</Button>
        ) : (
          <Button type="button" onClick={submitForReview} disabled={busy || submitted || uploadSummary.readyCount < 1 || uploadSummary.activeCount > 0}>
            <Send size={16} /> {submitted ? "Submitted for administrator review" : busy ? "Submitting…" : "Submit for administrator review"}
          </Button>
        )}
      </Card>
      <Card className="editor-summary">
        <span className="eyebrow">Content upload</span>
        <h3>{submitted ? "Submitted for review" : uploadSummary.activeCount ? "Uploading files" : uploadSummary.readyCount ? `${uploadSummary.readyCount} file${uploadSummary.readyCount === 1 ? "" : "s"} ready` : draft ? "Add files" : "Add files"}</h3>
        <p>{submitted ? "Your content is waiting for an administrator review." : uploadSummary.activeCount ? "Your files are uploading automatically. Keep this page open until each row has a green check." : "Add one or more files, then submit the completed content for review."}</p>
      </Card>
    </form>
  );
}
export const CourseEditorPage = () => <CourseListingEditor />;
export const ContentEditorPage = () => <ContentListingEditor />;

export function PublishedPage() {
  const { publishedItems, refreshMyListings, role, deleteDraftListing, notify } = usePlatform();
  const [loading, setLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const listings = listingsForWorkspace(publishedItems, role);
  const copy = workspaceListingCopy(role);

  const refresh = async () => {
    setLoading(true);
    try {
      await refreshMyListings();
    } finally {
      setLoading(false);
    }
  };

  const deleteDraft = async (item) => {
    const itemKey = `${item.kind}-${item.id}`;
    setDeletingId(itemKey);
    try {
      await deleteDraftListing(item);
      setConfirmingId(null);
    } catch (deleteError) {
      notify(deleteError.message || "The draft could not be deleted. Refresh and try again.");
    } finally {
      setDeletingId(null);
    }
  };

  if (!listings.length) {
    return (
      <EmptyState
        icon={BookOpen}
        title={copy.emptyTitle}
        description={copy.emptyDescription}
        action={<Button onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>}
      />
    );
  }

  return (
    <Card>
      <div className="card-heading">
        <div><span className="eyebrow">{role} workspace</span><h2>{copy.title}</h2></div>
        <Button variant="secondary" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>
      </div>
      <div className="queue-list">
        {listings.map((item) => {
          const itemKey = `${item.kind}-${item.id}`;
          const isContentDraft = isEditableContentDraft(item);
          const isDraft = isDeletableDraftListing(item);
          const missingContentFile = isMissingContentDraftFile(item);
          const confirming = confirmingId === itemKey;
          const deleting = deletingId === itemKey;
          return (
            <div key={itemKey}>
              {item.kind === "course" ? <GraduationCap size={19} /> : <FileText size={19} />}
              <div>
                <b>{item.title}</b>
                <small>{item.format} · {item.price} points · last updated {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "—"}</small>
                {item.kind === "content" && <span className="queue-detail">{item.asset?.status === "ready" ? `Verified file: ${item.asset.filename}` : "File status: missing"}</span>}
              </div>
              {isDraft ? (
                confirming ? (
                  <div className="queue-actions draft-delete-confirmation" role="group" aria-label={`Delete draft ${item.title}`}>
                    <span>Delete this draft?</span>
                    <Button variant="ghost" size="sm" type="button" onClick={() => setConfirmingId(null)} disabled={deleting}>Keep</Button>
                    <Button variant="danger" size="sm" type="button" onClick={() => void deleteDraft(item)} disabled={deleting}>
                      <Trash2 size={14} /> {deleting ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                ) : (
                  <div className="queue-actions">
                    {missingContentFile ? (
                      <Button variant="secondary" size="sm" type="button" onClick={() => notify("File missing. Delete this incomplete draft or create a new content draft.")}>File missing</Button>
                    ) : isContentDraft ? (
                      <Link className="button secondary sm" to={`/creator/content-editor?draft=${encodeURIComponent(item.id)}`}>Continue draft</Link>
                    ) : (
                      <ServerStatus value="Draft" />
                    )}
                    <Button variant="ghost" size="sm" type="button" onClick={() => setConfirmingId(itemKey)} aria-label={`Delete draft ${item.title}`}>
                      <Trash2 size={14} /> Delete draft
                    </Button>
                  </div>
                )
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
