import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Mail, RotateCcw } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button, FormField } from "../components/ui";
import { usePlatform } from "../context/PlatformContext";
import nextLogo from "../../assets/next-logo.jpg";

const secondsUntil = (value) => {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
};

export function VerifyEmailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { resendRegistrationEmail, verifyRegistrationEmail } = usePlatform();
  const initialEmail = useMemo(
    () => searchParams.get("email") || location.state?.email || "",
    [location.state?.email, searchParams],
  );
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [error, setError] = useState(location.state?.deliveryError || "");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [expiresAt, setExpiresAt] = useState(location.state?.expiresAt || "");
  const [expiresIn, setExpiresIn] = useState(() => secondsUntil(location.state?.expiresAt));
  const [resendAvailableAt, setResendAvailableAt] = useState(
    location.state?.resendAvailableAt || "",
  );
  const [cooldown, setCooldown] = useState(() =>
    secondsUntil(location.state?.resendAvailableAt),
  );

  // Count down from the fixed resend-available timestamp, recomputing against
  // the wall clock each tick -- the same shape as the expiry countdown below.
  // The earlier version keyed the interval on `cooldown` itself and decremented
  // by one, so every tick tore the timer down and rebuilt it; a re-render from
  // the expiry interval or from typing the code could clear the pending tick
  // before it fired and the counter stalled (stuck partway, never reaching 0).
  // Keying on the timestamp means the interval is created once and self-heals
  // across dropped ticks or a backgrounded tab.
  useEffect(() => {
    if (!resendAvailableAt) return undefined;
    setCooldown(secondsUntil(resendAvailableAt));
    const timer = window.setInterval(
      () => setCooldown(secondsUntil(resendAvailableAt)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [resendAvailableAt]);

  useEffect(() => {
    if (!expiresAt) return undefined;
    setExpiresIn(secondsUntil(expiresAt));
    const timer = window.setInterval(() => setExpiresIn(secondsUntil(expiresAt)), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    setSubmitting(true);
    try {
      const result = await verifyRegistrationEmail({ email: email.trim(), code });
      navigate(result.authenticated ? "/home" : "/login", {
        replace: true,
        state: { email: email.trim(), verified: true },
      });
    } catch (verificationError) {
      setError(verificationError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    setError("");
    setMessage("");
    setResending(true);
    try {
      const result = await resendRegistrationEmail({ email: email.trim() });
      setMessage("If this address has a pending CoLearnX registration, a new verification email will arrive shortly.");
      setExpiresAt(result.expiresAt || "");
      setExpiresIn(secondsUntil(result.expiresAt));
      setResendAvailableAt(result.resendAvailableAt || "");
      setCooldown(secondsUntil(result.resendAvailableAt));
    } catch (resendError) {
      setError(resendError.message);
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="auth-page">
      <section className="auth-story">
        <img src={nextLogo} alt="neXt" />
        <div>
          <span className="eyebrow light">Account security</span>
          <h1>Confirm that this email address belongs to you.</h1>
          <p>We use email only for this step. No SMS or other messaging channel is used.</p>
        </div>
        <ul>
          <li><CheckCircle2 size={18} /> One-time email code</li>
          <li><CheckCircle2 size={18} /> Short expiry and attempt limits</li>
          <li><CheckCircle2 size={18} /> Sign in only after verification</li>
        </ul>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <span className="eyebrow">Email verification</span>
          <h2>Enter your code</h2>
          <p>Check your inbox for the eight-digit code. {expiresAt ? expiresIn > 0 ? `This code expires in ${expiresIn}s.` : "This code has expired; request a new one." : "The expiry time is set by the server."}</p>
          <FormField label="Email address">
            <div className="input-with-icon">
              <Mail size={18} />
              <input
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
              />
            </div>
          </FormField>
          <FormField label="Verification code">
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              placeholder="12345678"
            />
          </FormField>
          {error && <div className="form-error" role="alert">{error}</div>}
          {message && <div className="form-success" role="status">{message}</div>}
          <Button className="wide" type="submit" disabled={submitting}>
            {submitting ? "Verifying…" : "Verify email"}
          </Button>
          <Button
            className="wide"
            type="button"
            variant="secondary"
            disabled={resending || cooldown > 0 || !email.trim()}
            onClick={resend}
          >
            <RotateCcw size={17} />
            {resending ? "Sending…" : cooldown > 0 ? `Resend available in ${cooldown}s` : "Resend email code"}
          </Button>
          <p className="auth-switch">
            Already verified? <Link to="/login">Sign in</Link>
          </p>
        </form>
      </section>
    </div>
  );
}
