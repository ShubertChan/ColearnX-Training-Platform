import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Eye, EyeOff, LockKeyhole, Mail, UserRound } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button, FormField } from "../components/ui";
import { usePlatform } from "../context/PlatformContext";
import { requestPasswordReset, resetPassword } from "../api/auth";
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
  if (!password) return null;
  const checklist = passwordChecklist(password, context);
  const strength = passwordStrength(password, context);
  return <div className="password-guidance" aria-live="polite"><div className="password-strength"><span className="password-strength-bar" data-band={strength.band} /><span>{strength.label}</span></div><ul className="password-checklist">{checklist.map((item) => <li key={item.id} className={item.passed ? "met" : "unmet"}><CheckCircle2 size={14} /><span>{item.label}</span></li>)}</ul></div>;
}

function AuthStory({ recovery = false }) {
  return <section className="auth-story"><img src={nextLogo} alt="neXt" /><div><span className="eyebrow light">{recovery ? "Account security" : "CoLearnX Learning Platform"}</span><h1>{recovery ? "Recover access without exposing account details." : "Learn, create and grow in one connected space."}</h1><p>{recovery ? "One-time, time-limited reset links protect your account." : "Discover courses, unlock creator resources and build your teaching profile."}</p></div><ul><li><CheckCircle2 size={18} /> Secure account recovery</li><li><CheckCircle2 size={18} /> Authorised course delivery</li><li><CheckCircle2 size={18} /> Server-issued purchase records</li></ul></section>;
}

export function AuthPage({ mode = "login" }) {
  const register = mode === "register"; const navigate = useNavigate(); const location = useLocation(); const { signIn, registerMember } = usePlatform();
  const [show, setShow] = useState(false); const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [acceptedTerms, setAcceptedTerms] = useState(false); const [ageAcknowledged, setAgeAcknowledged] = useState(false); const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (register && password !== confirmation) return setError("Passwords do not match.");
    if (register && !passwordChecklistPasses(password, { email, displayName: name })) return setError(`Choose a password of at least ${PASSWORD_MIN_LENGTH} characters that meets the requirements listed below.`);
    if (register && (!acceptedTerms || !ageAcknowledged)) return setError("Accept the terms/privacy notice and confirm the age policy.");
    setError(""); setSubmitting(true);
    try {
      if (register) {
        const pending = await registerMember({ name: name.trim(), email: email.trim(), password, passwordConfirmation: confirmation, acceptedTerms, ageAcknowledged });
        navigate(`/verify-email?email=${encodeURIComponent(pending.email)}`, { state: { email: pending.email, expiresAt: pending.expiresAt, resendAvailableAt: pending.resendAvailableAt } });
      } else {
        const identity = await signIn({ email: email.trim(), password });
        navigate(intendedPath(location.state?.from, identity.roles.includes("Admin") ? "/admin" : "/home"), { replace: true });
      }
    } catch (authError) {
      if (!register && authError.code === "EMAIL_VERIFICATION_REQUIRED") return navigate(`/verify-email?email=${encodeURIComponent(email.trim())}`);
      setError(authError.message);
    } finally { setSubmitting(false); }
  };
  return <div className="auth-page"><AuthStory /><section className="auth-form-wrap"><form className="auth-form" onSubmit={submit}><span className="eyebrow">{register ? "New member" : "Welcome back"}</span><h2>{register ? "Create your account" : "Sign in to CoLearnX"}</h2><p>{register ? "A Member profile and points wallet will be created automatically." : "Continue your learning and creator activity."}</p>{register && <FormField label="Full name"><div className="input-with-icon"><UserRound size={18} /><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Your full name" /></div></FormField>}<FormField label="Email address"><div className="input-with-icon"><Mail size={18} /><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></div></FormField><FormField label="Password"><div className="input-with-icon"><LockKeyhole size={18} /><input required autoComplete={register ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} type={show ? "text" : "password"} /><button type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></FormField>{register && <PasswordGuidance password={password} context={{ email, displayName: name }} />}{register && <FormField label="Confirm password"><div className="input-with-icon"><LockKeyhole size={18} /><input required autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} type={show ? "text" : "password"} /></div></FormField>}{error && <div className="form-error" role="alert">{error}</div>}{register && <div className="auth-consents"><label className="check-label"><input required type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} /><span>I accept the <Link to="/terms" target="_blank">Terms</Link> and <Link to="/privacy" target="_blank">Privacy Notice</Link>.</span></label><label className="check-label"><input required type="checkbox" checked={ageAcknowledged} onChange={(event) => setAgeAcknowledged(event.target.checked)} /><span>I meet the configured minimum-age policy.</span></label></div>}<Button className="wide" type="submit" disabled={submitting}>{submitting ? "Connecting…" : register ? "Create Member account" : "Sign in"}<ArrowRight size={17} /></Button>{!register && <p className="auth-recovery"><Link to="/forgot-password">Forgot your password?</Link></p>}<p className="auth-switch">{register ? "Already have an account?" : "New to CoLearnX?"} <Link to={register ? "/login" : "/register"}>{register ? "Sign in" : "Create account"}</Link></p></form></section></div>;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [submitted, setSubmitted] = useState(false);
  const submit = async (event) => { event.preventDefault(); setBusy(true); setError(""); try { await requestPasswordReset({ email: email.trim() }); setSubmitted(true); } catch (requestError) { setError(requestError.message); } finally { setBusy(false); } };
  return <div className="auth-page"><AuthStory recovery /><section className="auth-form-wrap"><form className="auth-form" onSubmit={submit}><span className="eyebrow">Password reset</span><h2>Request a reset link</h2><p>If the address belongs to an account, CoLearnX will send reset instructions. The same response is shown for every address.</p>{!submitted && <FormField label="Email address"><div className="input-with-icon"><Mail size={18} /><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></div></FormField>}{error && <div className="form-error" role="alert">{error}</div>}{submitted ? <div className="form-success" role="status">If this address is registered, a reset link will arrive shortly.</div> : <Button className="wide" type="submit" disabled={busy}>{busy ? "Requesting…" : "Send reset instructions"}</Button>}<p className="auth-switch"><Link to="/login">Back to sign in</Link></p></form></section></div>;
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams(); const navigate = useNavigate();
  // Read once into state, then removed from the address bar below. HashRouter
  // keeps the token out of the Referer and off the wire, but left in the URL it
  // still persists in browser history and on screen -- and for its lifetime it
  // is a credential.
  const [token] = useState(() => searchParams.get("token") || "");
  useEffect(() => { if (searchParams.get("token")) navigate("/reset-password", { replace: true }); }, [navigate, searchParams]); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (event) => { event.preventDefault(); if (!token) return setError("This reset link is incomplete. Request a new link."); if (password !== confirmation) return setError("Passwords do not match."); if (!passwordChecklistPasses(password)) return setError(`Choose a password of at least ${PASSWORD_MIN_LENGTH} characters that meets the requirements listed below.`); setBusy(true); setError(""); try { await resetPassword({ token, password, passwordConfirmation: confirmation }); navigate("/login", { replace: true, state: { passwordReset: true } }); } catch (resetError) { setError(resetError.message); } finally { setBusy(false); } };
  return <div className="auth-page"><AuthStory recovery /><section className="auth-form-wrap"><form className="auth-form" onSubmit={submit}><span className="eyebrow">Password reset</span><h2>Set your new password</h2><p>The reset token is single-use and expires at the time set by the server.</p><FormField label="New password"><input required type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></FormField><PasswordGuidance password={password} /><FormField label="Confirm new password"><input required type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></FormField>{error && <div className="form-error" role="alert">{error}</div>}<Button className="wide" type="submit" disabled={busy || !token}>{busy ? "Saving…" : "Reset password"}</Button>{!token && <p className="auth-switch"><Link to="/forgot-password">Request a new reset link</Link></p>}</form></section></div>;
}
