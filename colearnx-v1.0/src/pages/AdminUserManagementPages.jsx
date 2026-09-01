import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, ShieldAlert, Trash2, UserCog, Users } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import {
  deleteAdminUser,
  getAdminUser,
  getAdminUsers,
  reinstateAdminUser,
  setAdminUserRole,
  suspendAdminUser,
} from "../api/admin";
import { Badge, Button, Card, EmptyState, FormField, Modal } from "../components/ui";

const roleLabel = (role) => role.charAt(0).toUpperCase() + role.slice(1);

function AccountStatus({ status }) {
  const tone = status === "active" ? "success" : status === "suspended" ? "warning" : "danger";
  return <Badge tone={tone}>{roleLabel(status)}</Badge>;
}

export function AdminUsersPage() {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await getAdminUsers({ search: search || undefined, status: status || undefined });
      setUsers(response.items);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openDeleteDialog = (user) => {
    setDeleteCandidate(user);
    setDeleteReason("");
    setDeleteError("");
  };

  const closeDeleteDialog = () => {
    if (deleting) return;
    setDeleteCandidate(null);
    setDeleteReason("");
    setDeleteError("");
  };

  const deleteFromList = async () => {
    const reason = deleteReason.trim();
    if (!deleteCandidate || deleting) return;
    if (reason.length < 3) {
      setDeleteError("Enter an administration reason of at least 3 characters before deleting this account.");
      return;
    }

    setDeleting(true);
    setDeleteError("");
    try {
      await deleteAdminUser(deleteCandidate.id, reason);
      setUsers((current) => current.filter((user) => user.id !== deleteCandidate.id));
      setDeleteCandidate(null);
      setDeleteReason("");
    } catch (deleteActionError) {
      setDeleteError(deleteActionError.message);
    } finally {
      setDeleting(false);
    }
  };

  return <>
    <Card>
      <div className="card-heading">
        <div><span className="eyebrow">User administration</span><h2>Platform users</h2></div>
        <Button variant="secondary" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>
      </div>
      <p className="muted">Deleted accounts are hidden by default. Their financial and moderation records remain available to administrators through the Deleted filter.</p>
      <div className="queue-actions">
        <input aria-label="Search users" placeholder="Search name or email" value={search} onChange={(event) => setSearch(event.target.value)} />
        <select aria-label="Filter account status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="deleted">Deleted</option>
          <option value="">All statuses</option>
        </select>
        <Button className="sm" onClick={load} disabled={loading}>Apply filter</Button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {users.length ? <div className="admin-user-list">{users.map((user) => {
        const deletable = user.status !== "deleted" && !user.roles.includes("admin");
        return <div key={user.id} className="admin-user-row">
          <button type="button" className="admin-user-row-main" onClick={() => navigate(`/admin/users/${user.id}`)}>
            <span className="admin-user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
            <span><b>{user.displayName}</b><small>{user.email}</small><em>{user.roles.length ? user.roles.map(roleLabel).join(", ") : "No active role"} · joined {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</em></span>
            <AccountStatus status={user.status} />
            <ChevronRight size={18} />
          </button>
          {deletable && <Button type="button" variant="danger" size="sm" onClick={() => openDeleteDialog(user)} aria-label={`Delete ${user.email}`}><Trash2 size={15} /> Delete</Button>}
        </div>;
      })}</div> : <EmptyState icon={Users} title="No accounts match" description="Adjust the search or status filter to view another account." />}
    </Card>
    {deleteCandidate && <Modal title="Delete user account" onClose={closeDeleteDialog} footer={<><Button variant="secondary" onClick={closeDeleteDialog} disabled={deleting}>Cancel</Button><Button variant="danger" onClick={deleteFromList} disabled={deleting || deleteReason.trim().length < 3}>{deleting ? "Deleting…" : "Delete account"}</Button></>}>
      <p><b>{deleteCandidate.email}</b> will lose access immediately. This cannot be restored through the administrator interface; financial and moderation records are retained for audit.</p>
      <FormField label="Administration reason"><textarea value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="Why is this account being deleted?" rows={3} disabled={deleting} /></FormField>
      {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
    </Modal>}
  </>;
}
export function AdminUserDetailPage() {
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
    if (action === "delete" && !window.confirm(`Permanently remove access for ${user.email}? Financial and moderation records remain retained.`)) return;
    setBusy(action); setError("");
    try {
      const updated = action === "suspend" ? await suspendAdminUser(user.id, actionReason)
        : action === "reinstate" ? await reinstateAdminUser(user.id, actionReason)
          : await deleteAdminUser(user.id, actionReason);
      setUser((current) => ({ ...current, ...updated }));
    } catch (actionError) { setError(actionError.message); } finally { setBusy(""); }
  };
  const runRoleAction = async (roleCode, action) => {
    const actionReason = requireReason();
    if (!actionReason || !user) return;
    setBusy(`${action}-${roleCode}`); setError("");
    try { setUser(await setAdminUserRole(user.id, { roleCode, action, reason: actionReason })); } catch (actionError) { setError(actionError.message); } finally { setBusy(""); }
  };
  if (!user && !error) return <EmptyState icon={UserCog} title="Loading user" description="Retrieving the server-side account record." />;
  if (!user) return <EmptyState icon={ShieldAlert} title="User unavailable" description={error} action={<Button onClick={() => navigate("/admin/users")}>Return to users</Button>} />;
  const accountIsAdmin = user.roles.includes("admin");
  const canChangeAccountStatus = user.status !== "deleted" && !accountIsAdmin;
  return <div className="stack"><div className="button-row"><Button variant="secondary" className="sm" onClick={() => navigate("/admin/users")}><ArrowLeft size={15} /> All users</Button></div><Card><div className="card-heading"><div><span className="eyebrow">User profile</span><h2>{user.displayName}</h2><p>{user.email}</p></div><AccountStatus status={user.status} /></div><dl className="detail-list"><div><dt>Full name</dt><dd>{user.profile.fullName}</dd></div><div><dt>Phone</dt><dd>{user.profile.phone || "Not supplied"}</dd></div><div><dt>Location</dt><dd>{user.profile.location || "Not supplied"}</dd></div><div><dt>Joined</dt><dd>{user.createdAt ? new Date(user.createdAt).toLocaleString() : "—"}</dd></div><div><dt>Bio</dt><dd>{user.profile.bio || "Not supplied"}</dd></div></dl></Card><Card><div className="card-heading"><div><span className="eyebrow">Role access</span><h2>Granted roles</h2><p>Role changes are audited and revoke the user’s active sessions.</p></div></div><div className="badge-row admin-role-badges">{user.roles.map((role) => <Badge key={role} tone={role === "admin" ? "danger" : role === "member" ? "info" : "success"}>{roleLabel(role)}</Badge>)}</div>{user.status !== "active" ? <p className="muted">Role access can be changed only while the account is active.</p> : <><FormField label="Administration reason"><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required for every access change" /></FormField><div className="role-management-list">{["trainer", "creator", "admin"].map((role) => { const granted = user.roles.includes(role); const action = granted ? "revoke" : "grant"; return <div key={role}><div><b>{roleLabel(role)}</b><small>{granted ? "Currently granted" : "Not granted"}</small></div><Button className="sm" variant={granted ? "secondary" : "primary"} disabled={Boolean(busy)} onClick={() => runRoleAction(role, action)}>{busy === `${action}-${role}` ? "Saving…" : granted ? "Revoke" : "Grant"}</Button></div>; })}</div></>}</Card><Card><div className="card-heading"><div><span className="eyebrow">Account status</span><h2>Session and access control</h2><p>Suspension and deletion immediately revoke active sessions.</p></div></div>{error && <p className="form-error">{error}</p>}{user.status === "deleted" ? <p className="muted">This account has been deleted and cannot be restored through the administrator interface.</p> : accountIsAdmin ? <p className="muted">Administrator accounts cannot be frozen or deleted from this screen. Change the administrator role first, while ensuring at least one active administrator remains.</p> : <><FormField label="Administration reason"><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required for every account action" /></FormField><div className="button-row">{user.status === "active" ? <Button disabled={Boolean(busy)} onClick={() => runAccountAction("suspend")}>{busy === "suspend" ? "Freezing…" : "Freeze account"}</Button> : <Button disabled={Boolean(busy)} onClick={() => runAccountAction("reinstate")}>{busy === "reinstate" ? "Restoring…" : "Reinstate account"}</Button>}<Button className="danger" disabled={Boolean(busy)} onClick={() => runAccountAction("delete")}>{busy === "delete" ? "Deleting…" : "Delete account"}</Button></div></>}</Card></div>;
}
