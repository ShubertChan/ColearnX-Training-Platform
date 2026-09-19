import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { requestStepUp } from "../api/auth";
import { registerStepUpHandler } from "../api/stepUp.js";
import { Button, FormField, Modal } from "./ui";

export default function StepUpProvider({ children }) {
  const active = useRef(null);
  const [open, setOpen] = useState(false), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");

  function finish(prompt, result, failure) {
    if (active.current !== prompt) return;
    active.current = null;
    prompt.signal.removeEventListener("abort", prompt.abort);
    setOpen(false); setCode(""); setBusy(false);
    if (failure) prompt.reject(failure); else prompt.resolve(result);
  }
  const cancel = () => {
    if (active.current) finish(active.current, null, Object.assign(new Error("Identity verification cancelled. No action was taken."), { code: "STEP_UP_CANCELLED" }));
  };
  useEffect(() => registerStepUpHandler(signal => new Promise((resolve, reject) => {
    const prompt = { signal, resolve, reject };
    prompt.abort = () => finish(prompt, null, Object.assign(new Error("Your account session changed. Please try again."), { code: "SESSION_CHANGED" }));
    active.current = prompt;
    if (signal.aborted) { prompt.abort(); return; }
    signal.addEventListener("abort", prompt.abort, { once: true });
    setError(""); setCode(""); setBusy(false); setOpen(true);
  })), []);

  const submit = async event => {
    event.preventDefault();
    const prompt = active.current;
    if (!prompt || busy) return;
    setBusy(true); setError("");
    try {
      const result = await requestStepUp({ code: code.trim() }, { signal: prompt.signal });
      finish(prompt, result);
    } catch (failure) {
      if (active.current === prompt) { setError(failure.message); setBusy(false); }
    }
  };

  return <>{children}{open && <Modal title="Confirm your identity" onClose={cancel}>
    <form onSubmit={submit} className="form-stack">
      <p>This administrator action requires a recent second-factor check. No change is made until verification succeeds.</p>
      <FormField label="Authenticator or recovery code" hint="Use a new authenticator code if you just signed in. A recovery code can only be used once.">
        <input autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} maxLength={32} required disabled={busy} />
      </FormField>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="button-row"><Button type="button" variant="secondary" onClick={cancel}>Cancel</Button><Button type="submit" disabled={busy || code.trim().length < 6}>{busy ? "Verifying…" : "Verify and continue"}</Button></div>
      <Link to="/security" onClick={cancel}>Manage two-factor authentication</Link>
    </form>
  </Modal>}</>;
}
