import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
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
  getAdminUser,
  getContentSubmissions,
  getCourseSubmissions,
  getAdminUsers,
  previewContentSubmission,
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

function DecisionButtons({ onDecision, busy, approveValue = "approved", approvalDisabled = false }) {
  const [reason, setReason] = useState("");
  return <div className="queue-actions"><input aria-label="Decision reason" placeholder="Decision reason" value={reason} onChange={(event) => setReason(event.target.value)} /><Button className="sm" disabled={busy || approvalDisabled || reason.trim().length < 3} onClick={() => onDecision(approveValue, reason.trim())}><CheckCircle2 size={14} /> Approve</Button><Button className="sm danger" disabled={busy || reason.trim().length < 3} onClick={() => onDecision("rejected", reason.trim())}><XCircle size={14} /> Reject</Button></div>;
}

function ContentReviewActions({ item, busy, onDecision }) {
  const [previewed, setPreviewed] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const fileReady = String(item.fileStatus || "").toLowerCase() === "ready";

  const preview = async () => {
    let previewWindow = null;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      previewWindow = window.open("", "_blank");
      if (!previewWindow) throw new Error("Preview was blocked. Allow pop-ups and try again.");
      previewWindow.opener = null;
      const result = await previewContentSubmission(item.id);
      previewWindow.location.replace(result.previewUrl);
      setPreviewed(true);
    } catch (loadError) {
      previewWindow?.close();
      setPreviewError(loadError.message);
    } finally {
      setPreviewBusy(false);
    }
  };

  return <div className="stack compact-stack"><div className="queue-actions"><Button type="button" className="sm" variant="secondary" disabled={!fileReady || busy || previewBusy} onClick={preview}><ExternalLink size={14} /> {previewBusy ? "Opening…" : "Preview file"}</Button>{!fileReady && <small>File must be verified before it can be previewed.</small>}</div>{previewError && <p className="form-error" role="alert">{previewError}</p>}<DecisionButtons approveValue="published" busy={busy || previewBusy} approvalDisabled={!previewed} onDecision={onDecision} />{!previewed && fileReady && <small className="muted">Preview the private file before publishing.</small>}</div>;
}

export function AdminDashboardPage() {
  const { roleApplications, refundRequests, refreshAdminQueues } = usePlatform();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [queueError, setQueueError] = useState("");
  const refresh = async () => {
    setLoading(true);
    setQueueError("");
    try {
      const result = await refreshAdminQueues();
      if (result.errors?.roles) setQueueError(`Role applications could not be refreshed: ${result.errors.roles.message}`);
    } catch (loadError) {
      setQueueError(`Administrator queues could not be refreshed: ${loadError.message}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);
  const pendingRoleApplications = roleApplications.filter((item) => item.status === "Pending");
  const pendingRoles = pendingRoleApplications.length;
  const pendingRefunds = refundRequests.filter((item) => item.status === "Pending").length;
  return <><section className="hero-banner"><div><span className="eyebrow light">Administrator workspace</span><h2>Review platform queues</h2><p>Every decision below is sent to the server and audited; no administrator action changes only this browser.</p><div className="button-row"><Button onClick={() => navigate("/admin/applications")}>Review applications <ArrowRight size={16} /></Button><Button variant="glass" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh queues"}</Button></div></div><ShieldCheck size={54} /></section>{queueError && <p className="form-error" role="alert">{queueError}</p>}<div className="metric-grid three"><Metric label="Pending role applications" value={pendingRoles} detail="Open Role Applications to review each applicant" icon={Users} /><Metric label="Pending refunds" value={pendingRefunds} detail="Policy-evaluated requests" icon={ClipboardCheck} /><Metric label="Catalogue reviews" value="Open catalogue page" detail="Submitted courses and content" icon={BookOpen} /></div><Card><div className="card-heading"><div><span className="eyebrow">Role governance</span><h3>Pending applicants</h3><p>See who is waiting for Creator or Trainer access before opening the full review.</p></div><Button variant="secondary" onClick={() => navigate("/admin/applications")}>Open review queue <ArrowRight size={15} /></Button></div>{pendingRoleApplications.length ? <div className="queue-list">{pendingRoleApplications.slice(0, 4).map((application) => <div key={application.id}><span className="admin-user-avatar">{displayValue(application.user).slice(0, 1).toUpperCase()}</span><div><b>{displayValue(application.user)}</b><small>{application.type} application</small><span className="queue-detail">Submitted {application.submittedAt ? new Date(application.submittedAt).toLocaleString() : "date unavailable"}</span></div><Badge tone="warning">Pending</Badge></div>)}</div> : <p className="empty-copy">No role applications are waiting for review.</p>}</Card></>;
}

const accountStatusTone = (status) => status === "active" ? "success" : status === "suspended" ? "warning" : "danger";
const applicationStatusTone = (status) => status === "Approved" ? "success" : status === "Rejected" ? "danger" : "warning";
const displayValue = (value) => String(value || "").trim() || "Not supplied";

export function AdminRoleApplicationsPage() {
  const { roleApplications, decideRoleApplication, refreshAdminRoleApplications } = usePlatform();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState("Pending");
  const [selectedId, setSelectedId] = useState("");
  const [applicant, setApplicant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileRevision, setProfileRevision] = useState(0);
  const [busy, setBusy] = useState("");
  const [decisionReason, setDecisionReason] = useState("");
  const [error, setError] = useState("");
  const [profileError, setProfileError] = useState("");
  const refreshRevision = useRef(0);

  const filteredApplications = useMemo(() => statusFilter === "All"
    ? roleApplications
    : roleApplications.filter((item) => item.status === statusFilter), [roleApplications, statusFilter]);
  const selectedApplication = filteredApplications.find((item) => item.id === selectedId) || null;
  const requestedStatus = statusFilter === "All" ? "" : statusFilter.toLowerCase();
  const profileMatchesSelection = applicant?.id === selectedApplication?.userId;
  const displayedApplicant = profileMatchesSelection ? applicant : null;
  const profileUnavailable = profileLoading || !profileMatchesSelection || Boolean(profileError);
  const inactiveApplicant = displayedApplicant && displayedApplicant.status !== "active";
  const profileValue = (value) => profileError ? "Unavailable" : profileMatchesSelection ? displayValue(value) : "Loading…";

  const refresh = async () => {
    const requestRevision = refreshRevision.current + 1;
    refreshRevision.current = requestRevision;
    setLoading(true);
    setError("");
    try { await refreshAdminRoleApplications(requestedStatus); }
    catch (loadError) {
      if (requestRevision === refreshRevision.current) setError(loadError.message);
    } finally {
      if (requestRevision === refreshRevision.current) setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [statusFilter, refreshAdminRoleApplications]);

  useEffect(() => {
    if (!filteredApplications.length) {
      if (selectedId) {
        setSelectedId("");
        setDecisionReason("");
      }
      return;
    }
    if (!selectedId || !filteredApplications.some((application) => application.id === selectedId)) {
      setSelectedId(filteredApplications[0].id);
      setDecisionReason("");
    }
  }, [filteredApplications, selectedId]);

  useEffect(() => {
    let current = true;
    setApplicant(null);
    setProfileError("");
    if (!selectedApplication?.userId) {
      setProfileLoading(false);
      return () => { current = false; };
    }
    setProfileLoading(true);
    getAdminUser(selectedApplication.userId)
      .then((user) => { if (current) setApplicant(user); })
      .catch((loadError) => { if (current) setProfileError(loadError.message); })
      .finally(() => { if (current) setProfileLoading(false); });
    return () => { current = false; };
  }, [selectedApplication?.userId, profileRevision]);

  const selectApplication = (id) => {
    setSelectedId(id);
    setDecisionReason("");
    setError("");
  };

  const decide = async (decision) => {
    if (busy || !selectedApplication || profileUnavailable || decisionReason.trim().length < 3) return;
    if (decision === "Approved" && inactiveApplicant) return;
    setBusy(selectedApplication.id);
    setError("");
    try {
      await decideRoleApplication(selectedApplication.id, decision, decisionReason.trim());
      setDecisionReason("");
      setSelectedId("");
      setProfileRevision((value) => value + 1);
      try { await refreshAdminRoleApplications(requestedStatus); }
      catch { setError("The decision was saved, but the application queue could not be refreshed. Refresh the page before making another decision."); }
    } catch (decisionError) {
      setError(decisionError.message);
    } finally {
      setBusy("");
    }
  };

  return <div className="stack">
    <Card>
      <div className="card-heading">
        <div><span className="eyebrow">Role governance</span><h2>Applicant review queue</h2><p>Review the applicant identity and submitted evidence before granting Creator or Trainer access.</p></div>
        <div className="button-row"><Badge tone={statusFilter === "Pending" ? "warning" : "neutral"}>{filteredApplications.length} {statusFilter.toLowerCase()}</Badge><Button variant="secondary" onClick={refresh} disabled={loading || Boolean(busy)}>{loading ? "Refreshing…" : "Refresh"}</Button></div>
      </div>
      <div className="role-application-toolbar">
        <label><span>Status</span><select aria-label="Filter role applications" value={statusFilter} disabled={loading || Boolean(busy)} onChange={(event) => { setStatusFilter(event.target.value); setSelectedId(""); setDecisionReason(""); }}><option>Pending</option><option>Approved</option><option>Rejected</option><option>All</option></select></label>
        <small>Decision comments are recorded and visible to the applicant.</small>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Card>

    <div className="admin-application-layout">
      <Card className="admin-application-list-card">
        <div className="card-heading"><div><span className="eyebrow">Applications</span><h3>{statusFilter} requests</h3></div><Badge>{filteredApplications.length}</Badge></div>
        {loading ? <p className="empty-copy">Loading applications…</p> : filteredApplications.length ? <div className="role-application-list">{filteredApplications.map((application) => <button type="button" disabled={Boolean(busy)} key={application.id} className={`role-application-row ${selectedApplication?.id === application.id ? "selected" : ""}`} aria-pressed={selectedApplication?.id === application.id} onClick={() => selectApplication(application.id)}><span className="admin-user-avatar">{displayValue(application.user).slice(0, 1).toUpperCase()}</span><span><b>{displayValue(application.user)}</b><small>{application.type} application</small><em>Submitted {application.submittedAt ? new Date(application.submittedAt).toLocaleString() : "date unavailable"}</em></span><Badge tone={applicationStatusTone(application.status)}>{application.status}</Badge></button>)}</div> : <EmptyState icon={Users} title={`No ${statusFilter.toLowerCase()} applications`} description="New Creator and Trainer applications will appear here after submission." />}
      </Card>

      {selectedApplication ? <div className="stack">
        <Card>
          <div className="card-heading"><div><span className="eyebrow">Applicant identity</span><h3>{displayValue(selectedApplication.user)}</h3><p>{profileError ? "Profile unavailable" : profileLoading || !profileMatchesSelection ? "Loading the audited account profile…" : displayValue(displayedApplicant?.email)}</p></div>{displayedApplicant && <Badge tone={accountStatusTone(displayedApplicant.status)}>{titleCase(displayedApplicant.status)}</Badge>}</div>
          {profileError && <p className="form-error" role="alert">Profile could not be loaded: {profileError}</p>}
          <dl className="detail-list applicant-profile-list">
            <div><dt>Full name</dt><dd>{displayValue(displayedApplicant?.profile?.fullName || selectedApplication.user)}</dd></div>
            <div><dt>Email</dt><dd>{profileValue(displayedApplicant?.email)}</dd></div>
            <div><dt>Current roles</dt><dd>{profileError ? "Unavailable" : displayedApplicant?.roles?.length ? displayedApplicant.roles.map(titleCase).join(", ") : profileMatchesSelection ? "Member" : "Loading…"}</dd></div>
            <div><dt>Phone</dt><dd>{profileValue(displayedApplicant?.profile?.phone)}</dd></div>
            <div><dt>Location</dt><dd>{profileValue(displayedApplicant?.profile?.location)}</dd></div>
            <div><dt>Bio</dt><dd>{profileValue(displayedApplicant?.profile?.bio)}</dd></div>
          </dl>
          {selectedApplication.userId && <div className="button-row profile-review-actions"><Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={() => navigate(`/admin/users/${selectedApplication.userId}`)}>Open full account <ArrowRight size={15} /></Button></div>}
        </Card>

        <Card>
          <div className="card-heading"><div><span className="eyebrow">Submitted application</span><h3>{selectedApplication.type} access</h3><p>Submitted {selectedApplication.submittedAt ? new Date(selectedApplication.submittedAt).toLocaleString() : "date unavailable"}</p></div><Badge tone={applicationStatusTone(selectedApplication.status)}>{selectedApplication.status}</Badge></div>
          <dl className="detail-list role-application-detail-list">
            <div><dt>Subject category</dt><dd>{displayValue(selectedApplication.category)}</dd></div>
            <div><dt>Relevant experience</dt><dd>{displayValue(selectedApplication.experience)}</dd></div>
            <div><dt>Portfolio</dt><dd>{selectedApplication.portfolioUrl ? <a href={selectedApplication.portfolioUrl} target="_blank" rel="noreferrer">{selectedApplication.portfolio}<ExternalLink size={13} /></a> : displayValue(selectedApplication.portfolio)}</dd></div>
            <div><dt>Why they are applying</dt><dd>{displayValue(selectedApplication.reason)}</dd></div>
          </dl>
          {inactiveApplicant && <div className="warning-box compact"><ShieldCheck size={16} /><div><b>Approval unavailable</b><p>This account is {displayedApplicant.status}. It may be rejected, but a role cannot be granted until the account is active.</p></div></div>}
          {selectedApplication.status === "Pending" ? <div className="application-review"><FormField label="Decision reason" hint="Required, at least 3 characters. The applicant can see this comment."><textarea disabled={profileUnavailable || Boolean(busy)} aria-label={`Decision reason for ${selectedApplication.user} ${selectedApplication.type} application`} value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} placeholder="Record the evidence reviewed and why access should be granted or declined" /></FormField><div className="button-row"><Button disabled={profileUnavailable || Boolean(inactiveApplicant) || Boolean(busy) || decisionReason.trim().length < 3} onClick={() => decide("Approved")}><CheckCircle2 size={15} /> {busy === selectedApplication.id ? "Saving…" : "Approve application"}</Button><Button variant="danger" disabled={profileUnavailable || Boolean(busy) || decisionReason.trim().length < 3} onClick={() => decide("Rejected")}><XCircle size={15} /> Reject application</Button></div></div> : <div className="application-review"><span className="eyebrow">Decision comment</span><p className="application-copy">{displayValue(selectedApplication.decisionReason)}</p></div>}
        </Card>
      </div> : <EmptyState icon={Users} title="Select an application" description="Choose an application from the queue to review the applicant and supporting information." />}
    </div>
  </div>;
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
    try {
      const [nextCourses, nextContents] = await Promise.all([getCourseSubmissions(), getContentSubmissions()]);
      setCourses(nextCourses);
      setContents(nextContents);
    } catch (loadError) {
      setError(loadError.message);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const decide = async (kind, id, decision, reason) => {
    setBusy(`${kind}-${id}`);
    setError("");
    try {
      if (kind === "course") await decideCourseSubmission(id, { decision, reason });
      else await decideContentSubmission(id, { decision, reason });
      await refresh();
    } catch (decisionError) {
      setError(decisionError.message);
    } finally {
      setBusy("");
    }
  };

  const queue = [
    ...courses.map((item) => ({ ...item, kind: "course" })),
    ...contents.map((item) => ({ ...item, kind: "content" })),
  ];

  if (!queue.length && !error) {
    return <EmptyState icon={BookOpen} title="No catalogue submissions" description="Submitted trainer courses and creator content will appear here." action={<Button onClick={refresh}>Refresh</Button>} />;
  }

  return <Card>
    <div className="card-heading">
      <div><span className="eyebrow">Catalogue control</span><h2>Publication review</h2><p>Content must be privately previewed before it can be published.</p></div>
      <Button variant="secondary" onClick={refresh} disabled={Boolean(busy)}>Refresh</Button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="queue-list">
      {queue.map((item) => <div key={`${item.kind}-${item.id}`}>
        <span>{item.kind === "course" ? <BookOpen size={18} /> : <FileText size={18} />}</span>
        <div>
          <b>{item.title}</b>
          <small>{item.owner?.displayName || "Owner"} · {item.pricePoints} points · {item.kind === "course" ? item.deliveryModes?.join(", ") : item.contentType}</small>
          {item.kind === "content" && <span className="queue-detail">Private file status: {item.fileStatus || "missing"}</span>}
        </div>
        {item.kind === "content"
          ? <ContentReviewActions item={item} busy={busy === `${item.kind}-${item.id}`} onDecision={(decision, reason) => decide(item.kind, item.id, decision, reason)} />
          : <DecisionButtons approveValue="published" busy={busy === `${item.kind}-${item.id}`} onDecision={(decision, reason) => decide(item.kind, item.id, decision, reason)} />}
      </div>)}
    </div>
  </Card>;
}
