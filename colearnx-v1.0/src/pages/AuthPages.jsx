import { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  UserRound,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button, FormField } from "../components/ui";
import { usePlatform } from "../context/PlatformContext";

export function AuthPage({ mode = "login" }) {
  const register = mode === "register";
  const navigate = useNavigate();
  const { signIn, registerMember } = usePlatform();
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [ageAcknowledged, setAgeAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (register && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (
      password.length < 8 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/\d/.test(password)
    ) {
      setError(
        "Password must be at least 8 characters and include upper-case, lower-case and a number.",
      );
      return;
    }
    if (register && (!acceptedTerms || !ageAcknowledged)) {
      setError("Accept the terms/privacy notice and confirm the age policy.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      if (register) {
        const pending = await registerMember({
          name: name.trim(),
          email: email.trim(),
          password,
          passwordConfirmation: confirmPassword,
          acceptedTerms,
          ageAcknowledged,
        });
        navigate(`/verify-email?email=${encodeURIComponent(pending.email)}`, {
          state: { email: pending.email, resendAvailableAt: pending.resendAvailableAt },
        });
      } else {
        await signIn({ email: email.trim(), password });
        navigate("/home");
      }
    } catch (authError) {
      if (!register && authError.code === "EMAIL_VERIFICATION_REQUIRED") {
        navigate(`/verify-email?email=${encodeURIComponent(email.trim())}`);
        return;
      }
      setError(authError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <section className="auth-story">
        <img src="./assets/next-logo.jpg" alt="neXt" />
        <div>
          <span className="eyebrow light">CoLearnX Learning Platform</span>
          <h1>Learn, create and grow in one connected space.</h1>
          <p>
            Use one member account to discover courses, unlock creator resources
            and build your own public teaching profile.
          </p>
        </div>
        <ul>
          <li>
            <CheckCircle2 size={18} /> Unified points wallet
          </li>
          <li>
            <CheckCircle2 size={18} /> Clear refund eligibility
          </li>
          <li>
            <CheckCircle2 size={18} /> Trainer and creator pathways
          </li>
        </ul>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <span className="eyebrow">
            {register ? "New member" : "Welcome back"}
          </span>
          <h2>{register ? "Create your account" : "Sign in to CoLearnX"}</h2>
          <p>
            {register
              ? "A Member profile and points wallet will be created automatically."
              : "Continue your learning and creator activity."}
          </p>
          {register && (
            <FormField label="Full name">
              <div className="input-with-icon">
                <UserRound size={18} />
                <input
                  required
                  aria-label="Password"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your full name"
                />
              </div>
            </FormField>
          )}
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
          <FormField label="Password">
            <div className="input-with-icon">
              <LockKeyhole size={18} />
              <input
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={show ? "text" : "password"}
                placeholder="Enter your password"
              />
              <button
                type="button"
                onClick={() => setShow(!show)}
                aria-label={show ? "Hide password" : "Show password"}
              >
                {show ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </FormField>
          {register && (
            <FormField label="Confirm password">
              <div className="input-with-icon">
                <LockKeyhole size={18} />
                <input
                  required
                  aria-label="Confirm password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  type={show ? "text" : "password"}
                  placeholder="Repeat your password"
                />
              </div>
            </FormField>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {register && (
            <div className="auth-consents">
              <label className="check-label">
                <input
                  required
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(event) => setAcceptedTerms(event.target.checked)}
                />
                <span>I accept the Terms and Privacy Notice.</span>
              </label>
              <label className="check-label">
                <input
                  required
                  type="checkbox"
                  checked={ageAcknowledged}
                  onChange={(event) => setAgeAcknowledged(event.target.checked)}
                />
                <span>
                  I meet the configured minimum-age policy for launch.
                </span>
              </label>
            </div>
          )}
          <Button className="wide" type="submit" disabled={submitting}>
            {submitting ? "Connecting…" : register ? "Create Member account" : "Sign in"}
            <ArrowRight size={17} />
          </Button>
          {!register && (
            <p className="auth-recovery">
              <Link to="/forgot-password">Forgot your password?</Link>
            </p>
          )}
          <p className="auth-switch">
            {register ? "Already have an account?" : "New to CoLearnX?"}{" "}
            <Link to={register ? "/login" : "/register"}>
              {register ? "Sign in" : "Create account"}
            </Link>
          </p>
        </form>
      </section>
    </div>
  );
}

export function ForgotPasswordPage() {
  return (
    <div className="auth-page">
      <section className="auth-story">
        <img src="./assets/next-logo.jpg" alt="neXt" />
        <div>
          <span className="eyebrow light">Account recovery</span>
          <h1>Recover access without exposing account details.</h1>
          <p>Password reset email delivery has not been configured for this environment.</p>
        </div>
      </section>
      <section className="auth-form-wrap">
        <div className="auth-form">
          <span className="eyebrow">Password reset</span>
          <h2>Password reset unavailable</h2>
          <p>
            This platform does not display a fake confirmation. Configure the
            server-side email and reset-token flow before enabling this action.
          </p>
          <p className="auth-switch">
            <Link to="/login">Back to sign in</Link>
          </p>
        </div>
      </section>
    </div>
  );
}
