import { useCallback, useState } from "react";
import * as api from "../../api/workflows";
import { useTranslation } from "../../i18n/LanguageContext";
import { Badge, Button, Card, FormField, Modal } from "../ui";
import { RequestState, useRequest } from "../WorkflowRequest";

export function CourseReuseReport() {
  const { t, formatLocale } = useTranslation();
  const [state, reload] = useRequest(api.listCreatorCourseReuse);
  const [visible, setVisible] = useState(10);
  const rows = [...(state.data || [])].sort((a, b) =>
    b.courseCount - a.courseCount || a.title.localeCompare(b.title, formatLocale));
  return <Card className="course-reuse">
    <div className="card-heading">
      <h3 id="course-reuse-title">{t("Course reuse")}</h3>
      <Button size="sm" variant="secondary" disabled={state.status === "loading"} onClick={reload}>{t("Refresh counts")}</Button>
    </div>
    <p>{t("A course counts once across all runs, modules and versions of a resource. Draft and archived courses count while they contain a saved reference.")}</p>
    <RequestState state={state} reload={reload}>
      {rows.length ? <table aria-labelledby="course-reuse-title" className="reuse-counts">
        <thead><tr><th scope="col">{t("Resource")}</th><th scope="col">{t("Distinct courses")}</th></tr></thead>
        <tbody>{rows.slice(0, visible).map(row => <tr key={row.id}><th scope="row">{row.title}</th>
          <td>{row.courseCount.toLocaleString(formatLocale)}</td></tr>)}</tbody>
      </table> : <p>{t("Your resources will appear here, including those used in zero courses.")}</p>}
      {rows.length > visible && <Button size="sm" variant="secondary" onClick={() => setVisible(visible + 10)}>{t("Show more resources")}</Button>}
    </RequestState>
  </Card>;
}

export function PurchasePermissions({ contentId, title }) {
  const { t, formatLocale } = useTranslation();
  const loader = useCallback(() => api.listReuseLicences(contentId), [contentId]);
  const [state, reload] = useRequest(loader);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("");
  const [visible, setVisible] = useState(8);
  const purchases = [...(state.data || [])].sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));
  const needle = filter.trim().toLocaleLowerCase(formatLocale);
  const rows = purchases.filter(row => [row.buyerLabel, row.orderNo].some(value =>
    value?.toLocaleLowerCase(formatLocale).includes(needle)));
  const buyer = row => row.buyerLabel || t("Buyer");

  async function confirm() {
    const grant = !selected.courseReuseAllowed;
    setBusy(true);
    setError("");
    try {
      await api.setReuseLicence(contentId, selected.id, grant);
      setNotice(t(grant ? "Reuse granted for order {order}." : "Reuse withdrawn for order {order}.", { order: selected.orderNo }));
      setSelected(null);
      await reload();
    } catch (err) {
      setError(api.serviceMessage(err));
    } finally { setBusy(false); }
  }

  return <Card className="course-reuse">
    <div className="card-heading"><h3>{t("Purchase permissions")}</h3>
      <Button size="sm" variant="secondary" disabled={busy || state.status === "loading"} onClick={reload}>{t("Refresh purchases")}</Button></div>
    <p>{t("Grant course reuse to a buyer for the version they purchased. A new purchase starts with personal access.")}</p>
    {notice && <p role="status">{notice}</p>}
    <RequestState state={state} reload={reload}>
      {purchases.length > 0 && <FormField label={t("Find a buyer or order")}><input type="search" value={filter}
        onChange={e => { setFilter(e.target.value); setVisible(8); }} /></FormField>}
      <ul className="reuse-permissions">{rows.slice(0, visible).map(row => <li key={row.id}>
        <div className="reuse-purchase"><strong>{buyer(row)}</strong>
          <small>{row.orderNo} · {t("Version {version}", { version: row.version })} · {new Date(row.purchasedAt).toLocaleDateString(formatLocale)}</small>
        </div>
        <Badge tone={row.courseReuseAllowed ? "success" : "neutral"}>{t(row.courseReuseAllowed ? "Reuse granted" : "Personal access")}</Badge>
        <Button size="sm" variant="secondary" onClick={() => { setError(""); setNotice(""); setSelected(row); }}>
          {t(row.courseReuseAllowed ? "Withdraw permission" : "Grant reuse")}
        </Button>
      </li>)}</ul>
      {!rows.length && <p>{t(purchases.length ? "No purchases match this search." : "Eligible purchases will appear here once a buyer purchases this resource.")}</p>}
      {rows.length > visible && <Button size="sm" variant="secondary" onClick={() => setVisible(visible + 8)}>{t("Show more purchases")}</Button>}
    </RequestState>
    {selected && <Modal title={t(selected.courseReuseAllowed ? "Withdraw course reuse?" : "Grant course reuse?")}
      onClose={() => !busy && setSelected(null)} footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setSelected(null)}>{t("Cancel")}</Button>
        <Button disabled={busy} onClick={confirm}>{t(busy ? "Saving…" : selected.courseReuseAllowed ? "Withdraw permission" : "Grant reuse")}</Button>
      </>}>
      <p><strong>{title}</strong> · {t("Version {version}", { version: selected.version })}</p>
      <p>{buyer(selected)} · {selected.orderNo}</p>
      <p>{t(selected.courseReuseAllowed ? "The buyer cannot make a new course selection with this licence. Previously saved references stay in place."
        : "This buyer may include the purchased version in courses they manage as a trainer.")}</p>
      {error && <p role="alert" className="form-error">{t(error)}</p>}
    </Modal>}
  </Card>;
}

export function CourseResourceEditor({ courseId }) {
  const { t } = useTranslation();
  const loader = useCallback(() => api.listCourseResourceOptions(courseId), [courseId]);
  const [state, reload] = useRequest(loader);
  const [notice, setNotice] = useState("");
  return <Card className="course-reuse">
    <h3>{t("Combine purchased resources")}</h3>
    <p>{t("Select your own resources or a purchased version with course reuse permission.")}</p>
    {notice && <p role="status">{t(notice)}</p>}
    <RequestState state={state} reload={reload}>
      {state.data && <ResourceSelection courseId={courseId} options={state.data} reload={reload} setNotice={setNotice} />}
    </RequestState>
  </Card>;
}

function ResourceSelection({ courseId, options, reload, setNotice }) {
  const { t } = useTranslation();
  const previous = options.filter(row => row.selected).map(row => row.id);
  const [selected, setSelected] = useState(previous);
  const [validation, setValidation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = selected.length !== previous.length || previous.some(id => !selected.includes(id));
  async function submit(save) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (save) {
        await api.saveCourseResources(courseId, selected, validation, previous);
        setNotice("The course resource selection was saved by the service.");
        await reload();
      } else {
        const result = await api.validateCourseResources(courseId, selected);
        if (!result.allowed || !result.validationId) throw new Error(result.explanation);
        setValidation(result.validationId);
      }
    } catch (err) {
      setValidation(null);
      setError(api.serviceMessage(err));
    } finally { setBusy(false); }
  }
  const refresh = <Button variant="secondary" disabled={busy} onClick={reload}>{t("Refresh permissions")}</Button>;
  if (!options.length) return <><p>{t("No eligible purchased resources are available.")}</p>{refresh}</>;
  return <>
    <ul className="reuse-permissions">{options.map(row => <li key={row.id}>
      <label className="check-label"><input type="checkbox" checked={selected.includes(row.id)}
        disabled={busy || (!row.courseReuseAllowed && !selected.includes(row.id))}
        onChange={e => {
          setSelected(e.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id));
          setValidation(null); setError(""); setNotice("");
        }} />
        <span>{row.title} · {t("Version {version}", { version: row.version })}</span>
      </label>
      <Badge tone={row.courseReuseAllowed ? "success" : "neutral"}>{t(row.courseReuseAllowed ? "Reuse allowed" : "Reuse unavailable")}</Badge>
    </li>)}</ul>
    {changed && !selected.length && <p>{t("Saving will remove all resources from this draft.")}</p>}
    {error && <p role="alert" className="form-error">{t(error)}</p>}
    <div className="button-row">
      <Button variant="secondary" disabled={busy || !changed} onClick={() => submit(false)}>{t("Check selected licences")}</Button>
      <Button disabled={busy || !validation} onClick={() => submit(true)}>{t("Confirm resource selection")}</Button>
      {!changed && refresh}
      {error && <Button variant="secondary" disabled={busy} onClick={reload}>{t("Reload resources")}</Button>}
    </div>
  </>;
}
