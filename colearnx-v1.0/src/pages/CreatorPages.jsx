import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  FileArchive,
  GripVertical,
  HelpCircle,
  Library,
  Link2,
  Plus,
  Save,
  Trash2,
  UploadCloud,
  Video,
} from "lucide-react";
import { usePlatform } from "../context/PlatformContext";
import {
  Badge,
  Button,
  Card,
  FormField,
  Modal,
} from "../components/ui";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getDeliveryLabel } from "../utils/courseState";

const tutorialSteps = [
  ["Fill in the basics", "Add a clear title, category, price and description."],
  [
    "Configure access",
    "Choose the delivery format and explain how learners receive access.",
  ],
  [
    "Upload materials",
    "Attach supporting files or add an external learning link.",
  ],
  [
    "Preview the listing",
    "Review how members will see the item before publishing.",
  ],
  ["Publish and manage", "Update the listing later from Published Items."],
];

function TutorialModal({ kind, onClose }) {
  const [step, setStep] = useState(0);
  return (
    <Modal
      title={`How to publish ${kind === "course" ? "a course" : "creator content"}`}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={step === 0}
            onClick={() => setStep(step - 1)}
          >
            Previous
          </Button>
          <Button
            onClick={() =>
              step === tutorialSteps.length - 1 ? onClose() : setStep(step + 1)
            }
          >
            {step === tutorialSteps.length - 1 ? "Finish" : "Next"}
            <ArrowRight size={16} />
          </Button>
        </>
      }
    >
      <div className="tutorial-player">
        <span>
          <Video size={30} />
        </span>
        <div>
          <b>
            Publishing tutorial · {step + 1} of {tutorialSteps.length}
          </b>
          <p>Interactive prototype chapter</p>
        </div>
      </div>
      <div className="tutorial-progress">
        {tutorialSteps.map((item, index) => (
          <button
            key={item[0]}
            className={index === step ? "active" : index < step ? "done" : ""}
            onClick={() => setStep(index)}
          >
            <span>{index < step ? <Check size={14} /> : index + 1}</span>
            <div>
              <b>{item[0]}</b>
              <small>{item[1]}</small>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function EditorShell({ kind }) {
  const { notify, publishedItems, savePublishedItem } = usePlatform();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const course = kind === "course";
  const editId = searchParams.get("edit");
  const existing = publishedItems.find(
    (item) => item.id === editId && item.kind === kind,
  );
  const storageKey = `colearnx-${kind}-editor-${editId || "new"}`;
  const [tutorial, setTutorial] = useState(false);
  const [preview, setPreview] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [format, setFormat] = useState(course ? "Cloud" : "PDF");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("AI");
  const [modules, setModules] = useState([
    "Foundations",
    "Guided practice",
    "Final project",
  ]);
  const [provider, setProvider] = useState("Zoom");
  const [startsAt, setStartsAt] = useState("2026-09-20T20:00");
  const [timezone, setTimezone] = useState("Asia/Singapore (GMT+8)");
  const [replay, setReplay] = useState("May be shared by Trainer");
  const [status, setStatus] = useState("Draft");
  const [visibility, setVisibility] = useState("Public marketplace");
  const [previewVisibility, setPreviewVisibility] = useState(
    "Show cover and description",
  );
  const [saved, setSaved] = useState("Draft autosave ready");
  const [fileName, setFileName] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [deliveryModes, setDeliveryModes] = useState(["cloud"]);
  const [tags, setTags] = useState("");
  const [capacity, setCapacity] = useState("24");
  const [prerequisites, setPrerequisites] = useState("");
  const [ownershipDeclared, setOwnershipDeclared] = useState(false);

  const snapshot = () => ({
    id: existing?.id,
    kind,
    ownerRole: course ? "Trainer" : "Creator",
    title,
    price,
    description,
    category,
    format: course ? getDeliveryLabel({ deliveryModes }) : format,
    deliveryModes,
    tags: tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    capacity: course ? Number(capacity) : undefined,
    prerequisites: course ? prerequisites : undefined,
    ownershipDeclared,
    modules,
    provider,
    startsAt,
    timezone,
    replay,
    status,
    visibility,
    previewVisibility,
    fileName,
    externalUrl,
  });

  useEffect(() => {
    let source = existing;
    try {
      source = JSON.parse(localStorage.getItem(storageKey)) || existing;
    } catch {
      source = existing;
    }
    if (source) {
      setTitle(source.title || "");
      setPrice(String(source.price || ""));
      setDescription(source.description || "");
      setCategory(source.category || "AI");
      setFormat(source.format || (course ? "Cloud Only" : "PDF"));
      setDeliveryModes(
        source.deliveryModes?.length
          ? source.deliveryModes
          : source.format === "External LIVE"
            ? ["live"]
            : ["cloud"],
      );
      setTags(Array.isArray(source.tags) ? source.tags.join(", ") : source.tags || "");
      setCapacity(String(source.capacity || "24"));
      setPrerequisites(source.prerequisites || "");
      setOwnershipDeclared(Boolean(source.ownershipDeclared));
      setModules(
        source.modules?.length
          ? source.modules
          : ["Foundations", "Guided practice", "Final project"],
      );
      setProvider(source.provider || "Zoom");
      setStartsAt(source.startsAt || "2026-09-20T20:00");
      setTimezone(source.timezone || "Asia/Singapore (GMT+8)");
      setReplay(source.replay || "May be shared by Trainer");
      setStatus(source.status || "Draft");
      setVisibility(source.visibility || "Public marketplace");
      setPreviewVisibility(
        source.previewVisibility || "Show cover and description",
      );
      setFileName(source.fileName || "");
      setExternalUrl(source.externalUrl || "");
      setSaved(existing ? "Existing listing loaded" : "Saved draft restored");
    }
    setHydrated(true);
  }, [course, editId, existing, storageKey]);

  useEffect(() => {
    if (!hydrated) return undefined;
    const timer = window.setTimeout(() => {
      localStorage.setItem(storageKey, JSON.stringify(snapshot()));
      setSaved(
        `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      );
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    hydrated,
    title,
    price,
    description,
    category,
    format,
    modules,
    provider,
    startsAt,
    timezone,
    replay,
    status,
    visibility,
    previewVisibility,
    fileName,
    externalUrl,
    deliveryModes,
    tags,
    capacity,
    prerequisites,
    ownershipDeclared,
    storageKey,
  ]);

  const saveLocalDraft = () => {
    localStorage.setItem(storageKey, JSON.stringify(snapshot()));
    setSaved("Draft saved now");
    notify("Editor draft saved and ready to restore.");
  };

  const publish = () => {
    if (!title.trim() || !price.trim() || !description.trim())
      return notify("Complete the title, price and description first.");
    if (course && !modules.some((module) => module.trim()))
      return notify("Add at least one course module.");
    if (course && !deliveryModes.length)
      return notify("Choose at least one delivery mode.");
    if (
      course &&
      deliveryModes.length === 1 &&
      deliveryModes.includes("record")
    )
      return notify(
        "Record cannot be sold independently until the team resolves OPEN-016.",
      );
    if (course && deliveryModes.includes("live") && !startsAt)
      return notify("Choose a start date and time for the live course.");
    if (course && (!Number.isInteger(Number(capacity)) || Number(capacity) <= 0))
      return notify("Capacity must be a whole number greater than zero.");
    if (!course && format !== "Link" && !fileName)
      return notify("Choose a content file before publishing.");
    if (!course && format === "Link" && !externalUrl.trim())
      return notify("Add the external content URL before publishing.");
    if (!course && !ownershipDeclared)
      return notify("Confirm that you own or are authorised to publish this content.");
    savePublishedItem({
      ...snapshot(),
      price: Number(price),
      modules: modules.filter((module) => module.trim()),
    });
    localStorage.removeItem(storageKey);
    navigate("/published");
  };

  const acceptFile = (file) => {
    if (!file) return;
    setFileName(file.name);
    setDragActive(false);
  };

  const toggleDeliveryMode = (mode) => {
    setDeliveryModes((current) =>
      current.includes(mode)
        ? current.filter((item) => item !== mode)
        : [...current, mode],
    );
  };

  const moveModule = (index, direction) => {
    const destination = index + direction;
    if (destination < 0 || destination >= modules.length) return;
    setModules((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  };

  return (
    <>
      <section className="editor-header">
        <div>
          <Badge tone={course ? "info" : "violet"}>
            {course ? "Trainer workspace" : "Creator workspace"}
          </Badge>
          <h2>
            {course
              ? "Publish or edit a course"
              : "Publish or edit creative content"}
          </h2>
          <p>
            Complete the listing in three clear sections, preview it, then
            publish when ready.
          </p>
        </div>
        <div className="button-row">
          <Button variant="secondary" onClick={() => setTutorial(true)}>
            <HelpCircle size={17} /> Video tutorial
          </Button>
          <Button variant="ghost" onClick={() => setPreview(true)}>
            Preview
          </Button>
        </div>
      </section>
      <div className="editor-layout">
        <div className="stack">
          <Card>
            <div className="editor-step">
              <span>1</span>
              <div>
                <h3>Basic information</h3>
                <p>Help members understand what they will receive.</p>
              </div>
            </div>
            <div className="form-grid two">
              <FormField label={course ? "Course title" : "Content title"}>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={
                    course ? "e.g. AI Basics" : "e.g. AI Study Notes"
                  }
                />
              </FormField>
              <FormField label="Point price">
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))}
                  inputMode="numeric"
                  placeholder="e.g. 80"
                />
              </FormField>
              <FormField label="Category">
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option>AI</option>
                  <option>Design</option>
                  <option>Code</option>
                  <option>Security</option>
                </select>
              </FormField>
              {course && (
                <FormField label="Capacity">
                  <input
                    value={capacity}
                    onChange={(event) =>
                      setCapacity(event.target.value.replace(/\D/g, ""))
                    }
                    inputMode="numeric"
                    placeholder="e.g. 24"
                  />
                </FormField>
              )}
              {!course && (
                <FormField label="Content type">
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                  >
                    <option>PDF</option>
                    <option>Video</option>
                    <option>Image</option>
                    <option>File</option>
                    <option>Link</option>
                  </select>
                </FormField>
              )}
            </div>
            <FormField label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the learning value, audience and what is included"
              />
            </FormField>
            <div className="form-grid two">
              <FormField label="Tags (comma separated)">
                <input
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="e.g. beginner, teamwork"
                />
              </FormField>
              {course && (
                <FormField label="Prerequisites">
                  <input
                    value={prerequisites}
                    onChange={(event) => setPrerequisites(event.target.value)}
                    placeholder="e.g. No prior experience required"
                  />
                </FormField>
              )}
            </div>
          </Card>
          <Card>
            <div className="editor-step">
              <span>2</span>
              <div>
                <h3>
                  {course ? "Delivery and structure" : "Upload and preview"}
                </h3>
                <p>
                  {course
                    ? "Set expectations for access, timing and course modules."
                    : "Add the resource and explain its file access."}
                </p>
              </div>
            </div>
            {course ? (
              <>
                <fieldset className="delivery-mode-picker">
                  <legend>Delivery modes</legend>
                  {[
                    ["cloud", "Cloud", "Hosted, on-platform learning"],
                    ["local", "Local", "Downloadable package; non-refundable"],
                    ["live", "Live", "Real-time class through an external provider"],
                    ["record", "Record", "Replay supplied with a Live course"],
                  ].map(([value, label, help]) => (
                    <label key={value} className="delivery-mode-option">
                      <input
                        type="checkbox"
                        checked={deliveryModes.includes(value)}
                        onChange={() => toggleDeliveryMode(value)}
                      />
                      <span>
                        <b>{label}</b>
                        <small>{help}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <p className="editor-policy-note">
                  Member-facing label: <b>{getDeliveryLabel({ deliveryModes })}</b>.
                  Record-only sale remains disabled until OPEN-016 is resolved; Local
                  production access remains behind the server feature flag.
                </p>
                {deliveryModes.includes("live") && (
                  <div className="form-grid two">
                    <FormField label="Provider">
                      <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                        <option>Zoom</option>
                        <option>Microsoft Teams</option>
                        <option>Google Meet</option>
                      </select>
                    </FormField>
                    <FormField label="Course start">
                      <input
                        type="datetime-local"
                        value={startsAt}
                        onChange={(e) => setStartsAt(e.target.value)}
                      />
                    </FormField>
                    <FormField label="Timezone">
                      <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                        <option>Asia/Singapore (GMT+8)</option>
                        <option>UTC</option>
                      </select>
                    </FormField>
                    <FormField label="Replay">
                      <select value={replay} onChange={(e) => setReplay(e.target.value)}>
                        <option>May be shared by Trainer</option>
                        <option>Not provided</option>
                      </select>
                    </FormField>
                  </div>
                )}
                <div className="module-editor">
                  <div className="card-heading">
                    <div>
                      <h4>Course modules</h4>
                      <small>Use the arrow buttons as a keyboard-safe reorder option.</small>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setModules([
                          ...modules,
                          `New module ${modules.length + 1}`,
                        ])
                      }
                    >
                      <Plus size={15} /> Add module
                    </Button>
                  </div>
                  {modules.map((module, index) => (
                    <div key={`${index}-${module}`}>
                      <GripVertical size={17} aria-hidden="true" />
                      <span>{index + 1}</span>
                      <input
                        aria-label={`Module ${index + 1} title`}
                        value={module}
                        onChange={(e) =>
                          setModules(
                            modules.map((item, i) =>
                              i === index ? e.target.value : item,
                            ),
                          )
                        }
                      />
                      <div className="module-order-actions">
                        <button
                          className="icon-button"
                          type="button"
                          disabled={index === 0}
                          aria-label={`Move ${module || `module ${index + 1}`} up`}
                          onClick={() => moveModule(index, -1)}
                        >
                          <ArrowUp size={15} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          disabled={index === modules.length - 1}
                          aria-label={`Move ${module || `module ${index + 1}`} down`}
                          onClick={() => moveModule(index, 1)}
                        >
                          <ArrowDown size={15} />
                        </button>
                        <button
                          className="icon-button danger"
                          type="button"
                          disabled={modules.length === 1}
                          aria-label={`Delete ${module || `module ${index + 1}`}`}
                          onClick={() =>
                            setModules(modules.filter((_, i) => i !== index))
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                {format === "Link" ? (
                  <FormField label="External content URL">
                    <div className="input-with-icon">
                      <Link2 size={18} />
                      <input
                        type="url"
                        value={externalUrl}
                        onChange={(event) => setExternalUrl(event.target.value)}
                        placeholder="https://example.com/resource"
                      />
                    </div>
                  </FormField>
                ) : (
                  <label
                    className={`upload-zone ${dragActive ? "drag-active" : ""}`}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setDragActive(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={(event) => {
                      event.preventDefault();
                      setDragActive(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      acceptFile(event.dataTransfer.files?.[0]);
                    }}
                  >
                    <UploadCloud size={28} />
                    <div>
                      <b>
                        {fileName || "Drop a file here or choose from device"}
                      </b>
                      <p>
                        {fileName
                          ? "File selected for this prototype listing"
                          : "PDF, video, image or ZIP"}
                      </p>
                    </div>
                    <span className="button secondary">
                      {fileName ? "Replace file" : "Choose file"}
                    </span>
                    <input
                      className="visually-hidden"
                      type="file"
                      accept=".pdf,.mp4,.mov,.png,.jpg,.jpeg,.zip"
                      onChange={(event) => acceptFile(event.target.files?.[0])}
                    />
                  </label>
                )}
                <FormField label="Preview visibility">
                  <select value={previewVisibility} onChange={(e) => setPreviewVisibility(e.target.value)}>
                    <option>Show cover and description</option>
                    <option>Show limited preview</option>
                    <option>No preview</option>
                  </select>
                </FormField>
                <label className="check-label editor-ownership">
                  <input
                    type="checkbox"
                    checked={ownershipDeclared}
                    onChange={(event) => setOwnershipDeclared(event.target.checked)}
                  />
                  I confirm that I own this content or have permission to publish
                  and sell it on CoLearnX.
                </label>
              </>
            )}
          </Card>
          <Card>
            <div className="editor-step">
              <span>3</span>
              <div>
                <h3>Publish settings</h3>
                <p>Choose visibility and confirm the member-facing listing.</p>
              </div>
            </div>
            <div className="form-grid two">
              <FormField label="Status">
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option>Draft</option>
                  <option>Published</option>
                </select>
              </FormField>
              <FormField label="Visibility">
                <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                  <option>Public marketplace</option>
                  <option>Hidden link only</option>
                </select>
              </FormField>
            </div>
          </Card>
        </div>
        <aside className="editor-summary">
          <Card>
            <span className="eyebrow">Listing readiness</span>
            <h3>{title || `Untitled ${course ? "course" : "content"}`}</h3>
            <div className="readiness-list">
              <span className={title ? "done" : ""}>
                <Check size={15} /> Title
              </span>
              <span className={price ? "done" : ""}>
                <Check size={15} /> Price
              </span>
              <span className={description ? "done" : ""}>
                <Check size={15} /> Description
              </span>
              <span className={course || fileName || externalUrl ? "done" : ""}>
                <Check size={15} /> {course ? "Delivery" : "Content source"}
              </span>
            </div>
            <div className="summary-row">
              <span>Format</span>
              <b>{course ? getDeliveryLabel({ deliveryModes }) : format}</b>
            </div>
            <div className="summary-row">
              <span>Price</span>
              <b>{price || "—"} points</b>
            </div>
            <Button className="wide" onClick={publish}>
              {status === "Published" ? "Publish / Update" : "Save listing draft"}
            </Button>
            <Button
              variant="secondary"
              className="wide"
              onClick={saveLocalDraft}
            >
              <Save size={16} /> Save draft
            </Button>
            <small className="autosave">{saved}</small>
          </Card>
        </aside>
      </div>
      {tutorial && (
        <TutorialModal kind={kind} onClose={() => setTutorial(false)} />
      )}
      {preview && (
        <Modal
          title={`${course ? "Course" : "Content"} preview`}
          onClose={() => setPreview(false)}
          footer={
            <Button onClick={() => setPreview(false)}>Close preview</Button>
          }
        >
          <div className="listing-preview">
            <span
              className={`listing-preview-icon ${course ? "course" : "content"}`}
            >
              {course ? <BookOpen size={28} /> : <FileArchive size={28} />}
            </span>
            <Badge tone={course ? "info" : "violet"}>
              {course ? getDeliveryLabel({ deliveryModes }) : format}
            </Badge>
            <h3>{title || `Untitled ${course ? "course" : "content"}`}</h3>
            <p>
              {description ||
                "Add a description to explain the value of this listing."}
            </p>
            {(fileName || externalUrl) && <small>{fileName || externalUrl}</small>}
            <b>{price || "0"} points</b>
          </div>
        </Modal>
      )}
    </>
  );
}

export const CourseEditorPage = () => <EditorShell kind="course" />;
export const ContentEditorPage = () => <EditorShell kind="content" />;

export function RoleApplicationPage() {
  const { applications, applyFor } = usePlatform();
  return (
    <>
      <Card className="role-intro">
        <div>
          <span className="eyebrow">Member progression</span>
          <h2>Choose how you want to contribute</h2>
          <p>
            Trainer and Creator are separate roles. You may apply for one or
            both using the same Member account.
          </p>
        </div>
        <Badge tone="brand">Current role · Member</Badge>
      </Card>
      <div className="role-application-grid">
        <ApplicationCard
          type="Trainer"
          status={applications.Trainer}
          icon={BookOpen}
          onApply={(form) => applyFor("Trainer", form)}
        />
        <ApplicationCard
          type="Creator"
          status={applications.Creator}
          icon={Library}
          onApply={(form) => applyFor("Creator", form)}
        />
      </div>
    </>
  );
}

function ApplicationCard({ type, status, icon: Icon, onApply }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    experience: "",
    category: "",
    portfolio: "",
    reason: "",
    declarationAccepted: false,
  });
  const valid =
    [form.experience, form.category, form.portfolio, form.reason].every(
      (value) => value.trim().length >= 3,
    ) && form.declarationAccepted;
  const update = (key, value) => setForm({ ...form, [key]: value });
  return (
    <Card className="application-card">
      <header>
        <span className={`application-icon ${type.toLowerCase()}`}>
          <Icon size={24} />
        </span>
        <div>
          <Badge
            tone={
              status === "Pending" || status === "Certification pending"
                ? "warning"
                : status === "Approved"
                  ? "success"
                  : "neutral"
            }
          >
            {status}
          </Badge>
          <h3>Become a {type}</h3>
          <p>
            {type === "Trainer"
              ? "Create structured courses and manage learner enrolment."
              : "Publish downloadable resources, videos and creative assets."}
          </p>
        </div>
      </header>
      {open && (
        <div className="application-form">
          <FormField
            label={
              type === "Trainer" ? "Teaching experience" : "Creator experience"
            }
          >
            <input
              value={form.experience}
              onChange={(event) => update("experience", event.target.value)}
              placeholder="Describe relevant experience"
            />
          </FormField>
          <FormField
            label={type === "Trainer" ? "Course category" : "Content category"}
          >
            <input
              value={form.category}
              onChange={(event) => update("category", event.target.value)}
              placeholder="e.g. AI, Design or Code"
            />
          </FormField>
          <FormField label="Portfolio or sample work">
            <input
              value={form.portfolio}
              onChange={(event) => update("portfolio", event.target.value)}
              placeholder="Portfolio link or short description"
            />
          </FormField>
          <FormField label="Reason for applying">
            <textarea
              value={form.reason}
              onChange={(event) => update("reason", event.target.value)}
              placeholder="Explain what you want to contribute"
            />
          </FormField>
          <label className="check-label editor-ownership">
            <input
              type="checkbox"
              checked={form.declarationAccepted}
              onChange={(event) =>
                update("declarationAccepted", event.target.checked)
              }
            />
            I confirm that the evidence is accurate and agree to the platform
            conduct, ownership and moderation requirements.
          </label>
        </div>
      )}
      <Button
        variant={open ? "primary" : "secondary"}
        className="wide"
        disabled={
          status === "Pending" ||
          status === "Certification pending" ||
          status === "Approved" ||
          (open && !valid)
        }
        onClick={() => (open ? onApply(form) : setOpen(true))}
      >
        {status === "Pending"
          ? "Application pending"
          : status === "Certification pending"
            ? "Trainer certification pending"
          : status === "Approved"
            ? `${type} role approved`
            : open
              ? `Submit ${type} application`
              : `Start ${type} application`}
      </Button>
    </Card>
  );
}

export function PublishedPage() {
  const { role, publishedItems, deletePublishedItem } = usePlatform();
  const navigate = useNavigate();
  const items = publishedItems.filter((item) => item.ownerRole === role);
  const editorPath =
    role === "Creator"
      ? "/creator/content-editor"
      : "/trainer/course-editor";
  return (
    <Card className="table-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">{role} workspace</span>
          <h3>
            {role === "Creator" ? "Published content" : "Published courses"}
          </h3>
        </div>
        <Button
          onClick={() => navigate(editorPath)}
        >
          <Plus size={16} /> Create new
        </Button>
      </div>
      <div className="responsive-table">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Point price</th>
              <th>Status</th>
              <th>Visibility</th>
              <th>Updated</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <b>{item.title}</b>
                </td>
                <td>{item.format}</td>
                <td>{item.price}</td>
                <td>
                  <Badge
                    tone={item.status === "Published" ? "success" : "warning"}
                  >
                    {item.status}
                  </Badge>
                </td>
                <td>{item.visibility}</td>
                <td>{item.updatedAt}</td>
                <td>
                  <div className="button-row">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => navigate(`${editorPath}?edit=${item.id}`)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (window.confirm(`Delete ${item.title}?`))
                          deletePublishedItem(item.id);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
