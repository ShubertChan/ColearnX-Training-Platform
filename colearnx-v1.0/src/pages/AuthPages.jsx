import { useTranslation } from "../i18n/LanguageContext";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Eye, EyeOff, LockKeyhole, Mail, UserRound, ShieldCheck } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button, FormField } from "../components/ui";
import { usePlatform } from "../context/PlatformContext";
import { requestPasswordReset, resetPassword } from "../api/auth";
import LanguageSwitcher from "../components/LanguageSwitcher";
import SessionConnectionNotice from "../components/SessionConnectionNotice";
import GoogleSignIn from "../components/GoogleSignIn";
import nextLogo from "../../assets/next-logo.jpg";
import { intendedPath } from "../utils/frontendState";
import { PASSWORD_MIN_LENGTH, passwordChecklist, passwordChecklistPasses, passwordStrength } from "../utils/passwordPolicy";

// The previous rule here demanded an upper-case letter, a lower-case letter
// and a digit. Both NIST SP 800-63B and ASVS 2.1.3 advise against composition
// requirements -- they push users toward `Password1!` while adding almost
// nothing to an attacker's search space -- and it was also enforced only in the
// browser, so calling the API directly bypassed it entirely. Strength is now
// decided by the server; this module mirrors a strict subset of that policy so
// the user finds out before submitting. See src/utils/passwordPolicy.js.

/**
 * Renders every unmet requirement at once rather than the first failure on
 * submit, which is how users end up appending characters to a bad password
 * until something is accepted.
 */
function PasswordGuidance({ password, context = {} }) {
  const { t } = useTranslation();
  if (!password) return null;
  const checklist = passwordChecklist(password, context);
  const strength = passwordStrength(password, context);
  return <div className="password-guidance" aria-live="polite"><div className="password-strength"><span className="password-strength-bar" data-band={strength.band} /><span>{t(strength.label)}</span></div><ul className="password-checklist">{checklist.map((item) => <li key={item.id} className={item.passed ? "met" : "unmet"}><CheckCircle2 size={14} /><span>{t(item.label)}</span></li>)}</ul></div>;
}

function AuthStory({ recovery = false }) {
  const { t } = useTranslation();
  return <section className="auth-story"><img src={nextLogo} alt="neXt" /><div><span className="eyebrow light">{recovery ? t("Account security") : t("CoLearnX Learning Platform")}</span><h1>{recovery ? t("Recover access without exposing account details.") : t("Learn, create and grow in one connected space.")}</h1><p>{recovery ? t("One-time, time-limited reset links protect your account.") : t("Discover courses, unlock creator resources and build your teaching profile.")}</p></div><ul><li><CheckCircle2 size={18} />{t(" Secure account recovery")}</li><li><CheckCircle2 size={18} />{t(" Authorised course delivery")}</li><li><CheckCircle2 size={18} />{t(" Server-issued purchase records")}</li></ul></section>;
}

export function AuthPage({ mode = "login" }) {
  const { t } = useTranslation();
  const register = mode === "register"; const navigate = useNavigate(); const location = useLocation(); const { signIn, completeSignIn, registerMember } = usePlatform();
  const [show, setShow] = useState(false); const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [acceptedTerms, setAcceptedTerms] = useState(false); const [ageAcknowledged, setAgeAcknowledged] = useState(false); const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  // Counts sign-in failures observed *by this browser*, keyed by the address
  // that was tried. The server never discloses whether an account is locked --
  // a distinguishable "locked" response would let an attacker enumerate real
  // users by seeing which addresses lock. But the browser already knows how
  // many times it just failed, because it made those attempts, so surfacing
  // that count reveals nothing new and gives a genuine user the explanation
  // they would otherwise never get.
  const [failures, setFailures] = useState({ email: "", count: 0 });
  const [mfa, setMfa] = useState(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const signedInWithGoogle = (identity) => {
    if (identity.mfaRequired) {
      setMfa({ token: identity.mfaToken, code: "", error: "", busy: false });
      return;
    }
    navigate(intendedPath(location.state?.from, identity.roles.includes("Admin") ? "/admin" : "/home"), { replace: true });
  };
  const attemptedEmail = email.trim().toLowerCase();
  const repeatedFailures = failures.email === attemptedEmail ? failures.count : 0;

  const submitMfa = async (event) => {
    event.preventDefault();
    setMfa((previous) => ({ ...previous, busy: true, error: "" }));
    try {
      const identity = await completeSignIn({ mfaToken: mfa.token, code: mfa.code });
      const target = intendedPath(location.state?.from, identity.roles.includes("Admin") ? "/admin" : "/home");
      navigate(target, { replace: true });
    } catch (mfaError) {
      setMfa((previous) => ({ ...previous, busy: false, error: mfaError.message }));
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (googleBusy || submitting) return;
    if (register && password !== confirmation) return setError("Passwords do not match.");
    if (register && !passwordChecklistPasses(password, { email, displayName: name })) return setError({ key: "Choose a password of at least {count} characters that meets the requirements listed below.", values: { count: PASSWORD_MIN_LENGTH } });
    if (register && (!acceptedTerms || !ageAcknowledged)) return setError("Accept the terms/privacy notice and confirm the age policy.");
    setError(""); setSubmitting(true);
    try {
      if (register) {
        const pending = await registerMember({ name: name.trim(), email: email.trim(), password, passwordConfirmation: confirmation, acceptedTerms, ageAcknowledged });
        navigate(`/verify-email?email=${encodeURIComponent(pending.email)}`, { state: { email: pending.email, expiresAt: pending.expiresAt, resendAvailableAt: pending.resendAvailableAt } });
      } else {
        const identity = await signIn({ email: email.trim(), password });
        setFailures({ email: "", count: 0 });
        if (identity.mfaRequired) {
          // The password is proven but no session exists yet. The token lives
          // in component state only -- never in storage -- so closing the tab
          // abandons the attempt rather than leaving a half-authenticated
          // credential behind.
          setMfa({ token: identity.mfaToken, code: "", error: "", busy: false });
          setSubmitting(false);
          return;
        }
        navigate(intendedPath(location.state?.from, identity.roles.includes("Admin") ? "/admin" : "/home"), { replace: true });
      }
    } catch (authError) {
      if (!register && authError.code === "EMAIL_VERIFICATION_REQUIRED") return navigate(`/verify-email?email=${encodeURIComponent(email.trim())}`);
      setError(authError.message);
      if (!register && authError.code === "INVALID_CREDENTIALS") {
        setFailures((previous) => ({
          email: attemptedEmail,
          count: previous.email === attemptedEmail ? previous.count + 1 : 1,
        }));
      }
    } finally { setSubmitting(false); }
  };
  if (mfa) {
    return <div className="auth-page"><AuthStory /><section className="auth-form-wrap"><LanguageSwitcher className="auth-language" /><form className="auth-form" onSubmit={submitMfa}><span className="eyebrow">{t("Two-factor authentication")}</span><h2>{t("Enter your verification code")}</h2><p>{t("Open your authenticator app and enter the current six-digit code. You can also use one of your recovery codes.")}</p><FormField label={t("Verification code")}><div className="input-with-icon"><ShieldCheck size={18} /><input required autoFocus autoComplete="one-time-code" inputMode="text" value={mfa.code} onChange={(event) => setMfa((previous) => ({ ...previous, code: event.target.value }))} placeholder={t("123456 or a recovery code")} /></div></FormField>{mfa.error && <div className="form-error" role="alert">{t(mfa.error)}</div>}<Button className="wide" type="submit" disabled={mfa.busy}>{mfa.busy ? t("Verifying…") : t("Verify and sign in")}<ArrowRight size={17} /></Button><p className="auth-switch"><button type="button" className="link-button" onClick={() => setMfa(null)}>{t("Use a different account")}</button></p></form></section></div>;
  }

  return <div className="auth-page"><AuthStory /><section className="auth-form-wrap">
    <LanguageSwitcher className="auth-language" />
    <form className="auth-form" onSubmit={submit}>
      <span className="eyebrow">{register ? t("New member") : t("Welcome back")}</span>
      <h2>{register ? t("Create your account") : t("Sign in to CoLearnX")}</h2>
      <p>{register ? t("A Member profile and points wallet will be created automatically.") : t("Continue your learning and creator activity.")}</p>
      <SessionConnectionNotice />
      {register && <FormField label={t("Full name")}><div className="input-with-icon"><UserRound size={18} /><input required value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Your full name")} /></div></FormField>}
      <FormField label={t("Email address")}><div className="input-with-icon"><Mail size={18} /><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("name@example.com")} /></div></FormField>
      <FormField label={t("Password")}><div className="input-with-icon"><LockKeyhole size={18} /><input required autoComplete={register ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} type={show ? "text" : "password"} /><button type="button" onClick={() => setShow(!show)} aria-label={show ? t("Hide password") : t("Show password")}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></FormField>
      {register && <PasswordGuidance password={password} context={{ email, displayName: name }} />}
      {register && <FormField label={t("Confirm password")}><div className="input-with-icon"><LockKeyhole size={18} /><input required autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} type={show ? "text" : "password"} /></div></FormField>}
      {error && <div className="form-error" role="alert">{t(error)}</div>}
      {!register && repeatedFailures >= 5 && <div className="form-notice" role="status">{t("Several sign-in attempts for this address have failed. For security, repeated failures pause sign-in for a short time, so a correct password may still be refused until the pause ends. Wait a minute and try again, or ")}<Link to="/forgot-password">{t("reset your password")}</Link>{t(" — completing a reset lifts the pause immediately.")}</div>}
      {register && <div className="auth-consents"><label className="check-label"><input required type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} /><span>{t("I accept the ")}<Link to="/terms" target="_blank">{t("Terms")}</Link>{t(" and ")}<Link to="/privacy" target="_blank">{t("Privacy Notice")}</Link>.</span></label><label className="check-label"><input required type="checkbox" checked={ageAcknowledged} onChange={(event) => setAgeAcknowledged(event.target.checked)} /><span>{t("I meet the configured minimum-age policy.")}</span></label></div>}
      <Button className="wide" type="submit" disabled={submitting || googleBusy}>{submitting ? t("Connecting…") : register ? t("Create Member account") : t("Sign in")}<ArrowRight size={17} /></Button>
      {!register && <p className="auth-recovery"><Link to="/forgot-password">{t("Forgot your password?")}</Link></p>}
      {!register && <GoogleSignIn disabled={submitting} onBusyChange={setGoogleBusy} onSignedIn={signedInWithGoogle} />}
      <p className="auth-switch">{register ? t("Already have an account?") : t("New to CoLearnX?")} <Link to={register ? "/login" : "/register"}>{register ? t("Sign in") : t("Create account")}</Link></p>
    </form>
  </section></div>;
}

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [submitted, setSubmitted] = useState(false);
  const submit = async (event) => { event.preventDefault(); setBusy(true); setError(""); try { await requestPasswordReset({ email: email.trim() }); setSubmitted(true); } catch (requestError) { setError(requestError.message); } finally { setBusy(false); } };
  return <div className="auth-page"><AuthStory recovery /><section className="auth-form-wrap"><LanguageSwitcher className="auth-language" /><form className="auth-form" onSubmit={submit}><span className="eyebrow">{t("Password reset")}</span><h2>{t("Request a reset link")}</h2><p>{t("If the address belongs to an account, CoLearnX will send reset instructions. The same response is shown for every address.")}</p>{!submitted && <FormField label={t("Email address")}><div className="input-with-icon"><Mail size={18} /><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("name@example.com")} /></div></FormField>}{error && <div className="form-error" role="alert">{t(error)}</div>}{submitted ? <div className="form-success" role="status">{t("If this address is registered, a reset link will arrive shortly.")}</div> : <Button className="wide" type="submit" disabled={busy}>{busy ? t("Requesting…") : t("Send reset instructions")}</Button>}<p className="auth-switch"><Link to="/login">{t("Back to sign in")}</Link></p></form></section></div>;
}

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams(); const navigate = useNavigate();
  // Read once into state, then removed from the address bar below. HashRouter
  // keeps the token out of the Referer and off the wire, but left in the URL it
  // still persists in browser history and on screen -- and for its lifetime it
  // is a credential.
  const [token] = useState(() => searchParams.get("token") || "");
  useEffect(() => { if (searchParams.get("token")) navigate("/reset-password", { replace: true }); }, [navigate, searchParams]); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (event) => { event.preventDefault(); if (!token) return setError("This reset link is incomplete. Request a new link."); if (password !== confirmation) return setError("Passwords do not match."); if (!passwordChecklistPasses(password)) return setError({ key: "Choose a password of at least {count} characters that meets the requirements listed below.", values: { count: PASSWORD_MIN_LENGTH } }); setBusy(true); setError(""); try { await resetPassword({ token, password, passwordConfirmation: confirmation }); navigate("/login", { replace: true, state: { passwordReset: true } }); } catch (resetError) { setError(resetError.message); } finally { setBusy(false); } };
  return <div className="auth-page"><AuthStory recovery /><section className="auth-form-wrap"><LanguageSwitcher className="auth-language" /><form className="auth-form" onSubmit={submit}><span className="eyebrow">{t("Password reset")}</span><h2>{t("Set your new password")}</h2><p>{t("The reset token is single-use and expires at the time set by the server.")}</p><FormField label={t("New password")}><input required type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></FormField><PasswordGuidance password={password} /><FormField label={t("Confirm new password")}><input required type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></FormField>{error && <div className="form-error" role="alert">{t(error)}</div>}<Button className="wide" type="submit" disabled={busy || !token}>{busy ? t("Saving…") : t("Reset password")}</Button>{!token && <p className="auth-switch"><Link to="/forgot-password">{t("Request a new reset link")}</Link></p>}</form></section></div>;
}
