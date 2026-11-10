import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createGoogleChallenge, getGoogleConfig, loadGoogleIdentity } from "../api/googleIdentity";
import { useTranslation } from "../i18n/LanguageContext";
import { usePlatform } from "../context/PlatformContext";
import { Button } from "./ui";

export default function GoogleSignIn({ disabled = false, onSignedIn, onBusyChange }) {
  const { language, t } = useTranslation();
  const { signInWithGoogle } = usePlatform();
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pendingCredential, setPendingCredential] = useState("");
  const [terms, setTerms] = useState(false);
  const [age, setAge] = useState(false);
  const container = useRef(null);
  const active = useRef(false);
  const busyRef = useRef(false);
  const handler = useRef(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    let expiry;
    const controller = new AbortController();
    const { signal } = controller;
    setError(""); setSetup(null);
    (async () => {
      const config = await getGoogleConfig(signal);
      if (signal.aborted) return;
      if (!config.enabled) { setSetup({ disabled: true }); return; }
      const sdk = await loadGoogleIdentity();
      if (signal.aborted) return;
      const challenge = await createGoogleChallenge();
      if (signal.aborted) return;
      sdk.initialize({ client_id: config.clientId, nonce: challenge.nonce, auto_select: false, button_auto_select: false,
        ux_mode: "popup", callback: (response) => { if (!signal.aborted) void handler.current(response.credential); } });
      setSetup({ sdk });
      expiry = setTimeout(() => {
        setPendingCredential(""); setSetup(null);
        setError("Google sign-in expired. Please try again and allow cookies.");
      }, Math.max(0, Date.parse(challenge.expiresAt) - Date.now()));
    })().catch(() => {
      if (!signal.aborted) setError("Google sign-in could not load. Check your connection and try again.");
    });
    return () => { controller.abort(); clearTimeout(expiry); };
  }, [attempt]);

  useEffect(() => {
    if (!setup?.sdk || !container.current || pendingCredential) return;
    container.current.replaceChildren();
    setup.sdk.renderButton(container.current, {
      // Google personalizes large standard buttons with a previous visitor's
      // name/email. Medium keeps Google's translated text without that preview.
      type: "standard", theme: "outline", size: "medium", text: "signin_with",
      shape: "rectangular", logo_alignment: "left",
      width: Math.min(400, Math.floor(container.current.getBoundingClientRect().width || 300)),
      locale: language === "zh-CN" ? "zh_CN" : "en",
    });
  }, [setup, language, pendingCredential]);

  handler.current = async (credential, consent = false) => {
    if (!credential || busyRef.current || disabledRef.current) return;
    busyRef.current = true; setBusy(true); onBusyChange?.(true); setError("");
    try {
      const identity = await signInWithGoogle({ credential, ...(consent ? { acceptedTerms: true, ageAcknowledged: true } : {}) });
      if (!active.current) return;
      if (identity.registrationRequired) { setPendingCredential(credential); return; }
      setPendingCredential("");
      onSignedIn(identity);
    } catch (failure) {
      if (active.current) { setError(failure.message); setPendingCredential(""); setSetup(null); }
    } finally {
      busyRef.current = false;
      if (active.current) { setBusy(false); onBusyChange?.(false); }
    }
  };

  if (setup?.disabled) return null;
  if (!setup && !error) return <p className="google-sign-in-status" role="status">{t("Loading Google sign-in…")}</p>;
  return <div className="google-sign-in">
    <div className="auth-divider"><span>{t("or")}</span></div>
    {pendingCredential ? <div className="google-registration">
      <p>{t("Create your account with Google")}</p>
      <div className="auth-consents">
        <label className="check-label"><input type="checkbox" checked={terms} onChange={(event) => setTerms(event.target.checked)} /><span>{t("I accept the ")}<Link to="/terms" target="_blank">{t("Terms")}</Link>{t(" and ")}<Link to="/privacy" target="_blank">{t("Privacy Notice")}</Link>.</span></label>
        <label className="check-label"><input type="checkbox" checked={age} onChange={(event) => setAge(event.target.checked)} /><span>{t("I meet the configured minimum-age policy.")}</span></label>
      </div>
      <Button type="button" className="wide" disabled={!terms || !age || busy || disabled} onClick={() => handler.current(pendingCredential, true)}>{busy ? t("Connecting…") : t("Create Member account")}</Button>
      <button type="button" className="link-button" disabled={busy} onClick={() => { setPendingCredential(""); setTerms(false); setAge(false); setAttempt((value) => value + 1); }}>{t("Use a different account")}</button>
    </div> : setup?.sdk && <div ref={container} className="google-sign-in-button" inert={busy || disabled} aria-label={t("Sign in with Google")} />}
    {busy && <p className="google-sign-in-status" role="status">{t("Connecting…")}</p>}
    {error && <div className="form-error" role="alert">{t(error)} <button className="link-button" type="button" disabled={busy || disabled} onClick={() => setAttempt((value) => value + 1)}>{t("Try again")}</button></div>}
    <p className="google-sign-in-status">{t("On a shared computer, use a guest browser window.")}</p>
  </div>;
}
