import { getFormatLocale, useTranslation } from "../i18n/LanguageContext";
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
import { getTopUpPackages } from "../api/wallet";
import { usePlatform } from "../context/PlatformContext";
import { paymentsApiEnabled } from "../config/features";
import { createTopUpPackageLoader, initialTopUpPackageState } from "../utils/topUpPackages";
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
  const { t } = useTranslation();
  const { balance, walletBalances, transactions, refreshWallet, notify } = usePlatform();
  const navigate = useNavigate();
  const location = useLocation();
  const [topup, setTopup] = useState(false);
  const [paymentNotice, setPaymentNotice] = useState("");
  const [paymentRefreshFailed, setPaymentRefreshFailed] = useState(false);
  const [refreshingPayment, setRefreshingPayment] = useState(false);
  const [confirmedPayment, setConfirmedPayment] = useState(null);

  useEffect(() => {
    if (!paymentsApiEnabled) return undefined;

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
          setConfirmedPayment(payment);
          try {
            await refreshWallet();
            if (cancelled) return;
            notify({ key: "{points} points have been added to your wallet.", values: { points: payment.points } });
            setPaymentNotice("Payment confirmed. Your wallet has been refreshed.");
            setPaymentRefreshFailed(false);
          } catch {
            if (cancelled) return;
            setPaymentNotice("Payment confirmed, but your wallet could not refresh. Please retry the wallet refresh; do not pay again.");
            setPaymentRefreshFailed(true);
          }
          // A confirmed payment must not be reconciled repeatedly when the
          // secondary balance request fails. Retrying only refreshes the wallet.
          navigate("/wallet", { replace: true });
          return;
        }
        if (["cancelled", "canceled", "failed", "expired"].includes(payment.status)) {
          setPaymentNotice(payment.status === "failed" ? "Payment failed. No points were added." : "Payment was cancelled. No points were added.");
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

  const retryPaymentRefresh = async () => {
    setRefreshingPayment(true);
    try {
      await refreshWallet();
      setPaymentRefreshFailed(false);
      setPaymentNotice("Payment confirmed. Your wallet has been refreshed.");
      if (confirmedPayment) notify({ key: "{points} points have been added to your wallet.", values: { points: confirmedPayment.points } });
    } catch {
      setPaymentNotice("Payment confirmed, but your wallet could not refresh. Please retry the wallet refresh; do not pay again.");
    } finally { setRefreshingPayment(false); }
  };

  return (
    <>
      <section className="wallet-hero">
        <div>
          <span className="eyebrow light">{t("Unified points balance")}</span>
          <strong>{balance}</strong>
          <p>{t("Use one balance for course purchases, creator content, trainer income, creator income and approved refunds.")}</p>
          <div className="button-row">
            <Button
              disabled={!paymentsApiEnabled}
              onClick={() => setTopup(true)}
            >
              {paymentsApiEnabled ? t("Add points") : t("Top-up unavailable")}
            </Button>
            <Button variant="glass" onClick={() => navigate("/transactions")}>{t("View transaction history")}</Button>
          </div>
        </div>
        <WalletCards size={72} />
      </section>
      <div className="metric-grid four">
        <Metric
          label={t("Available")}
          value={t("{0} points", { 0: walletBalances.available })}
          detail={t("Spendable now")}
          icon={WalletCards}
        />
        <Metric
          label={t("Frozen")}
          value={t("{0} points", { 0: walletBalances.frozen })}
          detail={t("Reserved until a Live course starts")}
          icon={ShieldCheck}
        />
        <Metric
          label={t("Expired")}
          value={t("{0} points", { 0: walletBalances.expired })}
          detail={t("No longer spendable")}
          icon={RotateCcw}
        />
        <Metric
          label={t("Admin hold")}
          value={t("{0} points", { 0: walletBalances.blocked })}
          detail={t("Blocked pending review")}
          icon={X}
        />
      </div>
      <Card>
        <div className="card-heading">
          <div>
            <span className="eyebrow">{t("Recent activity")}</span>
            <h3>{t("Latest transactions")}</h3>
          </div>
          <Button variant="secondary" onClick={() => navigate("/transactions")}>{t("View all ")}<ArrowRight size={16} />
          </Button>
        </div>
        <TransactionTable transactions={transactions.slice(0, 4)} />
      </Card>
      {!paymentsApiEnabled && (
        <div className="feature-status" role="status">
          <AlertCircle size={18} />
          <div>
            <b>{t("Sandbox top-ups are not enabled for this deployment.")}</b>
            <span>{t("Wallet balances and transaction history remain available. An administrator must enable the Stripe sandbox integration before test payments can be created.")}</span>
          </div>
        </div>
      )}
      {paymentNotice && <div className="payment-reconciliation-notice success-note" role="status"><p>{t(paymentNotice)}</p>{paymentRefreshFailed && <Button variant="secondary" size="sm" disabled={refreshingPayment} onClick={() => void retryPaymentRefresh()}>{refreshingPayment ? t("Refreshing…") : t("Retry wallet refresh")}</Button>}</div>}
      {paymentsApiEnabled && topup && (
        <TopUpModal
          onClose={() => setTopup(false)}
        />
      )}
    </>
  );
}

function TopUpModal({ onClose }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [packageState, setPackageState] = useState(initialTopUpPackageState);
  const packageLoader = useMemo(
    () => createTopUpPackageLoader(getTopUpPackages, setPackageState),
    [],
  );
  const { packages, status: packageStatus } = packageState;

  useEffect(() => {
    void packageLoader.load();
    return packageLoader.cancel;
  }, [packageLoader]);

  useEffect(() => {
    if (!packages.some((plan) => plan.id === selectedPackageId)) {
      setSelectedPackageId(packages[0]?.id || "");
    }
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
      title={t("Add points to your wallet")}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => (step === 1 ? onClose() : setStep(step - 1))}
          >
            {step === 1 ? t("Cancel") : t("Back")}
          </Button>
          <Button
            disabled={loading || packageStatus !== "ready" || !selectedPlan}
            onClick={() => (step === 2 ? startCheckout() : setStep(step + 1))}
          >
            {loading ? (
              <>
                <LoaderCircle className="spin" size={16} />{t(" Connecting…")}</>
            ) : (
              <>
                {step === 2 ? t("Continue to secure checkout") : t("Continue")}
                <ArrowRight size={16} />
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="stepper">
        <span className={step >= 1 ? "active" : ""}>
          1<b>{t("Package")}</b>
        </span>
        <span className={step >= 2 ? "active" : ""}>
          2<b>{t("Payment")}</b>
        </span>
      </div>
      {step === 1 && (
        <div className="plan-grid" aria-busy={packageStatus === "loading"}>
          {packages.map((plan) => (
            <button
              className={selectedPackageId === plan.id ? "active" : ""}
              key={plan.id}
              onClick={() => setSelectedPackageId(plan.id)}
            >
              <span>{plan.points}</span>
              <small>{plan.displayName}</small>
              <b>{t("S$")}{(plan.amountMinor / 100).toFixed(2)}</b>
            </button>
          ))}
          {packageStatus === "loading" && (
            <div className="topup-package-status" role="status">
              <LoaderCircle className="spin" size={24} aria-hidden="true" />
              <p>{t("Loading secure top-up packages…")}</p>
            </div>
          )}
          {packageStatus === "error" && (
            <div className="topup-package-status">
              <div className="form-error" role="alert">
                <AlertCircle size={18} aria-hidden="true" />
                <span>{t(packageState.error)}</span>
              </div>
              <Button variant="secondary" onClick={() => void packageLoader.load()}>
                <RotateCcw size={16} aria-hidden="true" />{t(" Retry loading packages")}</Button>
            </div>
          )}
          {packageStatus === "empty" && (
            <div className="topup-package-status">
              <p role="status">{t("No top-up packages are available right now. Please try again later.")}</p>
              <Button variant="secondary" onClick={() => void packageLoader.load()}>
                <RotateCcw size={16} aria-hidden="true" />{t(" Retry loading packages")}</Button>
            </div>
          )}
        </div>
      )}
      {step === 2 && selectedPlan && (
        <div className="payment-preview">
          <ShieldCheck size={30} />
          <h3>{t("Secure external checkout")}</h3>
          <p>{t("CoLearnX creates a top-up order, then the external payment provider collects payment details. Raw card data never enters CoLearnX.")}</p>
          <div className="integration-note">
            <b>{t("Stripe sandbox checkout")}</b>
            <span>{t("Points are credited only after the Express webhook verifies the provider event and idempotency key.")}</span>
          </div>
          <div className="summary-row total">
            <span>{t("Amount")}</span>
            <b>{t("S$")}{(selectedPlan.amountMinor / 100).toFixed(2)}</b>
          </div>
          {error && (
            <div className="form-error" role="alert">
              <AlertCircle size={17} /> {t(error)}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function TransactionTable({ transactions }) {
  const { t } = useTranslation();
  const bucketLines = (values = {}) => Object.entries(values).filter(([, value]) => Number(value) !== 0).map(([bucket, value]) => `${t(bucket)}: ${Number(value) > 0 ? "+" : ""}${value}`);
  const balanceLines = (values = {}) => Object.entries(values).filter(([, value]) => value !== null && value !== undefined).map(([bucket, value]) => `${t(bucket)}: ${value}`);
  return (
    <div className="responsive-table">
      <table>
        <thead>
          <tr>
            <th>{t("Date")}</th>
            <th>{t("Transaction")}</th>
            <th>{t("Category")}</th>
            <th>{t("Bucket changes")}</th>
            <th>{t("Balances after")}</th>
            <th>{t("Status")}</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.id}>
              <td>
                {tx.createdAt
                  ? new Date(tx.createdAt).toLocaleString(getFormatLocale(), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : tx.date}
              </td>
              <td>
                <b>{t(tx.type)}</b>
                <small className="table-subtitle">{tx.item}</small>
                {(tx.orderReference || tx.refundReference) && <small className="table-subtitle">{tx.orderReference && t("Order: {0}", { 0: tx.orderReference })}{tx.orderReference && tx.refundReference ? " · " : ""}{tx.refundReference && t("Refund: {0}", { 0: tx.refundReference })}</small>}
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
                  {t(tx.category)}
                </Badge>
              </td>
              <td><div className="ledger-buckets">{bucketLines(tx.deltas).map((line) => <span key={line}>{line}</span>)}{!bucketLines(tx.deltas).length && <span>{t("No point change")}</span>}</div></td>
              <td><div className="ledger-buckets">{balanceLines(tx.balancesAfter).map((line) => <span key={line}>{line}</span>)}{!balanceLines(tx.balancesAfter).length && <span>{t("Not supplied")}</span>}</div></td>
              <td>
                <span className="status-text">
                  <CheckCircle2 size={14} /> {t(tx.status)}
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
  const { t } = useTranslation();
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
            placeholder={t("Search transactions")}
          />
        </div>
      </div>
      <TransactionTable transactions={filtered} />
    </Card>
  );
}

export function AdminDashboardPage() {
  const { t } = useTranslation();
  const {
    roleApplications,
    adminTrainerCertifications,
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
  const pendingCertifications = adminTrainerCertifications.filter(
    (item) => item.status === "pending",
  );
  const [selectedRoleId, setSelectedRoleId] = useState(
    pendingRoles[0]?.id || null,
  );
  const [roleDecisionReason, setRoleDecisionReason] = useState("");
  const [selectedCertificationId, setSelectedCertificationId] = useState(
    pendingCertifications[0]?.id || null,
  );
  const [certificationReason, setCertificationReason] = useState("");
  const [certificationError, setCertificationError] = useState("");
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
  const decideCertification = async (status) => {
    if (!selectedCertification || certificationReason.trim().length < 5) return;
    setCertificationError("");
    try {
      await decideTrainerCertification(selectedCertification.id, status, certificationReason.trim());
      setCertificationReason("");
      setSelectedCertificationId(null);
    } catch (error) {
      setCertificationError(error.message || "The certification decision could not be saved.");
    }
  };
  return (
    <>
      <div className="metric-grid four">
        <Metric
          label={t("Pending role applications")}
          value={pendingRoles.length}
          icon={UserCheck}
        />
        <Metric
          label={t("Refund requests")}
          value={pendingRefunds.length}
          icon={RotateCcw}
        />
        <Metric label={t("Active courses")} value={courses.filter((item) => item.isPublished !== false).length} icon={BookOpen} />
        <Metric
          label={t("Trainer certifications")}
          value={pendingCertifications.length}
          icon={ShieldCheck}
        />
      </div>
      <div className="content-grid two">
        <Card>
          <div className="card-heading">
            <div>
              <span className="eyebrow">{t("Priority queue")}</span>
              <h3>{t("Role application review")}</h3>
            </div>
            <Badge tone="warning">{pendingRoles.length}{t(" pending")}</Badge>
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
                      {t(application.type)} · {application.category}
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
                  >{t("Review")}</Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-copy">{t("No pending role applications.")}</p>
          )}
          {selectedRole && (
            <div className="application-review">
              <h4>{selectedRole.user} · {selectedRole.type}</h4>
              <dl className="detail-list">
                <div><dt>{t("Category")}</dt><dd>{selectedRole.category}</dd></div>
                <div><dt>{t("Experience")}</dt><dd>{selectedRole.experience}</dd></div>
                <div><dt>{t("Portfolio")}</dt><dd>{selectedRole.portfolio}</dd></div>
                 <div><dt>{t("Reason")}</dt><dd>{selectedRole.reason}</dd></div>
                 <div><dt>{t("Declaration")}</dt><dd>{selectedRole.declarationAccepted ? t("Accepted") : t("Missing")}</dd></div>
              </dl>
              <FormField label={t("Decision reason")}>
                <textarea
                  value={roleDecisionReason}
                  onChange={(event) => setRoleDecisionReason(event.target.value)}
                  placeholder={t("Record why this application is approved or rejected")}
                />
              </FormField>
              <div className="button-row">
                <Button disabled={roleDecisionReason.trim().length < 5} onClick={() => decideRole("Approved")}>{t("Approve")}</Button>
                <Button variant="danger" disabled={roleDecisionReason.trim().length < 5} onClick={() => decideRole("Rejected")}>{t("Reject")}</Button>
              </div>
            </div>
          )}
        </Card>
        <Card>
          <div className="card-heading">
            <div>
              <span className="eyebrow">{t("Policy workflow")}</span>
              <h3>{t("Refund management")}</h3>
            </div>
            <Badge tone="danger">{pendingRefunds.length}{t(" requests")}</Badge>
          </div>
          <p>{t("Review the course format, cancellation deadline, viewing percentage and video download evidence before making a decision.")}</p>
          <Button onClick={() => navigate("/admin/refunds")}>{t("Open refund review ")}<ArrowRight size={16} />
          </Button>
        </Card>
      </div>
      <Card>
        <div className="card-heading">
          <div>
            <span className="eyebrow">{t("Separate P0 gate")}</span>
            <h3>{t("Trainer certification review")}</h3>
          </div>
          <Badge tone="warning">{pendingCertifications.length}{t(" pending")}</Badge>
        </div>
        <p>{t("Approving a Trainer application does not grant the operational role. Certification evidence and a second recorded decision are required.")}</p>
        {pendingCertifications.length ? (
          <div className="application-review">
            <FormField label={t("Trainer certification record")}>
              <select
                value={selectedCertification?.id || ""}
                onChange={(event) => {
                  setSelectedCertificationId(event.target.value);
                  setCertificationReason("");
                  setCertificationError("");
                }}
              >
                {pendingCertifications.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.trainer?.displayName || t("Trainer")} · {item.certificationName}{item.certificationReference ? ` · ${item.certificationReference}` : ""}
                  </option>
                ))}
              </select>
            </FormField>
            {certificationError && <p role="alert" className="form-error">{t(certificationError)}</p>}
            <FormField label={t("Certification decision reason")}>
              <textarea
                value={certificationReason}
                onChange={(event) => setCertificationReason(event.target.value)}
                placeholder={t("Record the reviewed evidence and decision")}
              />
            </FormField>
            <div className="button-row">
              <Button
                disabled={certificationReason.trim().length < 5}
                onClick={() => decideCertification("Approved")}
              >{t("Approve certification")}</Button>
              <Button
                variant="danger"
                disabled={certificationReason.trim().length < 5}
                onClick={() => decideCertification("Rejected")}
              >{t("Reject certification")}</Button>
            </div>
          </div>
        ) : (
          <p className="empty-copy">{t("No Trainer certifications await review.")}</p>
        )}
      </Card>
      <Card>
        <span className="eyebrow">{t("Platform control")}</span>
        <h3>{t("Management overview")}</h3>
        <div className="admin-actions">
          <button onClick={() => navigate("/admin/users")}>
            <UserCheck size={19} />
            <span>
              <b>{t("Users and roles")}</b>
              <small>{t("Profiles, permissions and applications")}</small>
            </span>
          </button>
          <button onClick={() => navigate("/admin/catalog")}>
            <BookOpen size={19} />
            <span>
              <b>{t("Courses and contents")}</b>
              <small>{t("Listings, publication and reports")}</small>
            </span>
          </button>
          <button onClick={() => navigate("/transactions")}>
            <CircleDollarSign size={19} />
            <span>
              <b>{t("Transactions")}</b>
              <small>{t("Points, income and refund records")}</small>
            </span>
          </button>
        </div>
      </Card>
    </>
  );
}

export function AdminRefundPage() {
  const { t } = useTranslation();
  const { refundRequests, decideRefund } = usePlatform();
  const [selectedId, setSelectedId] = useState(refundRequests[0]?.id || null);
  const [decisionReason, setDecisionReason] = useState("");
  const selected =
    refundRequests.find((item) => item.id === selectedId) || refundRequests[0];
  if (!selected)
    return (
      <Card>
        <h3>{t("No refund requests")}</h3>
        <p>{t("New member requests will appear here.")}</p>
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
            <span className="eyebrow">{t("Course refund requests")}</span>
            <h3>{t("Review queue")}</h3>
          </div>
          <Badge tone="warning">
            {refundRequests.filter((r) => r.status === "Pending").length}{" "}{t("pending")}</Badge>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>{t("User")}</th>
                <th>{t("Course")}</th>
                <th>{t("Policy basis")}</th>
                <th>{t("Eligibility")}</th>
                <th>{t("Status")}</th>
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
                  <td>{t(request.status)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="review-panel">
        <span className="eyebrow">{t("Selected request")}</span>
        <h3>
          {selected.user} · {selected.course}
        </h3>
        <dl className="detail-list">
          <div>
            <dt>{t("Member reason")}</dt>
            <dd>{selected.reason}</dd>
          </div>
          <div>
            <dt>{t("Policy evidence")}</dt>
            <dd>{selected.basis}</dd>
          </div>
          <div>
            <dt>{t("Points paid")}</dt>
            <dd>{selected.paid}</dd>
          </div>
          <div>
            <dt>{t("Eligibility")}</dt>
            <dd>
              {selected.status === "Pending"
                ? canApprove
                  ? t("Eligible")
                  : t("Not eligible")
                : selected.eligibility}
            </dd>
          </div>
          <div>
            <dt>{t("Current policy check")}</dt>
            <dd>
              {selected.eligibilityAtDecision || selected.basis}
            </dd>
          </div>
          <div>
            <dt>{t("Current status")}</dt>
            <dd>{t(selected.status)}</dd>
          </div>
        </dl>
        <FormField label={t("Decision reason")}>
          <textarea
            disabled={selected.status !== "Pending"}
            value={decisionReason}
            onChange={(event) => setDecisionReason(event.target.value)}
            placeholder={t("Explain the approval or rejection")}
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
            <Check size={16} />{t(" Approve")}</Button>
          <Button
            variant="danger"
            disabled={
              selected.status !== "Pending" || decisionReason.trim().length < 5
            }
            onClick={() => decide("Rejected")}
          >
            <X size={16} />{t(" Reject")}</Button>
        </div>
        <p className="policy-note">
          <ShieldCheck size={17} />{t(" Approval returns points to the learner. Rejection keeps the original transaction.")}</p>
      </Card>
    </div>
  );
}

export function AdminUsersPage() {
  const { t } = useTranslation();
  const { profile, approvedRoles, applications, roleApplications } =
    usePlatform();
  return (
    <div className="stack">
      <Card>
        <span className="eyebrow">{t("Account overview")}</span>
        <h3>{profile.name}</h3>
        <div className="badge-row">
          {approvedRoles.map((role) => (
            <Badge key={role} tone="success">{t(role)}</Badge>
          ))}
        </div>
        <dl className="detail-list">
          <div><dt>{t("Email")}</dt><dd>{profile.email}</dd></div>
          <div><dt>{t("Trainer application")}</dt><dd>{applications.Trainer}</dd></div>
          <div><dt>{t("Creator application")}</dt><dd>{applications.Creator}</dd></div>
        </dl>
      </Card>
      <Card className="table-card">
        <div className="card-heading">
          <div><span className="eyebrow">{t("Role records")}</span><h3>{t("Application history")}</h3></div>
          <Badge>{roleApplications.length}{t(" records")}</Badge>
        </div>
        <div className="responsive-table">
          <table>
            <thead><tr><th>{t("User")}</th><th>{t("Role")}</th><th>{t("Category")}</th><th>{t("Status")}</th><th>{t("Certification")}</th><th>{t("Decision")}</th></tr></thead>
            <tbody>
              {roleApplications.map((item) => (
                <tr key={item.id}>
                  <td><b>{item.user}</b></td>
                  <td>{item.type}</td>
                  <td>{item.category}</td>
                  <td><Badge tone={item.status === "Approved" ? "success" : item.status === "Rejected" ? "danger" : "warning"}>{t(item.status)}</Badge></td>
                  <td>{item.type === "Trainer" ? item.certificationStatus || t("Not started") : t("Not required")}</td>
                  <td>{item.decisionReason || t("Pending review")}</td>
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
  const { t } = useTranslation();
  const { courses, contents } = usePlatform();
  const [tab, setTab] = useState("Courses");
  const items = tab === "Courses" ? courses : contents;
  return (
    <Card className="table-card">
      <div className="card-heading">
        <div><span className="eyebrow">{t("Marketplace control")}</span><h3>{t("Courses and contents")}</h3></div>
        <Segmented options={["Courses", "Contents"]} value={tab} onChange={setTab} />
      </div>
      <div className="responsive-table">
        <table>
          <thead><tr><th>{t("Title")}</th><th>{t("Owner")}</th><th>{t("Category")}</th><th>{t("Price")}</th><th>{t("Publication")}</th><th>{t("Purchases")}</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td><b>{item.title}</b></td>
                <td>{item.trainer || item.creator}</td>
                <td>{item.category}</td>
                <td>{item.price}{t(" points")}</td>
                <td><Badge tone={item.isPublished === false ? "warning" : "success"}>{item.isPublished === false ? t("Hidden / Draft") : t("Published")}</Badge></td>
                <td>{item.purchased ? t("Purchased") : t("Available")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
