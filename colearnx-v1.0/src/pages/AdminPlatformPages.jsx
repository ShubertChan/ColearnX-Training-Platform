import { getFormatLocale, useTranslation } from "../i18n/LanguageContext";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Paperclip,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import AdminVideoReview from "../components/video/AdminVideoReview";
import VideoEvidence from "../components/video/VideoEvidence";
import { usePlatform } from "../context/PlatformContext";
import { useAdminInbox } from "../context/AdminInboxContext";
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
import {
  canPublishReviewedAssets,
  formatReviewFileSize,
  normalizeReviewAssets,
  reviewAssetKey,
} from "../utils/adminReviewAssets";

const titleCase = (value) => String(value || "").replace(/(^|_)([a-z])/g, (_match, _prefix, letter) => letter.toUpperCase());
const Status = ({ value }) => { const { t } = useTranslation(); return (<Badge tone={String(value).toLowerCase() === "approved" || String(value).toLowerCase() === "published" ? "success" : String(value).toLowerCase() === "rejected" ? "danger" : "warning"}>{t(titleCase(value))}</Badge>); };

function DecisionButtons({ onDecision, busy, approveValue = "approved", approvalDisabled = false }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  return <div className="queue-actions"><input aria-label={t("Decision reason")} placeholder={t("Decision reason")} value={reason} onChange={(event) => setReason(event.target.value)} /><Button className="sm" disabled={busy || approvalDisabled || reason.trim().length < 3} onClick={() => onDecision(approveValue, reason.trim())}><CheckCircle2 size={14} />{t(" Approve")}</Button><Button className="sm danger" disabled={busy || reason.trim().length < 3} onClick={() => onDecision("rejected", reason.trim())}><XCircle size={14} />{t(" Reject")}</Button></div>;
}

export function ContentReviewActions({ item, busy, onDecision }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [previewedAssetKeys, setPreviewedAssetKeys] = useState(() => new Set());
  const [previewBusyKey, setPreviewBusyKey] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [readyPreview, setReadyPreview] = useState(null);
  const assets = normalizeReviewAssets(item);
  const readyAssetEntries = assets
    .map((asset, index) => ({ asset, key: reviewAssetKey(asset, index), index }))
    .filter(({ asset }) => asset.status === "ready");
  const fileCount = Math.max(Number(item.assetCount || 0), assets.length);
  const readyCount = Math.max(Number(item.readyAssetCount || 0), readyAssetEntries.length);
  const allFilesReady = assets.length > 0 && assets.every((asset) => asset.status === "ready");
  const allPreviewed = canPublishReviewedAssets(assets, previewedAssetKeys);
  const filesPanelId = `content-files-${item.id}`;

  const preview = async (asset, index) => {
    let previewWindow = null;
    const assetKey = reviewAssetKey(asset, index);
    setPreviewBusyKey(assetKey);
    setPreviewError("");
    try {
      // Verify in this page before opening a new tab; otherwise a blank tab
      // would hide the MFA dialog. Keep a direct-click fallback for browsers
      // which block popups after an asynchronous identity check.
      const result = readyPreview?.key === assetKey && Date.parse(readyPreview.expiresAt) > Date.now()
        ? readyPreview : await previewContentSubmission(item.id, asset.assetId);
      previewWindow = window.open("", "_blank");
      if (!previewWindow) {
        setReadyPreview({ ...result, key: assetKey });
        setPreviewError("Your file is ready. Click Open preview to open it in a new tab.");
        return;
      }
      previewWindow.opener = null;
      previewWindow.location.replace(result.previewUrl);
      setReadyPreview(null);
      setPreviewedAssetKeys((current) => {
        const next = new Set(current);
        next.add(assetKey);
        return next;
      });
    } catch (loadError) {
      previewWindow?.close();
      setPreviewError(loadError.message);
    } finally {
      setPreviewBusyKey("");
    }
  };

  return (
    <div className="content-review-actions">
      <div className="content-review-toolbar">
        <div className="content-file-summary">
          <Button
            type="button"
            className="sm"
            variant="secondary"
            disabled={!fileCount || busy}
            aria-expanded={expanded}
            aria-controls={filesPanelId}
            onClick={() => setExpanded((current) => !current)}
          >
            <Paperclip size={14} />
            {fileCount} {fileCount === 1 ? t("file") : t("files")}
            <ChevronDown className={expanded ? "expanded" : ""} size={14} />
          </Button>
          <small>{readyCount}{t(" ready · ")}{previewedAssetKeys.size}{t(" reviewed")}</small>
        </div>
        <DecisionButtons
          approveValue="published"
          busy={busy || Boolean(previewBusyKey)}
          approvalDisabled={!allPreviewed}
          onDecision={onDecision}
        />
      </div>

      {expanded && (
        <div className="content-review-files" id={filesPanelId}>
          <div className="content-review-files-heading">
            <div>
              <b>{t("Uploaded files")}</b>
              <small>{t("Open each verified attachment before publishing this content.")}</small>
            </div>
            <Badge tone={allPreviewed ? "success" : "info"}>
              {readyAssetEntries.filter(({ key }) => previewedAssetKeys.has(key)).length}/{readyAssetEntries.length}{t(" reviewed")}</Badge>
          </div>
          {assets.length ? (
            <div className="content-review-file-list">
              {assets.map((asset, index) => {
                const assetKey = reviewAssetKey(asset, index);
                const ready = asset.status === "ready";
                const reviewed = previewedAssetKeys.has(assetKey);
                return (
                  <div className="content-review-file" key={assetKey}>
                    <span className={`content-review-file-icon ${ready ? "ready" : ""}`}><FileText size={17} /></span>
                    <div className="content-review-file-copy">
                      <b>{asset.filename}</b>
                      <small>{asset.mediaType} · {formatReviewFileSize(asset.sizeBytes)}</small>
                    </div>
                    <Badge tone={ready ? "success" : "warning"}>{t(titleCase(asset.status))}</Badge>
                    <Button
                      type="button"
                      className="sm"
                      variant="secondary"
                      aria-label={`${reviewed ? "Preview again" : "Preview"} ${asset.filename}`}
                      disabled={!ready || busy || Boolean(previewBusyKey)}
                      onClick={() => preview(asset, index)}
                    >
                      {reviewed ? <CheckCircle2 size={14} /> : <ExternalLink size={14} />}
                      {previewBusyKey === assetKey ? t("Opening…") : readyPreview?.key === assetKey ? t("Open preview") : reviewed ? t("Preview again") : t("Preview file")}
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : <p className="empty-copy">{t("No uploaded files were found for this submission.")}</p>}
        </div>
      )}

      {previewError && <p className="form-error" role="alert">{t(previewError)}</p>}
      {!allFilesReady && assets.length > 0 && (
        <small className="muted">{t("Every uploaded file must finish verification before publishing.")}</small>
      )}
      {allFilesReady && !allPreviewed && (
        <small className="muted">{t("Preview every verified file before publishing.")}</small>
      )}
      {!assets.length && (
        <small className="muted">{t("At least one verified file is required before publishing.")}</small>
      )}
    </div>
  );
}

export function AdminDashboardPage() {
  const { t } = useTranslation();
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
  return <><section className="hero-banner"><div><span className="eyebrow light">{t("Administrator workspace")}</span><h2>{t("Review platform queues")}</h2><p>{t("Every decision below is sent to the server and audited; no administrator action changes only this browser.")}</p><div className="button-row"><Button onClick={() => navigate("/admin/applications")}>{t("Review applications ")}<ArrowRight size={16} /></Button><Button variant="glass" onClick={refresh} disabled={loading}>{loading ? t("Refreshing…") : t("Refresh queues")}</Button></div></div><ShieldCheck size={54} /></section>{queueError && <p className="form-error" role="alert">{t(queueError)}</p>}<div className="metric-grid three"><Metric label={t("Pending role applications")} value={pendingRoles} detail={t("Open Role Applications to review each applicant")} icon={Users} /><Metric label={t("Pending refunds")} value={pendingRefunds} detail={t("Policy-evaluated requests")} icon={ClipboardCheck} /><Metric label={t("Catalogue reviews")} value="Open catalogue page" detail={t("Submitted courses and content")} icon={BookOpen} /></div><Card><div className="card-heading"><div><span className="eyebrow">{t("Role governance")}</span><h3>{t("Pending applicants")}</h3><p>{t("See who is waiting for Creator or Trainer access before opening the full review.")}</p></div><Button variant="secondary" onClick={() => navigate("/admin/applications")}>{t("Open review queue ")}<ArrowRight size={15} /></Button></div>{pendingRoleApplications.length ? <div className="queue-list">{pendingRoleApplications.slice(0, 4).map((application) => <div key={application.id}><span className="admin-user-avatar">{displayValue(application.user).slice(0, 1).toUpperCase()}</span><div><b>{displayValue(application.user)}</b><small>{t(application.type)}{t(" application")}</small><span className="queue-detail">{t("Submitted ")}{application.submittedAt ? new Date(application.submittedAt).toLocaleString(getFormatLocale()) : t("date unavailable")}</span></div><Badge tone="warning">{t("Pending")}</Badge></div>)}</div> : <p className="empty-copy">{t("No role applications are waiting for review.")}</p>}</Card></>;
}

const accountStatusTone = (status) => status === "active" ? "success" : status === "suspended" ? "warning" : "danger";
const applicationStatusTone = (status) => status === "Approved" ? "success" : status === "Rejected" ? "danger" : "warning";
const displayValue = (value) => String(value || "").trim() || "Not supplied";

export function AdminRoleApplicationsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedId = searchParams.get("application");
  const { refresh: refreshInbox } = useAdminInbox();
  const { roleApplications, decideRoleApplication, refreshAdminRoleApplications } = usePlatform();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState(() => linkedId ? "All" : "Pending");
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
  const selectedApplication = filteredApplications.find((item) => item.id === (linkedId || selectedId)) || null;
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
    setSearchParams({});
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
      void refreshInbox();
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
        <div><span className="eyebrow">{t("Role governance")}</span><h2>{t("Applicant review queue")}</h2><p>{t("Review the applicant identity and submitted evidence before granting Creator or Trainer access.")}</p></div>
        <div className="button-row"><Badge tone={statusFilter === "Pending" ? "warning" : "neutral"}>{filteredApplications.length} {statusFilter.toLowerCase()}</Badge><Button variant="secondary" onClick={refresh} disabled={loading || Boolean(busy)}>{loading ? t("Refreshing…") : t("Refresh")}</Button></div>
      </div>
      <div className="role-application-toolbar">
        <label><span>{t("Status")}</span><select aria-label={t("Filter role applications")} value={statusFilter} disabled={loading || Boolean(busy)} onChange={(event) => { setSearchParams({}); setStatusFilter(event.target.value); setSelectedId(""); setDecisionReason(""); }}><option value="Pending">{t("Pending")}</option><option value="Approved">{t("Approved")}</option><option value="Rejected">{t("Rejected")}</option><option value="All">{t("All")}</option></select></label>
        <small>{t("Decision comments are recorded and visible to the applicant.")}</small>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {linkedId && !loading && !selectedApplication && <p role="status">{t("This application is unavailable. Select another application or refresh the queue.")}</p>}
    </Card>

    <div className="admin-application-layout">
      <Card className="admin-application-list-card">
        <div className="card-heading"><div><span className="eyebrow">{t("Applications")}</span><h3>{statusFilter}{t(" requests")}</h3></div><Badge>{filteredApplications.length}</Badge></div>
        {loading ? <p className="empty-copy">{t("Loading applications…")}</p> : filteredApplications.length ? <div className="role-application-list">{filteredApplications.map((application) => <button type="button" disabled={Boolean(busy)} key={application.id} className={`role-application-row ${selectedApplication?.id === application.id ? "selected" : ""}`} aria-pressed={selectedApplication?.id === application.id} onClick={() => selectApplication(application.id)}><span className="admin-user-avatar">{displayValue(application.user).slice(0, 1).toUpperCase()}</span><span><b>{displayValue(application.user)}</b><small>{t(application.type)}{t(" application")}</small><em>{t("Submitted ")}{application.submittedAt ? new Date(application.submittedAt).toLocaleString(getFormatLocale()) : t("date unavailable")}</em></span><Badge tone={applicationStatusTone(application.status)}>{t(application.status)}</Badge></button>)}</div> : <EmptyState icon={Users} title={t("No {0} applications", { 0: statusFilter.toLowerCase() })} description={t("New Creator and Trainer applications will appear here after submission.")} />}
      </Card>

      {selectedApplication ? <div className="stack">
        <Card>
          <div className="card-heading"><div><span className="eyebrow">{t("Applicant identity")}</span><h3>{displayValue(selectedApplication.user)}</h3><p>{profileError ? t("Profile unavailable") : profileLoading || !profileMatchesSelection ? t("Loading the audited account profile…") : displayValue(displayedApplicant?.email)}</p></div>{displayedApplicant && <Badge tone={accountStatusTone(displayedApplicant.status)}>{t(titleCase(displayedApplicant.status))}</Badge>}</div>
          {profileError && <p className="form-error" role="alert">{t("Profile could not be loaded: ")}{t(profileError)}</p>}
          <dl className="detail-list applicant-profile-list">
            <div><dt>{t("Full name")}</dt><dd>{displayValue(displayedApplicant?.profile?.fullName || selectedApplication.user)}</dd></div>
            <div><dt>{t("Email")}</dt><dd>{profileValue(displayedApplicant?.email)}</dd></div>
            <div><dt>{t("Current roles")}</dt><dd>{profileError ? t("Unavailable") : displayedApplicant?.roles?.length ? displayedApplicant.roles.map(titleCase).join(", ") : profileMatchesSelection ? t("Member") : t("Loading…")}</dd></div>
            <div><dt>{t("Phone")}</dt><dd>{profileValue(displayedApplicant?.profile?.phone)}</dd></div>
            <div><dt>{t("Location")}</dt><dd>{profileValue(displayedApplicant?.profile?.location)}</dd></div>
            <div><dt>{t("Bio")}</dt><dd>{profileValue(displayedApplicant?.profile?.bio)}</dd></div>
          </dl>
          {selectedApplication.userId && <div className="button-row profile-review-actions"><Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={() => navigate(`/admin/users/${selectedApplication.userId}`)}>{t("Open full account ")}<ArrowRight size={15} /></Button></div>}
        </Card>

        <Card>
          <div className="card-heading"><div><span className="eyebrow">{t("Submitted application")}</span><h3>{t(selectedApplication.type)}{t(" access")}</h3><p>{t("Submitted ")}{selectedApplication.submittedAt ? new Date(selectedApplication.submittedAt).toLocaleString(getFormatLocale()) : t("date unavailable")}</p></div><Badge tone={applicationStatusTone(selectedApplication.status)}>{t(selectedApplication.status)}</Badge></div>
          <dl className="detail-list role-application-detail-list">
            <div><dt>{t("Subject category")}</dt><dd>{displayValue(selectedApplication.category)}</dd></div>
            <div><dt>{t("Relevant experience")}</dt><dd>{displayValue(selectedApplication.experience)}</dd></div>
            <div><dt>{t("Portfolio")}</dt><dd>{selectedApplication.portfolioUrl ? <a href={selectedApplication.portfolioUrl} target="_blank" rel="noreferrer">{selectedApplication.portfolio}<ExternalLink size={13} /></a> : displayValue(selectedApplication.portfolio)}</dd></div>
            <div><dt>{t("Why they are applying")}</dt><dd>{displayValue(selectedApplication.reason)}</dd></div>
          </dl>
          {inactiveApplicant && <div className="warning-box compact"><ShieldCheck size={16} /><div><b>{t("Approval unavailable")}</b><p>{t("This account is ")}{t(displayedApplicant.status)}{t(". It may be rejected, but a role cannot be granted until the account is active.")}</p></div></div>}
          {selectedApplication.status === "Pending" ? <div className="application-review"><FormField label={t("Decision reason")} hint={t("Required, at least 3 characters. The applicant can see this comment.")}><textarea disabled={profileUnavailable || Boolean(busy)} aria-label={t("Decision reason for {0} {1} application", { 0: selectedApplication.user, 1: selectedApplication.type })} value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} placeholder={t("Record the evidence reviewed and why access should be granted or declined")} /></FormField><div className="button-row"><Button disabled={profileUnavailable || Boolean(inactiveApplicant) || Boolean(busy) || decisionReason.trim().length < 3} onClick={() => decide("Approved")}><CheckCircle2 size={15} /> {busy === selectedApplication.id ? t("Saving…") : t("Approve application")}</Button><Button variant="danger" disabled={profileUnavailable || Boolean(busy) || decisionReason.trim().length < 3} onClick={() => decide("Rejected")}><XCircle size={15} />{t(" Reject application")}</Button></div></div> : <div className="application-review"><span className="eyebrow">{t("Decision comment")}</span><p className="application-copy">{displayValue(selectedApplication.decisionReason)}</p></div>}
        </Card>
      </div> : <EmptyState icon={Users} title={t("Select an application")} description={t("Choose an application from the queue to review the applicant and supporting information.")} />}
    </div>
  </div>;
}

export function AdminRefundPage() {
  const { t } = useTranslation();
  const { refundRequests, decideRefund, refreshAdminQueues } = usePlatform();
  const [params, setParams] = useSearchParams();
  const linkedId = params.get("request");
  const visibleRequests = linkedId ? refundRequests.filter((item) => item.id === linkedId) : refundRequests;
  const { refresh: refreshInbox } = useAdminInbox();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const decide = async (request, decision, reason) => {
    setBusy(request.id);
    try { setError(""); await decideRefund(request.id, titleCase(decision), reason); void refreshInbox(); } catch (error) { setError(error.message); } finally { setBusy(""); }
  };
  useEffect(() => { refreshAdminQueues().catch(error => setError(error.message)); }, [refreshAdminQueues]);
  if (!refundRequests.length && !error) return <EmptyState icon={ClipboardCheck} title={t("No refund requests")} description={t("Server-submitted refund requests will appear here for review.")} />;
  return <Card><div className="card-heading"><div><span className="eyebrow">{t("Refund review")}</span><h2>{t("Policy-evaluated requests")}</h2></div>{linkedId && <Button variant="secondary" onClick={() => setParams({})}>{t("All refund requests")}</Button>}</div>{linkedId && !visibleRequests.length && <p role="status">{t("This refund request is unavailable. Return to all requests.")}</p>}{error && <p role="alert" className="form-error">{t(error)}</p>}<div className="queue-list">{visibleRequests.map((request) => <div key={request.id}><ClipboardCheck size={18} /><div><b>{request.course}</b><small>{request.user} · {request.paid}{t(" points · ")}{request.basis}</small><span className="queue-detail">{request.reason}</span><VideoEvidence evidence={request.evidence} /></div>{request.status === "Pending" ? <DecisionButtons busy={busy === request.id} approvalDisabled={request.serverEligible !== true} onDecision={(decision, reason) => decide(request, decision, reason)} /> : <Status value={request.status} />}</div>)}</div></Card>;
}

export function AdminUsersPage() {
  const { t } = useTranslation();
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
  return <div className="stack"><Card><div className="card-heading"><div><span className="eyebrow">{t("User administration")}</span><h2>{t("View and control accounts")}</h2></div><Button variant="secondary" onClick={refreshUsers}>{t("Refresh users")}</Button></div><p className="muted">{t("Suspending or deleting an account immediately revokes its sessions. Delete is a permanent access removal; financial and moderation records are retained for audit.")}</p><div className="queue-actions"><input aria-label={t("Search users")} placeholder={t("Search name or email")} value={userSearch} onChange={(event) => setUserSearch(event.target.value)} /><select aria-label={t("Filter account status")} value={userStatus} onChange={(event) => setUserStatus(event.target.value)}><option value="">{t("All statuses")}</option><option value="active">{t("Active")}</option><option value="suspended">{t("Suspended")}</option><option value="deleted">{t("Deleted")}</option></select><Button className="sm" onClick={refreshUsers}>{t("Apply filter")}</Button></div>{userError && <p className="form-error">{t(userError)}</p>}{users.length ? <div className="queue-list">{users.map((user) => { const reason = userReasons[user.id] || ""; const actionBusy = busy === `user-${user.id}`; const isProtectedAdmin = user.roles.includes("admin"); return <div key={user.id}><Users size={18} /><div><b>{user.displayName}</b><small>{user.email} · {user.roles.length ? user.roles.join(", ") : t("no active role")}</small><span className="queue-detail">{t("Created ")}{user.createdAt ? new Date(user.createdAt).toLocaleString(getFormatLocale()) : "—"}</span></div><Status value={user.status} />{isProtectedAdmin ? <Badge tone="info">{t("Admin protected")}</Badge> : user.status === "deleted" ? <Badge tone="neutral">{t("Access removed")}</Badge> : <div className="queue-actions"><input aria-label={t("Reason for {0}", { 0: user.email })} placeholder={t("Action reason")} value={reason} onChange={(event) => setReason(user.id, event.target.value)} />{user.status === "active" ? <><Button className="sm" disabled={actionBusy} onClick={() => actOnUser(user, "suspend")}>{t("Freeze")}</Button><Button className="sm danger" disabled={actionBusy} onClick={() => actOnUser(user, "delete")}>{t("Delete")}</Button></> : <><Button className="sm" disabled={actionBusy} onClick={() => actOnUser(user, "reinstate")}>{t("Reinstate")}</Button><Button className="sm danger" disabled={actionBusy} onClick={() => actOnUser(user, "delete")}>{t("Delete")}</Button></>}</div>}</div>; })}</div> : <p className="empty-copy">{t("No accounts match the selected filter.")}</p>}</Card><Card><div className="card-heading"><div><span className="eyebrow">{t("Role applications")}</span><h2>{t("Access approvals")}</h2></div><Button variant="secondary" onClick={refresh}>{t("Refresh")}</Button></div>{roleApplications.length ? <div className="queue-list">{roleApplications.map((item) => <div key={item.id}><Users size={18} /><div><b>{item.user}</b><small>{item.type}{t(" · submitted ")}{item.submittedAt ? new Date(item.submittedAt).toLocaleString(getFormatLocale()) : "—"}</small><span className="queue-detail">{item.reason}</span></div>{item.status === "Pending" ? <DecisionButtons busy={busy === item.id} onDecision={(decision, reason) => decideRole(item.id, decision, reason)} /> : <Status value={item.status} />}</div>)}</div> : <p className="empty-copy">{t("No role applications.")}</p>}</Card><Card><div className="card-heading"><div><span className="eyebrow">{t("Trainer certification")}</span><h2>{t("Certification review")}</h2></div></div>{certifications.length ? <div className="queue-list">{certifications.map((item) => <div key={item.id}><ShieldCheck size={18} /><div><b>{item.trainer?.displayName || t("Trainer")}</b><small>{item.certificationName} · {item.certificationReference || t("No reference")}</small></div>{item.status === "pending" ? <DecisionButtons busy={busy === item.id} onDecision={(decision, reason) => decideCertification(item.id, decision, reason)} /> : <Status value={item.status} />}</div>)}</div> : <p className="empty-copy">{t("No trainer certifications.")}</p>}</Card></div>;
}

export function AdminCatalogPage() {
  const { t } = useTranslation();
  const { refreshCatalog } = usePlatform();
  const [courses, setCourses] = useState([]);
  const [contents, setContents] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const loadQueues = async () => {
    const [nextCourses, nextContents] = await Promise.all([getCourseSubmissions(), getContentSubmissions()]);
    setCourses(nextCourses);
    setContents(nextContents);
  };

  const refresh = async () => {
    setError("");
    try { await loadQueues(); } catch (loadError) { setError(loadError.message); }
  };

  useEffect(() => { void refresh(); }, []);

  const decide = async (kind, id, decision, reason) => {
    setBusy(`${kind}-${id}`);
    setError("");
    try {
      if (kind === "course") await decideCourseSubmission(id, { decision, reason });
      else await decideContentSubmission(id, { decision, reason });
      const [queueRefresh, marketplaceRefresh] = await Promise.allSettled([
        loadQueues(),
        refreshCatalog(),
      ]);
      const refreshFailures = [
        queueRefresh.status === "rejected" ? "the review queue" : "",
        marketplaceRefresh.status === "rejected" ? "the marketplace" : "",
      ].filter(Boolean);
      if (refreshFailures.length) {
        setError(`Decision saved, but ${refreshFailures.join(" and ")} could not refresh automatically.`);
      }
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
    return <EmptyState icon={BookOpen} title={t("No catalogue submissions")} description={t("Submitted trainer courses and creator content will appear here.")} action={<Button onClick={refresh}>{t("Refresh")}</Button>} />;
  }

  return <Card>
    <div className="card-heading">
      <div><span className="eyebrow">{t("Catalogue control")}</span><h2>{t("Publication review")}</h2><p>{t("Content must be privately previewed before it can be published.")}</p></div>
      <Button variant="secondary" onClick={refresh} disabled={Boolean(busy)}>{t("Refresh")}</Button>
    </div>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
    <div className="queue-list catalogue-review-list">
      {queue.map((item) => <div className={`catalogue-review-item ${item.kind}`} key={`${item.kind}-${item.id}`}>
        <span>{item.kind === "course" ? <BookOpen size={18} /> : <FileText size={18} />}</span>
        <div>
          <b>{item.title}</b>
          <small>{item.owner?.displayName || t("Owner")} · {item.pricePoints}{t(" points · ")}{item.kind === "course" ? item.deliveryModes?.join(", ") : item.contentType}</small>
          {item.kind === "content" && <span className="queue-detail">{t("Private attachments: ")}{Math.max(Number(item.assetCount || 0), item.assets?.length || 0, item.storageUrlPresent ? 1 : 0)}</span>}
        </div>
        {item.kind === "content"
          ? <ContentReviewActions item={item} busy={busy === `${item.kind}-${item.id}`} onDecision={(decision, reason) => decide(item.kind, item.id, decision, reason)} />
          : item.onlineVideo || item.progressTrackingType === "online_video" || item.reviewVideoVersionId
            ? <AdminVideoReview item={item} busy={busy === `${item.kind}-${item.id}`} onDecision={(decision, reason) => decide(item.kind, item.id, decision, reason)} />
            : <DecisionButtons approveValue="published" busy={busy === `${item.kind}-${item.id}`} onDecision={(decision, reason) => decide(item.kind, item.id, decision, reason)} />}
      </div>)}
    </div>
  </Card>;
}
