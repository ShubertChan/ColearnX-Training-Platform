import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, LockKeyhole, ShieldCheck } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js/pure";
import { CheckoutElementsProvider, ExpressCheckoutElement, PaymentElement, useCheckoutElements } from "@stripe/react-stripe-js/checkout";
import { getTopUpCheckoutSession } from "../api/payments";
import { Button } from "../components/ui";
import { useTranslation } from "../i18n/LanguageContext";
import { usePlatform } from "../context/PlatformContext";
import "../styles/top-up-checkout.css";

const appearance = {
  theme: "stripe",
  variables: { colorPrimary: "#4057d6", colorText: "#172033", colorTextSecondary: "#667085", colorDanger: "#b42318", borderRadius: "8px", fontFamily: "system-ui, sans-serif", fontSizeBase: "16px", spacingUnit: "4px" },
  rules: { ".Input": { boxShadow: "none" }, ".AccordionItem": { boxShadow: "none" } },
};
const paymentOptions = { layout: { type: "accordion", defaultCollapsed: false, radios: true, spacedAccordionItems: false }, paymentMethodOrder: ["card", "paynow"], wallets: { applePay: "never", googlePay: "never" } };
const expressOptions = { buttonHeight: 48, layout: { maxColumns: 2, maxRows: 2, overflow: "never" }, paymentMethodOrder: ["apple_pay", "link", "google_pay"], buttonTheme: { applePay: "black" } };
const verificationPath = (id) => `/wallet?topUp=processing&paymentTransactionId=${encodeURIComponent(id)}`;

export default function TopUpCheckoutPage() {
  const { paymentTransactionId } = useParams();
  const { profile } = usePlatform();
  // An account change must discard the previous owner's in-memory client secret.
  return <CheckoutLoader key={`${profile?.id}:${paymentTransactionId}`} paymentTransactionId={paymentTransactionId} />;
}

function CheckoutLoader({ paymentTransactionId }) {
  const { t, language } = useTranslation();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let expiryTimer;
    setLoaded(null);
    setError("");
    async function load() {
      try {
        const session = await getTopUpCheckoutSession(paymentTransactionId);
        if (cancelled) return;
        if (session.status === "complete") {
          navigate(verificationPath(paymentTransactionId), { replace: true });
          return;
        }
        const stripe = await loadStripe(session.publishableKey, { locale: language === "zh-CN" ? "zh" : "en" });
        if (cancelled) return;
        if (!stripe) throw new Error("Unable to load secure payment. Please try again.");
        setLoaded({ session, stripe });
        expiryTimer = window.setTimeout(() => {
          setLoaded(null);
          setError("This payment session has expired. Return to your wallet to start again.");
        }, Math.max(0, session.expiresAt * 1000 - Date.now()));
      } catch (failure) {
        if (!cancelled) setError(failure.message || "Unable to load secure payment. Please try again.");
      }
    }
    void load();
    return () => { cancelled = true; window.clearTimeout(expiryTimer); };
  }, [paymentTransactionId, attempt, language, navigate]);
  const options = useMemo(() => loaded ? { clientSecret: loaded.session.clientSecret, elementsOptions: { appearance } } : null, [loaded]);

  return <div className="topup-checkout">
    <Link to="/wallet" className="back-link"><ArrowLeft size={16} aria-hidden="true" />{t("Back to wallet")}</Link>
    {error ? <section className="topup-checkout-state"><h2>{t("Payment unavailable")}</h2><p role="alert">{t(error)}</p><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>{t("Retry")}</Button></section>
      : !loaded ? <section className="topup-checkout-state" role="status"><span className="session-spinner" /><p>{t("Loading secure payment…")}</p></section>
        : <CheckoutElementsProvider stripe={loaded.stripe} options={options}>
          <TopUpPaymentForm session={loaded.session} paymentTransactionId={paymentTransactionId} onRetry={() => setAttempt(value => value + 1)} />
        </CheckoutElementsProvider>}
  </div>;
}

export function TopUpPaymentForm({ session, paymentTransactionId, onRetry }) {
  const { t, formatLocale } = useTranslation();
  const navigate = useNavigate();
  const checkoutState = useCheckoutElements();
  const [ready, setReady] = useState(false);
  const [complete, setComplete] = useState(false);
  const [expressAvailable, setExpressAvailable] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [elementFailed, setElementFailed] = useState(false);
  const submitting = useRef(false);
  const amount = new Intl.NumberFormat(formatLocale, { style: "currency", currency: session.currency }).format(session.amountMinor / 100);

  async function confirm(expressCheckoutConfirmEvent) {
    if (submitting.current || checkoutState.type !== "success") {
      expressCheckoutConfirmEvent?.paymentFailed({ reason: "fail" });
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await checkoutState.checkout.confirm({
        redirect: "if_required",
        ...(expressCheckoutConfirmEvent ? { expressCheckoutConfirmEvent } : {}),
      });
      if (result.type === "error") setError(result.error.message);
      else navigate(verificationPath(paymentTransactionId), { replace: true });
    } catch {
      setError("We could not confirm this payment. Please try again.");
      expressCheckoutConfirmEvent?.paymentFailed({ reason: "fail" });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const loadFailed = () => { setElementFailed(true); setError("Unable to load secure payment. Please try again."); };

  return <div className="topup-checkout-surface">
    <aside className="topup-checkout-summary" aria-labelledby="topup-summary-title">
      <span className="topup-sandbox-label">{t("Test payment")}</span>
      <h2 id="topup-summary-title">{t("Points top-up")}</h2>
      <strong className="topup-points">{session.points.toLocaleString(formatLocale)} <span>{t("points")}</span></strong>
      <dl><div><dt>{t("Total to pay")}</dt><dd>{amount}</dd></div></dl>
      <p><ShieldCheck size={18} aria-hidden="true" />{t("Your points will be added once payment is confirmed.")}</p>
    </aside>
    <div className="topup-checkout-payment">
      <section aria-labelledby="topup-contact-title" className="topup-contact">
        <h2 id="topup-contact-title">{t("Contact information")}</h2>
        <dl><dt>{t("Email")}</dt><dd>{session.email}</dd></dl>
      </section>
      {checkoutState.type === "loading" ? <p role="status">{t("Loading secure payment…")}</p>
        : checkoutState.type === "error" ? <div className="topup-payment-error"><p role="alert">{t("Unable to load secure payment. Please try again.")}</p><Button variant="secondary" onClick={onRetry}>{t("Retry")}</Button></div>
          : <form onSubmit={event => { event.preventDefault(); if (ready && complete && !elementFailed) void confirm(); }}>
            <section aria-labelledby="topup-methods-title">
              <h2 id="topup-methods-title">{t("Payment method")}</h2>
              <PaymentElement options={{ ...paymentOptions, readOnly: busy }} onReady={() => setReady(true)} onChange={event => setComplete(event.complete)} onLoadError={loadFailed} />
            </section>
            <section className="topup-express" hidden={expressAvailable === false} aria-label={t("Express payment")}>
              {expressAvailable && <div className="topup-payment-divider"><span>{t("Or pay with")}</span></div>}
              <ExpressCheckoutElement options={expressOptions} onReady={event => setExpressAvailable(Boolean(event.availablePaymentMethods && Object.values(event.availablePaymentMethods).some(Boolean)))} onLoadError={() => setExpressAvailable(false)} onConfirm={event => void confirm(event)} />
            </section>
            {error && <p className="form-error" role="alert">{t(error)}</p>}
            {elementFailed && <Button type="button" variant="secondary" onClick={onRetry}>{t("Retry")}</Button>}
            <Button type="submit" className="wide topup-pay-button" disabled={busy || !ready || !complete || elementFailed}>
              <LockKeyhole size={17} aria-hidden="true" />{busy ? t("Processing…") : t("Pay {amount}", { amount })}
            </Button>
          </form>}
      <footer className="topup-payment-footer"><span>{t("Secure payments by Stripe")}</span><nav aria-label={t("Payment information")}><Link to="/terms" target="_blank" rel="noopener noreferrer">{t("Terms")}</Link><Link to="/privacy" target="_blank" rel="noopener noreferrer">{t("Privacy")}</Link></nav></footer>
    </div>
  </div>;
}
