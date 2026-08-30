import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BadgeDollarSign,
  BookOpen,
  Check,
  CheckCircle2,
  CircleDollarSign,
  CreditCard,
  FileText,
  LoaderCircle,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingBag,
  UserCheck,
  WalletCards,
  X,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { createTopUpCheckoutSession, getTopUpStatus } from "../api/payments";
import { usePlatform } from "../context/PlatformContext";
import {
  Badge,
  Button,
  Card,
  FormField,
  Metric,
  Modal,
  Segmented,
} from "../components/ui";

export function WalletPage() {
  const { balance, walletBalances, transactions, topUpPackages, refreshWallet, notify } = usePlatform();
  const navigate = useNavigate();
  const location = useLocation();
  const [topup, setTopup] = useState(false);
  const [paymentNotice, setPaymentNotice] = useState("");

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const paymentTransactionId = query.get("paymentTransactionId");
    if (!paymentTransactionId) return undefined;

    let cancelled = false;
    let retryTimer;
    let attempts = 0;
    const reconcile = async () => {
      try {
        const payment = await getTopUpStatus(paymentTransactionId);
        if (cancelled) return;
        if (payment.status === "paid") {
          await refreshWallet();
          if (cancelled) return;
          notify(`${payment.points} points have been added to your wallet.`);
          setPaymentNotice("Payment confirmed. Your wallet has been refreshed.");
          navigate("/wallet", { replace: true });
          return;
        }
        attempts += 1;
        if (attempts < 10) {
          setPaymentNotice("Payment received. Verifying the secure payment event…");
          retryTimer = window.setTimeout(reconcile, 1200);
        } else {
          setPaymentNotice("Payment is still being verified. Refresh this page in a moment.");
        }
      } catch {
        if (!cancelled) setPaymentNotice("Unable to check this payment yet. Refresh the wallet shortly.");
      }
    };
    reconcile();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, [location.search, navigate, notify, refreshWallet]);

  return (
    <>
      <section className="wallet-hero">
        <div>
          <span className="eyebrow light">Unified points balance</span>
          <strong>{balance}</strong>
          <p>
            Use one balance for course purchases, creator content, trainer
            income, creator income and approved refunds.
          </p>
          <div className="button-row">
            <Button onClick={() => setTopup(true)}>Add points</Button>
            <Button variant="glass" onClick={() => navigate("/transactions")}>
              View transaction history
            </Button>
          </div>
        </div>
        <WalletCards size={72} />
      </section>
      <div className="metric-grid four">
        <Metric
          label="Available"
          value={`${walletBalances.available} pts`}
          detail="Spendable now"
          icon={WalletCards}
        />
        <Metric
          label="Frozen"
          value={`${walletBalances.frozen} pts`}
          detail="Reserved until a Live course starts"
          icon={ShieldCheck}
        />
        <Metric
          label="Expired"
          value={`${walletBalances.expired} pts`}
          detail="No longer spendable"
          icon={RotateCcw}
        />
        <Metric
          label="Admin hold"
          value={`${walletBalances.blocked} pts`}
          detail="Blocked pending review"
          icon={X}
        />
      </div>
      <Card>
        <div className="card-heading">
          <div>
            <span className="eyebrow">Recent activity</span>
            <h3>Latest transactions</h3>
          </div>
          <Button variant="secondary" onClick={() => navigate("/transactions")}>
            View all <ArrowRight size={16} />
          </Button>
        </div>
        <TransactionTable transactions={transactions.slice(0, 4)} />
      </Card>
      {paymentNotice && <div className="success-note" role="status">{paymentNotice}</div>}
      {topup && (
        <TopUpModal
          onClose={() => setTopup(false)}
          packages={topUpPackages}
        />
      )}
    </>
  );
}

function TopUpModal({ onClose, packages }) {
  const [step, setStep] = useState(1);
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selectedPackageId && packages.length) setSelectedPackageId(packages[0].id);
  }, [packages, selectedPackageId]);

  const selectedPlan = packages.find((plan) => plan.id === selectedPackageId);
  const startCheckout = async () => {
    if (!selectedPlan) {
      setError("No top-up package is available. Please try again shortly.");
      return;
    }
    setLoading(true);
    setError("");
    const idempotencyKey = crypto.randomUUID();
    try {
      const session = await createTopUpCheckoutSession({
        topUpPackageId: selectedPlan.id,
        idempotencyKey,
      });
      const checkoutUrl = new URL(session.checkoutUrl);
      if (checkoutUrl.protocol !== "https:")
        throw new Error("The payment provider returned an unsafe checkout URL.");
      window.location.assign(checkoutUrl.toString());
    } catch (checkoutError) {
      setError(checkoutError.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal
      title="Add points to your wallet"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => (step === 1 ? onClose() : setStep(step - 1))}
          >
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          <Button
            disabled={loading || (step === 1 && !selectedPlan)}
            onClick={() => (step === 2 ? startCheckout() : setStep(step + 1))}
          >
            {loading ? (
              <>
                <LoaderCircle className="spin" size={16} /> Connecting…
              </>
            ) : (
              <>
                {step === 2 ? "Continue to secure checkout" : "Continue"}
                <ArrowRight size={16} />
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="stepper">
        <span className={step >= 1 ? "active" : ""}>
          1<b>Package</b>
        </span>
        <span className={step >= 2 ? "active" : ""}>
          2<b>Payment</b>
        </span>
      </div>
      {step === 1 && (
        <div className="plan-grid">
          {packages.map((plan) => (
            <button
              className={selectedPackageId === plan.id ? "active" : ""}
              key={plan.id}
              onClick={() => setSelectedPackageId(plan.id)}
            >
              <span>{plan.points}</span>
              <small>{plan.displayName}</small>
              <b>S${(plan.amountMinor / 100).toFixed(2)}</b>
            </button>
          ))}
          {!packages.length && <p className="empty-copy">Loading secure top-up packages…</p>}
        </div>
      )}
      {step === 2 && selectedPlan && (
        <div className="payment-preview">
          <ShieldCheck size={30} />
          <h3>Secure external checkout</h3>
          <p>
            CoLearnX creates a top-up order, then the external payment provider
            collects payment details. Raw card data never enters CoLearnX.
          </p>
          <div className="integration-note">
            <b>Stripe sandbox checkout</b>
            <span>
              Points are credited only after the Express webhook verifies the
              provider event and idempotency key.
            </span>
          </div>
          <div className="summary-row total">
            <span>Amount</span>
            <b>S${(selectedPlan.amountMinor / 100).toFixed(2)}</b>
          </div>
          {error && (
            <div className="form-error" role="alert">
              <AlertCircle size={17} /> {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function TransactionTable({ transactions }) {
  return (
    <div className="responsive-table">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Transaction</th>
            <th>Category</th>
            <th>Amount</th>
            <th>Balance</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.id}>
              <td>
                {tx.createdAt
                  ? new Date(tx.createdAt).toLocaleString("en-SG", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : tx.date}
              </td>
              <td>
                <b>{tx.type}</b>
                <small className="table-subtitle">{tx.item}</small>
              </td>
              <td>
                <Badge
                  tone={
                    tx.category === "Income"
                      ? "success"
                      : tx.category === "Refund"
                        ? "warning"
                        : tx.category === "Top-up"
                          ? "brand"
                          : tx.category === "Frozen"
                            ? "warning"
                          : "neutral"
                  }
                >
                  {tx.category}
                </Badge>
              </td>
              <td
                className={
                  tx.amount > 0
                    ? "text-success"
                    : tx.amount < 0
                      ? "text-danger"
                      : ""
                }
              >
                <b>
                  {tx.amount > 0 ? "+" : ""}
                  {tx.amount}
                </b>
              </td>
              <td>{tx.balance}</td>
              <td>
                <span className="status-text">
                  <CheckCircle2 size={14} /> {tx.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TransactionHistoryPage() {
  const { transactions } = usePlatform();
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      transactions
        .filter(
          (tx) =>
            (category === "All" || tx.category === category) &&
            `${tx.type} ${tx.item} ${tx.id}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort(
          (a, b) =>
            new Date(b.createdAt || b.date).getTime() -
            new Date(a.createdAt || a.date).getTime(),
        ),
    [transactions, category, query],
  );
  return (
    <Card>
      <div className="history-toolbar">
        <Segmented
          options={[
            "All",
            "Spending",
            "Frozen",
            "Income",
            "Refund",
            "Top-up",
          ]}
          value={category}
          onChange={setCategory}
        />
        <div className="search-field compact">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search transactions"
          />
        </div>
      </div>
      <TransactionTable transactions={filtered} />
    </Card>
  );
}

export function AdminDashboardPage() {
  const {
    roleApplications,
    refundRequests,
    courses,
    contents,
    decideRoleApplication,
    decideTrainerCertification,
  } = usePlatform();
  const navigate = useNavigate();
  const pendingRoles = roleApplications.filter(
    (item) => item.status === "Pending",
  );
  const pendingRefunds = refundRequests.filter(
    (item) => item.status === "Pending",
  );
  const pendingCertifications = roleApplications.filter(
    (item) =>
      item.type === "Trainer" &&
      item.status === "Approved" &&
      item.certificationStatus === "Pending",
  );
  const [selectedRoleId, setSelectedRoleId] = useState(
    pendingRoles[0]?.id || null,
  );
  const [roleDecisionReason, setRoleDecisionReason] = useState("");
  const [selectedCertificationId, setSelectedCertificationId] = useState(
    pendingCertifications[0]?.id || null,
  );
  const [certificationReason, setCertificationReason] = useState("");
  const selectedRole =
    pendingRoles.find((item) => item.id === selectedRoleId) || pendingRoles[0];
  const decideRole = (status) => {
    if (!selectedRole || roleDecisionReason.trim().length < 5) return;
    if (
      decideRoleApplication(
        selectedRole.id,
        status,
        roleDecisionReason.trim(),
      )
    ) {
      setRoleDecisionReason("");
      setSelectedRoleId(null);
    }
  };
  const selectedCertification =
    pendingCertifications.find(
      (item) => item.id === selectedCertificationId,
    ) || pendingCertifications[0];
  const decideCertification = (status) => {
    if (!selectedCertification || certificationReason.trim().length < 5) return;
    if (
      decideTrainerCertification(
        selectedCertification.id,
        status,
        certificationReason.trim(),
      )
    ) {
      setCertificationReason("");
      setSelectedCertificationId(null);
    }
  };
  return (
    <>
      <div className="metric-grid four">
        <Metric
          label="Pending role applications"
          value={pendingRoles.length}
          icon={UserCheck}
        />
        <Metric
          label="Refund requests"
          value={pendingRefunds.length}
          icon={RotateCcw}
        />
        <Metric label="Active courses" value={courses.filter((item) => item.isPublished !== false).length} icon={BookOpen} />
        <Metric
          label="Trainer certifications"
          value={pendingCertifications.length}
          icon={ShieldCheck}
        />
      </div>
      <div className="content-grid two">
        <Card>
          <div className="card-heading">
            <div>
              <span className="eyebrow">Priority queue</span>
              <h3>Role application review</h3>
            </div>
            <Badge tone="warning">{pendingRoles.length} pending</Badge>
          </div>
          {pendingRoles.length ? (
            <div className="queue-list">
              {pendingRoles.map((application) => (
                <div key={application.id}>
                  <span className="avatar tiny">
                    {application.user
                      .split(" ")
                      .map((part) => part[0])
                      .join("")
                      .slice(0, 2)}
                  </span>
                  <div>
                    <b>{application.user}</b>
                    <small>
                      {application.type} · {application.category}
                    </small>
                    <span className="queue-detail">
                      {application.portfolio}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant={selectedRole?.id === application.id ? "primary" : "secondary"}
                    onClick={() => {
                      setSelectedRoleId(application.id);
                      setRoleDecisionReason("");
                    }}
                  >
                    Review
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-copy">No pending role applications.</p>
          )}
          {selectedRole && (
            <div className="application-review">
              <h4>{selectedRole.user} · {selectedRole.type}</h4>
              <dl className="detail-list">
                <div><dt>Category</dt><dd>{selectedRole.category}</dd></div>
                <div><dt>Experience</dt><dd>{selectedRole.experience}</dd></div>
                <div><dt>Portfolio</dt><dd>{selectedRole.portfolio}</dd></div>
                 <div><dt>Reason</dt><dd>{selectedRole.reason}</dd></div>
                 <div><dt>Declaration</dt><dd>{selectedRole.declarationAccepted ? "Accepted" : "Missing"}</dd></div>
              </dl>
              <FormField label="Decision reason">
                <textarea
                  value={roleDecisionReason}
                  onChange={(event) => setRoleDecisionReason(event.target.value)}
                  placeholder="Record why this application is approved or rejected"
                />
              </FormField>
              <div className="button-row">
                <Button disabled={roleDecisionReason.trim().length < 5} onClick={() => decideRole("Approved")}>
                  Approve
                </Button>
                <Button variant="danger" disabled={roleDecisionReason.trim().length < 5} onClick={() => decideRole("Rejected")}>
                  Reject
                </Button>
              </div>
            </div>
          )}
        </Card>
        <Card>
          <div className="card-heading">
            <div>
              <span className="eyebrow">Policy workflow</span>
              <h3>Refund management</h3>
            </div>
            <Badge tone="danger">{pendingRefunds.length} requests</Badge>
          </div>
          <p>
            Review the course format, cancellation deadline, viewing percentage
            and video download evidence before making a decision.
          </p>
          <Button onClick={() => navigate("/admin/refunds")}>
            Open refund review <ArrowRight size={16} />
          </Button>
        </Card>
      </div>
      <Card>
        <div className="card-heading">
          <div>
            <span className="eyebrow">Separate P0 gate</span>
            <h3>Trainer certification review</h3>
          </div>
          <Badge tone="warning">{pendingCertifications.length} pending</Badge>
        </div>
        <p>
          Approving a Trainer application does not grant the operational role.
          Certification evidence and a second recorded decision are required.
        </p>
        {pendingCertifications.length ? (
          <div className="application-review">
            <FormField label="Trainer certification record">
              <select
                value={selectedCertification?.id || ""}
                onChange={(event) => {
                  setSelectedCertificationId(event.target.value);
                  setCertificationReason("");
                }}
              >
                {pendingCertifications.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.user} · {item.category} · {item.portfolio}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Certification decision reason">
              <textarea
                value={certificationReason}
                onChange={(event) => setCertificationReason(event.target.value)}
                placeholder="Record the reviewed evidence and decision"
              />
            </FormField>
            <div className="button-row">
              <Button
                disabled={certificationReason.trim().length < 5}
                onClick={() => decideCertification("Approved")}
              >
                Approve certification
              </Button>
              <Button
                variant="danger"
                disabled={certificationReason.trim().length < 5}
                onClick={() => decideCertification("Rejected")}
              >
                Reject certification
              </Button>
            </div>
          </div>
        ) : (
          <p className="empty-copy">No Trainer certifications await review.</p>
        )}
      </Card>
      <Card>
        <span className="eyebrow">Platform control</span>
        <h3>Management overview</h3>
        <div className="admin-actions">
          <button onClick={() => navigate("/admin/users")}>
            <UserCheck size={19} />
            <span>
              <b>Users and roles</b>
              <small>Profiles, permissions and applications</small>
            </span>
          </button>
          <button onClick={() => navigate("/admin/catalog")}>
            <BookOpen size={19} />
            <span>
              <b>Courses and contents</b>
              <small>Listings, publication and reports</small>
            </span>
          </button>
          <button onClick={() => navigate("/transactions")}>
            <CircleDollarSign size={19} />
            <span>
              <b>Transactions</b>
              <small>Points, income and refund records</small>
            </span>
          </button>
        </div>
      </Card>
    </>
  );
}

export function AdminRefundPage() {
  const { refundRequests, decideRefund } = usePlatform();
  const [selectedId, setSelectedId] = useState(refundRequests[0]?.id || null);
  const [decisionReason, setDecisionReason] = useState("");
  const selected =
    refundRequests.find((item) => item.id === selectedId) || refundRequests[0];
  if (!selected)
    return (
      <Card>
        <h3>No refund requests</h3>
        <p>New member requests will appear here.</p>
      </Card>
    );
  const canApprove = selected.eligibility === "Eligible";
  const decide = (status) => {
    if (decisionReason.trim().length < 5) return;
    if (decideRefund(selected.id, status, decisionReason.trim()))
      setDecisionReason("");
  };
  return (
    <div className="content-grid admin-refund-layout">
      <Card className="table-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Course refund requests</span>
            <h3>Review queue</h3>
          </div>
          <Badge tone="warning">
            {refundRequests.filter((r) => r.status === "Pending").length}{" "}
            pending
          </Badge>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Course</th>
                <th>Policy basis</th>
                <th>Eligibility</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {refundRequests.map((request) => {
                const currentEligibility = request.eligibility;
                return (
                <tr
                  key={request.id}
                  tabIndex="0"
                  role="button"
                  aria-selected={selected.id === request.id}
                  className={selected.id === request.id ? "selected" : ""}
                  onClick={() => {
                    setSelectedId(request.id);
                    setDecisionReason("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(request.id);
                      setDecisionReason("");
                    }
                  }}
                >
                  <td>
                    <b>{request.user}</b>
                    <small className="table-subtitle">
                      {request.submittedAt}
                    </small>
                  </td>
                  <td>{request.course}</td>
                  <td>{request.basis}</td>
                  <td>
                    <Badge
                      tone={
                        currentEligibility === "Eligible"
                          ? "success"
                          : "danger"
                      }
                    >
                      {currentEligibility}
                    </Badge>
                  </td>
                  <td>{request.status}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="review-panel">
        <span className="eyebrow">Selected request</span>
        <h3>
          {selected.user} · {selected.course}
        </h3>
        <dl className="detail-list">
          <div>
            <dt>Member reason</dt>
            <dd>{selected.reason}</dd>
          </div>
          <div>
            <dt>Policy evidence</dt>
            <dd>{selected.basis}</dd>
          </div>
          <div>
            <dt>Points paid</dt>
            <dd>{selected.paid}</dd>
          </div>
          <div>
            <dt>Eligibility</dt>
            <dd>
              {selected.status === "Pending"
                ? canApprove
                  ? "Eligible"
                  : "Not eligible"
                : selected.eligibility}
            </dd>
          </div>
          <div>
            <dt>Current policy check</dt>
            <dd>
              {selected.eligibilityAtDecision || selected.basis}
            </dd>
          </div>
          <div>
            <dt>Current status</dt>
            <dd>{selected.status}</dd>
          </div>
        </dl>
        <FormField label="Decision reason">
          <textarea
            disabled={selected.status !== "Pending"}
            value={decisionReason}
            onChange={(event) => setDecisionReason(event.target.value)}
            placeholder="Explain the approval or rejection"
          />
        </FormField>
        <div className="button-row">
          <Button
            disabled={
              selected.status !== "Pending" ||
              !canApprove ||
              decisionReason.trim().length < 5
            }
            onClick={() => decide("Approved")}
          >
            <Check size={16} /> Approve
          </Button>
          <Button
            variant="danger"
            disabled={
              selected.status !== "Pending" || decisionReason.trim().length < 5
            }
            onClick={() => decide("Rejected")}
          >
            <X size={16} /> Reject
          </Button>
        </div>
        <p className="policy-note">
          <ShieldCheck size={17} /> Approval returns points to the learner.
          Rejection keeps the original transaction.
        </p>
      </Card>
    </div>
  );
}

export function AdminUsersPage() {
  const { profile, approvedRoles, applications, roleApplications } =
    usePlatform();
  return (
    <div className="stack">
      <Card>
        <span className="eyebrow">Account overview</span>
        <h3>{profile.name}</h3>
        <div className="badge-row">
          {approvedRoles.map((role) => (
            <Badge key={role} tone="success">{role}</Badge>
          ))}
        </div>
        <dl className="detail-list">
          <div><dt>Email</dt><dd>{profile.email}</dd></div>
          <div><dt>Trainer application</dt><dd>{applications.Trainer}</dd></div>
          <div><dt>Creator application</dt><dd>{applications.Creator}</dd></div>
        </dl>
      </Card>
      <Card className="table-card">
        <div className="card-heading">
          <div><span className="eyebrow">Role records</span><h3>Application history</h3></div>
          <Badge>{roleApplications.length} records</Badge>
        </div>
        <div className="responsive-table">
          <table>
            <thead><tr><th>User</th><th>Role</th><th>Category</th><th>Status</th><th>Certification</th><th>Decision</th></tr></thead>
            <tbody>
              {roleApplications.map((item) => (
                <tr key={item.id}>
                  <td><b>{item.user}</b></td>
                  <td>{item.type}</td>
                  <td>{item.category}</td>
                  <td><Badge tone={item.status === "Approved" ? "success" : item.status === "Rejected" ? "danger" : "warning"}>{item.status}</Badge></td>
                  <td>{item.type === "Trainer" ? item.certificationStatus || "Not started" : "Not required"}</td>
                  <td>{item.decisionReason || "Pending review"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export function AdminCatalogPage() {
  const { courses, contents } = usePlatform();
  const [tab, setTab] = useState("Courses");
  const items = tab === "Courses" ? courses : contents;
  return (
    <Card className="table-card">
      <div className="card-heading">
        <div><span className="eyebrow">Marketplace control</span><h3>Courses and contents</h3></div>
        <Segmented options={["Courses", "Contents"]} value={tab} onChange={setTab} />
      </div>
      <div className="responsive-table">
        <table>
          <thead><tr><th>Title</th><th>Owner</th><th>Category</th><th>Price</th><th>Publication</th><th>Purchases</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td><b>{item.title}</b></td>
                <td>{item.trainer || item.creator}</td>
                <td>{item.category}</td>
                <td>{item.price} points</td>
                <td><Badge tone={item.isPublished === false ? "warning" : "success"}>{item.isPublished === false ? "Hidden / Draft" : "Published"}</Badge></td>
                <td>{item.purchased ? "Purchased" : "Available"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
