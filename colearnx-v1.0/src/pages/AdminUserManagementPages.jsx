import { getFormatLocale, useTranslation } from "../i18n/LanguageContext";
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, ShieldAlert, ShieldCheck, UserCog, Users } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import {
  deleteAdminUser,
  getAdminUser,
  getAdminUsers,
  reinstateAdminUser,
  setAdminUserRole,
  suspendAdminUser,
} from "../api/admin";
import { usePlatform } from "../context/PlatformContext";
import { Badge, Button, Card, EmptyState, FormField } from "../components/ui";

const roleLabel = (role) => role.charAt(0).toUpperCase() + role.slice(1);

function AccountStatus({ status }) {
  const tone = status === "active" ? "success" : status === "suspended" ? "warning" : "danger";
  return <Badge tone={tone}>{t(roleLabel(status))}</Badge>;
}

// A Trainer role stays non-operational until an administrator approves the
// trainer certification, which blocks the course editor and the publishing
// tools. This is the routed administrator screen, so the review queue lives
// here rather than on an unrouted duplicate of it.
function TrainerCertificationReview() {
  const { t } = useTranslation();
  const { adminTrainerCertifications, decideTrainerCertification, refreshAdminQueues } = usePlatform();
  const [reasons, setReasons] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { void refreshAdminQueues().catch((queueError) => setError(queueError.message)); }, [refreshAdminQueues]);
  const pending = adminTrainerCertifications.filter((item) => item.status === "pending");
  const decide = async (certification, decision) => {
    const reason = (reasons[certification.id] || "").trim();
    if (reason.length < 3) { setError("Enter a decision reason of at least 3 characters."); return; }
    setBusy(certification.id); setError("");
    try {
      await decideTrainerCertification(certification.id, decision, reason);
      setReasons((current) => ({ ...current, [certification.id]: "" }));
    } catch (decisionError) { setError(decisionError.message); } finally { setBusy(""); }
  };
  return <Card>
    <div className="card-heading">
      <div><span className="eyebrow">{t("Trainer certification")}</span><h2>{t("Certification review")}</h2></div>
      <Badge>{pending.length}{t(" pending")}</Badge>
    </div>
    <p className="muted">{t("An approved certification is what makes a Trainer operational. Until then their course editor and publishing tools stay closed.")}</p>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
    {pending.length ? <div className="queue-list">{pending.map((certification) => <div key={certification.id}>
      <ShieldCheck size={18} />
      <div>
        <b>{certification.trainer?.displayName || t("Trainer")}</b>
        <small>{certification.certificationName}{certification.certificationReference ? ' · ' + certification.certificationReference : ""}</small>
        <span className="queue-detail">{certification.evidenceUrl ? <a href={certification.evidenceUrl} target="_blank" rel="noreferrer noopener">{t("Supporting evidence")}</a> : t("No evidence URL supplied")}</span>
      </div>
      <div className="queue-actions">
        <input aria-label={"Decision reason for " + (certification.trainer?.displayName || "trainer")} placeholder={t("Decision reason")} value={reasons[certification.id] || ""} onChange={(event) => setReasons((current) => ({ ...current, [certification.id]: event.target.value }))} />
        <Button className="sm" disabled={busy === certification.id} onClick={() => void decide(certification, "Approved")}>{t("Approve")}</Button>
        <Button className="sm danger" disabled={busy === certification.id} onClick={() => void decide(certification, "Rejected")}>{t("Reject")}</Button>
      </div>
    </div>)}</div> : <p className="empty-copy">{t("No trainer certifications are waiting for review.")}</p>}
  </Card>;
}

export function AdminUsersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, hasNext: false });

  const load = async (nextPage = page) => {
    setLoading(true);
    setError("");
    try {
      const response = await getAdminUsers({ search: search || undefined, status: status || undefined, page: nextPage, limit: 50 });
      setUsers(response.items);
      setPage(nextPage);
      setPagination({ total: response.total, hasNext: response.hasNext });
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(1); }, []);

  return <div className="stack"><Card>
    <div className="card-heading">
      <div><span className="eyebrow">{t("User administration")}</span><h2>{t("Platform users")}</h2></div>
      <Button variant="secondary" onClick={() => void load(page)} disabled={loading}>{loading ? t("Refreshing…") : t("Refresh")}</Button>
    </div>
    <p className="muted">{t("Select a user to inspect their profile, roles and account controls. Delete is available only on the account-detail page.")}</p>
    <div className="queue-actions">
      <input aria-label={t("Search users")} placeholder={t("Search name or email")} value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label={t("Filter account status")} value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">{t("All visible accounts")}</option>
        <option value="active">{t("Active")}</option>
        <option value="suspended">{t("Suspended")}</option>
      </select>
      <Button className="sm" onClick={() => void load(1)} disabled={loading}>{t("Apply filter")}</Button>
    </div>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
    {users.length ? <><div className="result-bar"><span><b>{pagination.total || users.length}</b>{t(" accounts · page ")}{page}</span><small>{users.length}{t(" accounts loaded on this page")}</small></div><div className="admin-user-list">{users.map((user) => <div key={user.id} className="admin-user-row">
      <button type="button" className="admin-user-row-main" onClick={() => navigate(`/admin/users/${user.id}`)}>
        <span className="admin-user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
        <span><b>{user.displayName}</b><small>{user.email}</small><em>{user.roles.length ? user.roles.map(roleLabel).join(", ") : t("No active role")}{t(" · joined ")}{user.createdAt ? new Date(user.createdAt).toLocaleDateString(getFormatLocale()) : "—"}</em></span>
        <AccountStatus status={user.status} />
        <ChevronRight size={18} />
      </button>
    </div>)}</div><nav className="pagination" aria-label={t("User pages")}><Button variant="secondary" size="sm" disabled={loading || page <= 1} onClick={() => void load(page - 1)}>{t("Previous")}</Button><span>{t("Page ")}{page}</span><Button variant="secondary" size="sm" disabled={loading || !pagination.hasNext} onClick={() => void load(page + 1)}>{t("Next")}</Button></nav></> : <EmptyState icon={Users} title={t("No accounts match")} description={t("Adjust the search or status filter to view another account.")} />}
  </Card><TrainerCertificationReview /></div>;
}
export function AdminUserDetailPage() {
  const { t } = useTranslation();
  const { userId } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    if (!userId) return;
    setError("");
    try { setUser(await getAdminUser(userId)); } catch (loadError) { setError(loadError.message); }
  };
  useEffect(() => { load(); }, [userId]);
  const requireReason = () => {
    const value = reason.trim();
    if (value.length >= 3) return value;
    setError("Enter an administration reason of at least 3 characters before continuing.");
    return null;
  };
  const runAccountAction = async (action) => {
    const actionReason = requireReason();
    if (!actionReason || !user) return;
    if (action === "delete" && !window.confirm(`Delete ${user.email}? It will disappear from the administrator list and this email can be registered again. Linked financial records are retained without the account's personal details.`)) return;
    setBusy(action); setError("");
    try {
      if (action === "delete") {
        await deleteAdminUser(user.id, actionReason);
        navigate("/admin/users", { replace: true });
        return;
      }
      const updated = action === "suspend"
        ? await suspendAdminUser(user.id, actionReason)
        : await reinstateAdminUser(user.id, actionReason);
      setUser((current) => ({ ...current, ...updated }));
    } catch (actionError) { setError(actionError.message); } finally { setBusy(""); }
  };
  const runRoleAction = async (roleCode, action) => {
    const actionReason = requireReason();
    if (!actionReason || !user) return;
    setBusy(`${action}-${roleCode}`); setError("");
    try { setUser(await setAdminUserRole(user.id, { roleCode, action, reason: actionReason })); } catch (actionError) { setError(actionError.message); } finally { setBusy(""); }
  };
  if (!user && !error) return <EmptyState icon={UserCog} title={t("Loading user")} description={t("Retrieving the server-side account record.")} />;
  if (!user) return <EmptyState icon={ShieldAlert} title={t("User unavailable")} description={t(error)} action={<Button onClick={() => navigate("/admin/users")}>{t("Return to users")}</Button>} />;
  const accountIsAdmin = user.roles.includes("admin");
  const canChangeAccountStatus = user.status !== "deleted" && !accountIsAdmin;
  return <div className="stack"><div className="button-row"><Button variant="secondary" className="sm" onClick={() => navigate("/admin/users")}><ArrowLeft size={15} />{t(" All users")}</Button></div><Card><div className="card-heading"><div><span className="eyebrow">{t("User profile")}</span><h2>{user.displayName}</h2><p>{user.email}</p></div><AccountStatus status={user.status} /></div><dl className="detail-list"><div><dt>{t("Full name")}</dt><dd>{user.profile.fullName}</dd></div><div><dt>{t("Phone")}</dt><dd>{user.profile.phone || t("Not supplied")}</dd></div><div><dt>{t("Location")}</dt><dd>{user.profile.location || t("Not supplied")}</dd></div><div><dt>{t("Joined")}</dt><dd>{user.createdAt ? new Date(user.createdAt).toLocaleString(getFormatLocale()) : "—"}</dd></div><div><dt>{t("Bio")}</dt><dd>{user.profile.bio || t("Not supplied")}</dd></div></dl></Card><Card><div className="card-heading"><div><span className="eyebrow">{t("Role access")}</span><h2>{t("Granted roles")}</h2><p>{t("Role changes are audited and revoke the user’s active sessions.")}</p></div></div><div className="badge-row admin-role-badges">{user.roles.map((role) => <Badge key={role} tone={role === "admin" ? "danger" : role === "member" ? "info" : "success"}>{roleLabel(role)}</Badge>)}</div>{user.status !== "active" ? <p className="muted">{t("Role access can be changed only while the account is active.")}</p> : <><FormField label={t("Administration reason")}><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("Required for every access change")} /></FormField><div className="role-management-list">{["trainer", "creator", "admin"].map((role) => { const granted = user.roles.includes(role); const action = granted ? "revoke" : "grant"; return <div key={role}><div><b>{roleLabel(role)}</b><small>{granted ? t("Currently granted") : t("Not granted")}</small></div><Button className="sm" variant={granted ? "secondary" : "primary"} disabled={Boolean(busy)} onClick={() => runRoleAction(role, action)}>{busy === `${action}-${t(role)}` ? t("Saving…") : granted ? t("Revoke") : t("Grant")}</Button></div>; })}</div></>}</Card><Card><div className="card-heading"><div><span className="eyebrow">{t("Account status")}</span><h2>{t("Session and access control")}</h2><p>{t("Suspension immediately revokes active sessions. Deletion also removes the account from this list and releases its email for a new registration.")}</p></div></div>{error && <p className="form-error">{t(error)}</p>}{user.status === "deleted" ? <p className="muted">{t("This account has been deleted and cannot be restored through the administrator interface.")}</p> : accountIsAdmin ? <p className="muted">{t("Administrator accounts cannot be frozen or deleted from this screen. Change the administrator role first, while ensuring at least one active administrator remains.")}</p> : <><FormField label={t("Administration reason")}><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("Required for every account action")} /></FormField><div className="button-row">{user.status === "active" ? <Button disabled={Boolean(busy)} onClick={() => runAccountAction("suspend")}>{busy === "suspend" ? t("Freezing…") : t("Freeze account")}</Button> : <Button disabled={Boolean(busy)} onClick={() => runAccountAction("reinstate")}>{busy === "reinstate" ? t("Restoring…") : t("Reinstate account")}</Button>}<Button className="danger" disabled={Boolean(busy)} onClick={() => runAccountAction("delete")}>{busy === "delete" ? t("Deleting…") : t("Delete account")}</Button></div></>}</Card></div>;
}
