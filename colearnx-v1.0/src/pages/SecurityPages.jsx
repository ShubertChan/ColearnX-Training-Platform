import { useCallback, useEffect, useState } from "react";
import { Copy, LaptopMinimal, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { Button, FormField } from "../components/ui";
import {
  confirmMfaEnrolment, disableMfa, getMfaStatus, listSessions,
  revokeOtherSessions, revokeSession, rotateRecoveryCodes, startMfaEnrolment,
} from "../api/auth";

/**
 * Recovery codes are shown exactly once, at the moment they are issued, and
 * are never retrievable afterwards. Holding a readable copy on the server
 * would turn them into a second standing credential that a session compromise
 * could simply read — which defeats the point of an out-of-band escape hatch.
 * The panel says so plainly, because a user who assumes they can come back for
 * them later is a user who will be locked out.
 */
function RecoveryCodePanel({ codes, onDone }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="security-panel highlight">
      <h3>Save your recovery codes</h3>
      <p>
        Each code works once. Store them somewhere you can reach without your
        phone — a password manager or paper. <strong>They will not be shown
        again.</strong>
      </p>
      <ul className="recovery-codes">
        {codes.map((code) => <li key={code}><code>{code}</code></li>)}
      </ul>
      <div className="security-actions">
        <Button type="button" onClick={copy}><Copy size={16} />{copied ? "Copied" : "Copy all"}</Button>
        <Button type="button" onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

function MfaSection({ status, onChanged }) {
  const [enrolment, setEnrolment] = useState(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (action) => {
    setBusy(true); setError("");
    try { await action(); } catch (actionError) { setError(actionError.message); } finally { setBusy(false); }
  };

  if (codes) return <RecoveryCodePanel codes={codes} onDone={() => { setCodes(null); onChanged(); }} />;

  if (enrolment) {
    return (
      <div className="security-panel">
        <h3>Finish setting up two-factor authentication</h3>
        <p>Add this account to your authenticator app, then enter the code it shows to confirm it works.</p>
        <p className="security-hint">
          Most apps can add the account from this link. If yours cannot, enter
          the key below manually.
        </p>
        <p><a href={enrolment.otpauthUri}>Open in authenticator app</a></p>
        <FormField label="Setup key">
          <input readOnly value={enrolment.secret} onFocus={(event) => event.target.select()} />
        </FormField>
        <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
          const result = await confirmMfaEnrolment({ code });
          setEnrolment(null); setCode(""); setCodes(result.recoveryCodes);
        }); }}>
          <FormField label="Code from your app">
            <input required autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="123456" />
          </FormField>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="security-actions">
            <Button type="submit" disabled={busy}>{busy ? "Confirming…" : "Confirm and enable"}</Button>
            <Button type="button" onClick={() => { setEnrolment(null); setError(""); }}>Cancel</Button>
          </div>
        </form>
      </div>
    );
  }

  if (!status.enrolled) {
    return (
      <div className="security-panel">
        <h3><ShieldOff size={18} /> Two-factor authentication is off</h3>
        <p>
          With it on, your password alone is not enough to sign in. Administrator
          accounts are required to enable it.
        </p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <Button type="button" disabled={busy} onClick={() => void run(async () => setEnrolment(await startMfaEnrolment()))}>
          {busy ? "Preparing…" : "Turn on two-factor authentication"}
        </Button>
      </div>
    );
  }

  return (
    <div className="security-panel">
      <h3><ShieldCheck size={18} /> Two-factor authentication is on</h3>
      <p>
        {status.recoveryCodesRemaining} recovery code{status.recoveryCodesRemaining === 1 ? "" : "s"} remaining.
        {status.recoveryCodesRemaining <= 2 && " Generate a new set soon — running out means a lost phone locks you out."}
      </p>
      {/* Both actions require a current code. A stolen session must not be able
          to remove the protection or mint itself a fresh set of codes. */}
      <form onSubmit={(event) => { event.preventDefault(); }}>
        <FormField label="Current code or recovery code">
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="123456 or a recovery code" />
        </FormField>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="security-actions">
          <Button type="button" disabled={busy || !code} onClick={() => void run(async () => {
            const result = await rotateRecoveryCodes({ code });
            setCode(""); setCodes(result.recoveryCodes);
          })}>New recovery codes</Button>
          <Button type="button" disabled={busy || !code} onClick={() => void run(async () => {
            await disableMfa({ code }); setCode(""); onChanged();
          })}>Turn off</Button>
        </div>
      </form>
    </div>
  );
}

function SessionSection() {
  const [sessions, setSessions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try { setSessions((await listSessions()).sessions); } catch (loadError) { setError(loadError.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (action) => {
    setBusy(true); setError("");
    try { await action(); await load(); } catch (actionError) { setError(actionError.message); } finally { setBusy(false); }
  };

  if (!sessions) return <div className="security-panel"><h3>Active sessions</h3>{error ? <><p className="form-error" role="alert">{error}</p><Button onClick={load}>Retry sessions</Button></> : <p role="status">Loading…</p>}</div>;

  return (
    <div className="security-panel">
      <h3>Active sessions</h3>
      <p>
        Every browser currently signed in to this account. If you see one you do
        not recognise, end it and then change your password.
      </p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <ul className="session-list">
        {sessions.map((session) => (
          <li key={session.id}>
            <LaptopMinimal size={18} />
            <div>
              <strong>{session.device}{session.current && " · this browser"}</strong>
              <span>
                Started {new Date(session.createdAt).toLocaleString()}
                {session.lastUsedAt && ` · last active ${new Date(session.lastUsedAt).toLocaleString()}`}
              </span>
            </div>
            {/* The current session has no end button: signing yourself out from
                here would drop you on a sign-in page mid-investigation and give
                an attacker a chance to race you back in. Use sign out for that. */}
            {!session.current && (
              <button type="button" className="link-button" disabled={busy}
                onClick={() => void run(() => revokeSession(session.id))}>
                <Trash2 size={15} /> End
              </button>
            )}
          </li>
        ))}
      </ul>
      {sessions.length > 1 && (
        <Button type="button" disabled={busy} onClick={() => void run(revokeOtherSessions)}>
          End all other sessions
        </Button>
      )}
    </div>
  );
}

export function SecuritySettingsPage() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { setStatus(await getMfaStatus()); } catch (failure) { setError(failure.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page-shell">
      <header className="page-header">
        <span className="eyebrow">Account</span>
        <h1>Security</h1>
        <p>Two-factor authentication and the devices signed in to your account.</p>
      </header>
      {error && <div className="security-panel"><p className="form-error" role="alert">{error}</p><Button onClick={load}>Retry security settings</Button></div>}
      {status ? <MfaSection status={status} onChanged={load} /> : !error && <div className="security-panel"><p role="status">Loading…</p></div>}
      <SessionSection />
    </div>
  );
}
