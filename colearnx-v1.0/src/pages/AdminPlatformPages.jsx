import { useEffect, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import { usePlatform } from "../context/PlatformContext";
import {
  decideContentSubmission,
  decideCourseSubmission,
  deleteAdminUser,
  getContentSubmissions,
  getCourseSubmissions,
  getAdminUsers,
  reinstateAdminUser,
  suspendAdminUser,
} from "../api/admin";
import {
  decideTrainerCertification as decideTrainerCertificationApi,
  getAdminTrainerCertifications,
} from "../api/governance";
import { Badge, Button, Card, EmptyState, FormField, Metric } from "../components/ui";

const titleCase = (value) => String(value || "").replace(/(^|_)([a-z])/g, (_match, _prefix, letter) => letter.toUpperCase());
const Status = ({ value }) => <Badge tone={String(value).toLowerCase() === "approved" || String(value).toLowerCase() === "published" ? "success" : String(value).toLowerCase() === "rejected" ? "danger" : "warning"}>{titleCase(value)}</Badge>;

function DecisionButtons({ onDecision, busy, approveValue = "approved" }) {
  const [reason, setReason] = useState("");
  return <div className="queue-actions"><input aria-label="Decision reason" placeholder="Decision reason" value={reason} onChange={(event) => setReason(event.target.value)} /><Button className="sm" disabled={busy || reason.trim().length < 3} onClick={() => onDecision(approveValue, reason.trim())}><CheckCircle2 size={14} /> Approve</Button><Button className="sm danger" disabled={busy || reason.trim().length < 3} onClick={() => onDecision("rejected", reason.trim())}><XCircle size={14} /> Reject</Button></div>;
}

export function AdminDashboardPage() {
  const { roleApplications, refundRequests, refreshAdminQueues } = usePlatform();
  const [loading, setLoading] = useState(false);
  const refresh = async () => { setLoading(true); try { await refreshAdminQueues(); } finally { setLoading(false); } };
  useEffect(() => { refresh(); }, []);
  const pendingRoles = roleApplications.filter((item) => item.status === "Pending").length;
  const pendingRefunds = refundRequests.filter((item) => item.status === "Pending").length;
  return <><section className="hero-banner"><div><span className="eyebrow light">Administrator workspace</span><h2>Review platform queues</h2><p>Every decision below is sent to the server and audited; no administrator action changes only this browser.</p><Button onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh queues"}</Button></div><ShieldCheck size={54} /></section><div className="metric-grid three"><Metric label="Pending role applications" value={pendingRoles} detail="Server-side approval queue" icon={Users} /><Metric label="Pending refunds" value={pendingRefunds} detail="Policy-evaluated requests" icon={ClipboardCheck} /><Metric label="Catalogue reviews" value="Open catalogue page" detail="Submitted courses and content" icon={BookOpen} /></div></>;
}

export function AdminRefundPage() {
  const { refundRequests, decideRefund, refreshAdminQueues } = usePlatform();
  const [busy, setBusy] = useState("");
  const decide = async (request, decision, reason) => {
    setBusy(request.id);
    try { await decideRefund(request.id, titleCase(decision), reason); } finally { setBusy(""); }
  };
  useEffect(() => { refreshAdminQueues(); }, [refreshAdminQueues]);
  if (!refundRequests.length) return <EmptyState icon={ClipboardCheck} title="No refund requests" description="Server-submitted refund requests will appear here for review." />;
  return <Card><div className="card-heading"><div><span className="eyebrow">Refund review</span><h2>Policy-evaluated requests</h2></div></div><div className="queue-list">{refundRequests.map((request) => <div key={request.id}><ClipboardCheck size={18} /><div><b>{request.course}</b><small>{request.user} · {request.paid} points · {request.basis}</small><span className="queue-detail">{request.reason}</span></div>{request.status === "Pending" ? <DecisionButtons busy={busy === request.id} onDecision={(decision, reason) => decide(request, decision, reason)} /> : <Status value={request.status} />}</div>)}</div></Card>;
}

export function AdminUsersPage() {
  const { roleApplications, decideRoleApplication, refreshAdminQueues } = usePlatform();
  const [certifications, setCertifications] = useState([]);
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [userStatus, setUserStatus] = useState("");
  const [userReasons, setUserReasons] = useState({});
  const [userError, setUserError] = useState("");
  const refresh = async () => {
    const [_, nextCertifications, response] = await Promise.all([
      refreshAdminQueues(),
      getAdminTrainerCertifications(),
      getAdminUsers({ status: userStatus || undefined, search: userSearch || undefined }),
    ]);
    setCertifications(nextCertifications);
    setUsers(response.items);
  };
  useEffect(() => { refresh(); }, []);
  const decideRole = async (id, decision, reason) => { setBusy(id); try { await decideRoleApplication(id, titleCase(decision), reason); } finally { setBusy(""); } };
  const decideCertification = async (id, decision, reason) => { setBusy(id); try { await decideTrainerCertificationApi(id, { decision, reason }); await refresh(); } finally { setBusy(""); } };
  const refreshUsers = async () => {
    setUserError("");
    try {
      const response = await getAdminUsers({ status: userStatus || undefined, search: userSearch || undefined });
      setUsers(response.items);
    } catch (error) { setUserError(error.message); }
  };
  const setReason = (id, value) => setUserReasons((current) => ({ ...current, [id]: value }));
  const actOnUser = async (user, action) => {
    const reason = userReasons[user.id]?.trim();
    if (!reason || reason.length < 3) { setUserError("A reason of at least 3 characters is required for every account action."); return; }
    if (action === "delete" && !window.confirm(`Permanently disable ${user.email}? Their records remain retained for audit.`)) return;
    setBusy(`user-${user.id}`); setUserError("");
    try {
      if (action === "suspend") await suspendAdminUser(user.id, reason);
      else if (action === "reinstate") await reinstateAdminUser(user.id, reason);
      else await deleteAdminUser(user.id, reason);
      await refreshUsers();
    } catch (error) { setUserError(error.message); } finally { setBusy(""); }
  };
  return <div className="stack"><Card><div className="card-heading"><div><span className="eyebrow">User administration</span><h2>View and control accounts</h2></div><Button variant="secondary" onClick={refreshUsers}>Refresh users</Button></div><p className="muted">Suspending or deleting an account immediately revokes its sessions. Delete is a permanent access removal; financial and moderation records are retained for audit.</p><div className="queue-actions"><input aria-label="Search users" placeholder="Search name or email" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} /><select aria-label="Filter account status" value={userStatus} onChange={(event) => setUserStatus(event.target.value)}><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="deleted">Deleted</option></select><Button className="sm" onClick={refreshUsers}>Apply filter</Button></div>{userError && <p className="form-error">{userError}</p>}{users.length ? <div className="queue-list">{users.map((user) => { const reason = userReasons[user.id] || ""; const actionBusy = busy === `user-${user.id}`; const isProtectedAdmin = user.roles.includes("admin"); return <div key={user.id}><Users size={18} /><div><b>{user.displayName}</b><small>{user.email} · {user.roles.length ? user.roles.join(", ") : "no active role"}</small><span className="queue-detail">Created {user.createdAt ? new Date(user.createdAt).toLocaleString() : "—"}</span></div><Status value={user.status} />{isProtectedAdmin ? <Badge tone="info">Admin protected</Badge> : user.status === "deleted" ? <Badge tone="neutral">Access removed</Badge> : <div className="queue-actions"><input aria-label={`Reason for ${user.email}`} placeholder="Action reason" value={reason} onChange={(event) => setReason(user.id, event.target.value)} />{user.status === "active" ? <><Button className="sm" disabled={actionBusy} onClick={() => actOnUser(user, "suspend")}>Freeze</Button><Button className="sm danger" disabled={actionBusy} onClick={() => actOnUser(user, "delete")}>Delete</Button></> : <><Button className="sm" disabled={actionBusy} onClick={() => actOnUser(user, "reinstate")}>Reinstate</Button><Button className="sm danger" disabled={actionBusy} onClick={() => actOnUser(user, "delete")}>Delete</Button></>}</div>}</div>; })}</div> : <p className="empty-copy">No accounts match the selected filter.</p>}</Card><Card><div className="card-heading"><div><span className="eyebrow">Role applications</span><h2>Access approvals</h2></div><Button variant="secondary" onClick={refresh}>Refresh</Button></div>{roleApplications.length ? <div className="queue-list">{roleApplications.map((item) => <div key={item.id}><Users size={18} /><div><b>{item.user}</b><small>{item.type} · submitted {item.submittedAt ? new Date(item.submittedAt).toLocaleString() : "—"}</small><span className="queue-detail">{item.reason}</span></div>{item.status === "Pending" ? <DecisionButtons busy={busy === item.id} onDecision={(decision, reason) => decideRole(item.id, decision, reason)} /> : <Status value={item.status} />}</div>)}</div> : <p className="empty-copy">No role applications.</p>}</Card><Card><div className="card-heading"><div><span className="eyebrow">Trainer certification</span><h2>Certification review</h2></div></div>{certifications.length ? <div className="queue-list">{certifications.map((item) => <div key={item.id}><ShieldCheck size={18} /><div><b>{item.trainer?.displayName || "Trainer"}</b><small>{item.certificationName} · {item.certificationReference || "No reference"}</small></div>{item.status === "pending" ? <DecisionButtons busy={busy === item.id} onDecision={(decision, reason) => decideCertification(item.id, decision, reason)} /> : <Status value={item.status} />}</div>)}</div> : <p className="empty-copy">No trainer certifications.</p>}</Card></div>;
}

export function AdminCatalogPage() {
  const [courses, setCourses] = useState([]);
  const [contents, setContents] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const refresh = async () => {
    setError("");
    try { const [nextCourses, nextContents] = await Promise.all([getCourseSubmissions(), getContentSubmissions()]); setCourses(nextCourses); setContents(nextContents); } catch (loadError) { setError(loadError.message); }
  };
  useEffect(() => { refresh(); }, []);
  const decide = async (kind, id, decision, reason) => {
    setBusy(id);
    try { if (kind === "course") await decideCourseSubmission(id, { decision, reason }); else await decideContentSubmission(id, { decision, reason }); await refresh(); } finally { setBusy(""); }
  };
  const queue = [...courses.map((item) => ({ ...item, kind: "course" })), ...contents.map((item) => ({ ...item, kind: "content" }))];
  if (!queue.length && !error) return <EmptyState icon={BookOpen} title="No catalogue submissions" description="Submitted trainer courses and creator content will appear here." action={<Button onClick={refresh}>Refresh</Button>} />;
  return <Card><div className="card-heading"><div><span className="eyebrow">Catalogue control</span><h2>Publication review</h2></div><Button variant="secondary" onClick={refresh}>Refresh</Button></div>{error && <p className="form-error">{error}</p>}<div className="queue-list">{queue.map((item) => <div key={`${item.kind}-${item.id}`}><span>{item.kind === "course" ? <BookOpen size={18} /> : <FileText size={18} />}</span><div><b>{item.title}</b><small>{item.owner?.displayName || "Owner"} · {item.pricePoints} points · {item.kind === "course" ? item.deliveryModes?.join(", ") : item.contentType}</small></div><DecisionButtons approveValue="published" busy={busy === item.id} onDecision={(decision, reason) => decide(item.kind, item.id, decision, reason)} /></div>)}</div></Card>;
}
