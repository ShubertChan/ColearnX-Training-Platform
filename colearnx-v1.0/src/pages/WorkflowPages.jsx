import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import { Badge, Button, Card, FormField, Modal } from "../components/ui";
import * as api from "../api/workflows";
import { buildCourseMetadataUpdate, canEditCourseMetadata } from "../utils/courseMetadata";

function useRequest(loader) {
  const revision = useRef(0);
  const [state, setState] = useState({ data: null, status: "loading", error: "" });
  const reload = useCallback(async () => {
    const request = ++revision.current; setState({ data: null, status: "loading", error: "" });
    try { const data = await loader(); if (request === revision.current) setState({ data, status: "ready", error: "" }); }
    catch (error) { if (request === revision.current) setState({ data: null, status: "error", error: api.serviceMessage(error) }); }
  }, [loader]);
  useEffect(() => { void reload(); return () => { revision.current++; }; }, [reload]);
  return [state, reload];
}
function RequestState({ state, reload, children }) {
  if (state.status === "loading") return <p role="status">Loading records…</p>;
  if (state.status === "error") return <div className="catalog-error"><p role="alert">{state.error}</p><Button variant="secondary" onClick={() => void reload()}>Retry records</Button></div>;
  return children;
}
function Records({ rows, columns }) {
  if (!Array.isArray(rows) || !rows.length) return <p>No records were returned.</p>;
  return <div className="responsive-table"><table><thead><tr>{columns.map(([key, title]) => <th key={key}>{title}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id || index}>{columns.map(([key]) => <td key={key}>{typeof row[key] === "object" ? "See associated record" : String(row[key] ?? "Not supplied")}</td>)}</tr>)}</tbody></table></div>;
}
function DateRange({ value, onChange }) {
  return <div className="form-grid two"><FormField label="From date"><input type="date" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} /></FormField><FormField label="To date"><input type="date" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} /></FormField></div>;
}
function VersionHistory({ kind, id }) {
  const loader = useCallback(() => api.listListingVersions(kind, id), [kind, id]);
  const [state, reload] = useRequest(loader);
  return <Card><h3>Version history</h3><RequestState state={state} reload={reload}><Records rows={state.data} columns={[["version", "Version"], ["status", "Status"], ["createdAt", "Created"], ["changeSummary", "Change summary"]]} /></RequestState></Card>;
}
function PublishingAnalytics({ kind }) {
  const [range, setRange] = useState({ from: "", to: "" });
  const loader = useCallback(() => api.getPublishingAnalytics(kind, range), [kind, range]);
  const [state, reload] = useRequest(loader);
  return <Card><h3>Sales and usage</h3><DateRange value={range} onChange={setRange} /><RequestState state={state} reload={reload}>
    <dl className="receipt-details">{[["sales", "Sales"], ["revenuePoints", "Revenue in points"], ["downloads", "Downloads"], ["views", "Views"]].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{state.data?.[key] ?? "Not supplied"}</dd></div>)}</dl>
    <Records rows={state.data?.items} columns={[["title", "Item"], ["sales", "Sales"], ["revenuePoints", "Revenue in points"], ["downloads", "Downloads"]]} />
  </RequestState></Card>;
}
function ResourceCombination({ courseId }) {
  const { orders } = usePlatform();
  const owned = [...new Map(orders.flatMap((order) => order.items).filter((item) => item.kind === "content" && ["paid", "fulfilled", "reserved"].includes(item.fulfilmentStatus)).map((item) => [item.productId, item])).values()];
  const [selected, setSelected] = useState([]), [validation, setValidation] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  const check = async () => { setBusy(true); setError(""); setSuccess(""); setValidation(null); try { const result = await api.validateCourseResources(courseId, selected); if (result?.allowed !== true || !result.validationId) throw new Error(result?.explanation || "These resources are not approved for use in this course."); setValidation(result); } catch (error) { setError(api.serviceMessage(error)); } finally { setBusy(false); } };
  const save = async () => { setBusy(true); setError(""); try { await api.saveCourseResources(courseId, selected, validation.validationId); setValidation(null); setSuccess("The course resource selection was saved by the service."); } catch (error) { setValidation(null); setError(api.serviceMessage(error)); } finally { setBusy(false); } };
  return <Card><h3>Combine purchased resources</h3><p>A purchase does not automatically grant redistribution rights. Validate the selected licences before saving.</p>
    {!owned.length && <p>No eligible purchased resources are available.</p>}{owned.map((item) => <label className="check-label" key={item.productId}><input type="checkbox" disabled={busy} checked={selected.includes(item.productId)} onChange={() => { setSelected((items) => items.includes(item.productId) ? items.filter((id) => id !== item.productId) : [...items, item.productId]); setValidation(null); setSuccess(""); }} />{item.title}</label>)}
    {error && <p role="alert" className="form-error">{error}</p>}{success && <p role="status">{success}</p>}
    <div className="button-row"><Button variant="secondary" disabled={busy || !selected.length} onClick={() => void check()}>Check selected licences</Button><Button disabled={busy || !validation} onClick={() => void save()}>Confirm resource selection</Button></div>
  </Card>;
}
function ListingManagement({ item }) {
  const { refreshMyListings } = usePlatform();
  const [form, setForm] = useState({ title: item.title, description: item.description || "", pricePoints: item.price, fulfilmentInstructions: item.fulfilmentInstructions || "", trainerContact: item.trainerContact || "", joinUrl: item.joinUrl || "" });
  const [reason, setReason] = useState(""), [action, setAction] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  const coordination = item.kind === "course" && item.deliveryModes.some((mode) => ["live", "local"].includes(mode));
  const metadataEditable = canEditCourseMetadata(item);
  const valid = form.title.trim() && Number.isInteger(Number(form.pricePoints)) && Number(form.pricePoints) >= 0 && (!coordination || (form.fulfilmentInstructions.trim() && form.trainerContact.trim()));
  const mutate = async () => {
    setBusy(true); setError("");
    try {
      if (action !== "edit" || !metadataEditable) throw new Error("This publishing action is not connected in this release. No change was saved.");
      const payload = buildCourseMetadataUpdate(item, form, reason);
      await api.updateListing(item.kind, item.id, payload);
      setAction(""); setSuccess("The service accepted the change. Review My listings for its publication status.");
      try { await refreshMyListings(); } catch { setSuccess("The change was accepted, but My listings could not refresh. Refresh it later; do not resubmit the change."); }
    } catch (error) { setError(api.serviceMessage(error)); } finally { setBusy(false); }
  };
  return <div className="stack"><Card><div className="card-heading"><h3>Manage {item.title}</h3><Badge>{item.status}</Badge></div>
    <fieldset disabled={busy || !metadataEditable} className="editor-fields"><FormField label="Title"><input value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} /></FormField><FormField label="Public description"><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></FormField><FormField label="Price in points"><input type="number" min={0} step={1} value={form.pricePoints} onChange={(e) => setForm({ ...form, pricePoints: e.target.value })} /></FormField>
    {coordination && <><FormField label="Buyer-only fulfilment instructions"><textarea value={form.fulfilmentInstructions} onChange={(e) => setForm({ ...form, fulfilmentInstructions: e.target.value })} /></FormField><FormField label="Trainer contact"><input value={form.trainerContact} onChange={(e) => setForm({ ...form, trainerContact: e.target.value })} /></FormField><FormField label="Meeting or group URL"><input type="url" value={form.joinUrl} onChange={(e) => setForm({ ...form, joinUrl: e.target.value })} /></FormField></>}
    <FormField label="Reason or change summary (at least 5 characters)"><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} /></FormField></fieldset>
    <p>This release supports metadata updates for owned draft courses only. Existing schedule, delivery modes and video settings are preserved. Versioning, withdrawal and content metadata editing still require connected backend services.</p>
    {success && <p role="status">{success}</p>}
    <div className="button-row">{metadataEditable && <Button variant="secondary" disabled={busy || !valid || reason.trim().length < 5} onClick={() => { setError(""); setAction("edit"); }}>Review metadata update</Button>}
      <Button variant="secondary" disabled title="The version-management API is not connected yet">Major-update version — unavailable</Button>
      <Button variant="secondary" disabled title="The withdrawal API is not connected yet">{item.kind === "course" ? "Cancel course" : "Archive resource"} — unavailable</Button>
      {item.status === "Draft" && <Link className="button secondary" to={`/${item.kind === "course" ? "trainer/course-editor" : "creator/content-editor"}?draft=${encodeURIComponent(item.id)}`}>Manage draft files</Link>}
    </div></Card>
    <VersionHistory kind={item.kind} id={item.id} />{item.kind === "course" && <ResourceCombination key={item.id} courseId={item.id} />}
    {action && <Modal title={action === "retire" ? "Confirm withdrawal from publication" : "Confirm listing update"} onClose={() => !busy && setAction("")} footer={<><Button variant="secondary" disabled={busy} onClick={() => setAction("")}>Back</Button><Button variant={action === "retire" ? "danger" : "primary"} disabled={busy} onClick={() => void mutate()}>{busy ? "Saving…" : "Confirm change"}</Button></>}><p>{form.title} · {form.pricePoints} points</p><p>{reason}</p><p>Existing learners and purchase records must be handled by the service. This action does not issue refunds locally.</p>{error && <p role="alert" className="form-error">{error}</p>}</Modal>}
  </div>;
}
export function PublishingToolsPage() {
  const { role, publishedItems, refreshMyListings } = usePlatform();
  const kind = role === "Trainer" ? "course" : "content";
  const loader = useCallback(() => refreshMyListings(), [refreshMyListings]);
  const [state, reload] = useRequest(loader); const [selected, setSelected] = useState("");
  const items = publishedItems.filter((item) => item.kind === kind), item = items.find((item) => item.id === selected);
  return <div className="stack"><Card><h2>{role} publishing tools</h2><p>Manage existing listings, versions, licences and usage. Unavailable services display an error without pretending to save changes.</p><RequestState state={state} reload={reload}><FormField label="Choose a listing"><select value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">Select a listing</option>{items.map((item) => <option key={item.id} value={item.id}>{item.title} — {item.status}</option>)}</select></FormField></RequestState></Card>{item && <ListingManagement key={`${kind}:${item.id}`} item={item} />}<PublishingAnalytics kind={kind} /></div>;
}
export function AdminOperationsPage() {
  const [tab, setTab] = useState("reports"), [range, setRange] = useState({ from: "", to: "" });
  const [status, setStatus] = useState("pending"), [query, setQuery] = useState("");
  const loader = useCallback(() => tab === "reports" ? api.listReports({ status }) : tab === "audit" ? api.listAuditLogs({ ...range, search: query }) : tab === "activity" ? api.getActivityReport(range) : Promise.resolve(null), [tab, status, range, query]);
  const [state, reload] = useRequest(loader);
  const [adjustment, setAdjustment] = useState({ userId: "", bucket: "available", delta: "", reason: "" });
  const [pending, setPending] = useState(null), [reason, setReason] = useState(""), [decision, setDecision] = useState("resolved");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  const confirm = async () => {
    setBusy(true); setError("");
    try { if (pending.type === "points") await api.adjustPoints(pending.input, pending.requestKey); else await api.decideReport(pending.id, { decision, reason: reason.trim() }); setPending(null); setSuccess("The service accepted and recorded the administration action."); void reload(); }
    catch (error) { setError(api.serviceMessage(error)); } finally { setBusy(false); }
  };
  const validAdjustment = adjustment.userId.trim() && Number.isInteger(Number(adjustment.delta)) && Number(adjustment.delta) !== 0 && adjustment.reason.trim().length >= 5;
  return <div className="stack"><Card><h2>Administration operations</h2><div className="button-row" role="group" aria-label="Administration views">{[["reports", "Reports"], ["points", "Points adjustment"], ["audit", "Audit log"], ["activity", "Activity report"]].map(([key, label]) => <Button key={key} variant={tab === key ? "primary" : "secondary"} aria-pressed={tab === key} onClick={() => { setTab(key); setSuccess(""); }}>{label}</Button>)}</div></Card>
    {success && <p role="status">{success}</p>}
    {tab === "points" ? <Card><h3>Adjust wallet points</h3><p>Use the exact account ID from Users &amp; Roles. The service must validate the adjustment, apply it atomically and record an audit entry.</p><FormField label="Account ID"><input value={adjustment.userId} onChange={(e) => setAdjustment({ ...adjustment, userId: e.target.value })} /></FormField><FormField label="Balance bucket"><select value={adjustment.bucket} onChange={(e) => setAdjustment({ ...adjustment, bucket: e.target.value })}>{["available", "frozen", "expired", "blocked"].map((value) => <option key={value}>{value}</option>)}</select></FormField><FormField label="Point change (positive to add, negative to remove)"><input type="number" step={1} value={adjustment.delta} onChange={(e) => setAdjustment({ ...adjustment, delta: e.target.value })} /></FormField><FormField label="Administration reason"><textarea value={adjustment.reason} onChange={(e) => setAdjustment({ ...adjustment, reason: e.target.value })} /></FormField><Button disabled={!validAdjustment} onClick={() => { setError(""); setPending({ type: "points", requestKey: globalThis.crypto.randomUUID(), input: { ...adjustment, userId: adjustment.userId.trim(), delta: Number(adjustment.delta), reason: adjustment.reason.trim() } }); }}>Review points adjustment</Button></Card>
    : <Card>{tab === "reports" ? <FormField label="Report status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Pending</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></FormField> : <DateRange value={range} onChange={setRange} />}{tab === "audit" && <FormField label="Search audit records"><input value={query} onChange={(e) => setQuery(e.target.value)} /></FormField>}
      <RequestState state={state} reload={reload}>{tab === "reports" ? <>{!(state.data || []).length && <p>No reports match this status.</p>}{(state.data || []).map((report) => <article className="confirmation-item" key={report.id}><h3>{report.title || report.productId}</h3><p>{report.reason}</p><small>{report.category} · {report.status}</small>{report.status === "pending" && <Button variant="secondary" onClick={() => { setReason(""); setError(""); setDecision("resolved"); setPending({ type: "report", id: report.id }); }}>Review report</Button>}</article>)}</> : tab === "audit" ? <Records rows={state.data} columns={[["id", "Audit ID"], ["createdAt", "Time"], ["actorId", "Actor"], ["action", "Action"], ["targetId", "Target"], ["reason", "Reason"]]} /> : <><dl className="receipt-details">{[["activeUsers", "Active users"], ["orders", "Orders"], ["reports", "Reports"], ["revenuePoints", "Revenue points"]].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{state.data?.[key] ?? "Not supplied"}</dd></div>)}</dl><Records rows={state.data?.items} columns={[["date", "Date"], ["activeUsers", "Active users"], ["orders", "Orders"], ["reports", "Reports"]]} /></>}</RequestState>
    </Card>}
    {pending && <Modal title={pending.type === "points" ? "Confirm wallet adjustment" : "Review reported item"} onClose={() => !busy && setPending(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</Button><Button disabled={busy || (pending.type === "report" && reason.trim().length < 5)} onClick={() => void confirm()}>{busy ? "Submitting…" : "Confirm administration action"}</Button></>}>
      {pending.type === "points" ? <><p>Account: {pending.input.userId}</p><p>{pending.input.bucket}: {pending.input.delta > 0 ? "+" : ""}{pending.input.delta} points</p><p>{pending.input.reason}</p><p>This changes a financial balance and cannot be undone by closing this dialog.</p></> : <><FormField label="Decision"><select value={decision} onChange={(e) => setDecision(e.target.value)}><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></FormField><FormField label="Decision reason"><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></FormField></>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </Modal>}
  </div>;
}
