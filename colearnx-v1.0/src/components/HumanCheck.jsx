import { useEffect, useRef, useState } from "react";
import { getHumanCheckConfig } from "../api/auth";
import { useTranslation } from "../i18n/LanguageContext";

let loading;
function loadWidget() {
  if (window.turnstile?.render) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => { clearTimeout(timeout); script.remove(); reject(new Error("widget unavailable")); };
    const timeout = setTimeout(fail, 10000);
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => { clearTimeout(timeout); if (window.turnstile?.render) resolve(window.turnstile); else fail(); };
    script.onerror = fail;
    document.head.append(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}

// Associate a proof with both form and attempt. An expired or consumed proof can
// never enable another form, even before React cleans up the previous widget.
export function useHumanCheck(action) {
  const { language } = useTranslation();
  const [generation, setGeneration] = useState(0);
  const [proof, setProof] = useState(null);
  const id = `${action}:${language}:${generation}`;
  const current = proof?.id === id ? proof : null;
  const retry = () => setGeneration(value => value + 1);
  return { action, ready: Boolean(current?.ready), token: current?.token,
    consume: () => { if (current?.token) retry(); },
    widget: <HumanCheck key={id} id={id} action={action} report={setProof} retry={retry} /> };
}

function HumanCheck({ id, action, report, retry }) {
  const { t, language } = useTranslation();
  const [status, setStatus] = useState("loading");
  const container = useRef(null);
  useEffect(() => {
    let live = true, sdk, widget;
    const update = (status, token) => {
      if (!live) return;
      setStatus(status);
      report({ id, ready: status === "off" || Boolean(token), token });
    };
    update("loading");
    (async () => {
      const config = await getHumanCheckConfig();
      if (!live) return;
      if (config?.enabled === false) return update("off");
      if (!config?.siteKey) throw new Error("missing public configuration");
      sdk = await loadWidget();
      if (!live) return;
      update("waiting");
      widget = sdk.render(container.current, { sitekey: config.siteKey, action, language: language.toLowerCase(), size: "flexible",
        retry: "never", "refresh-expired": "manual",
        callback: token => update("verified", token),
        "expired-callback": () => update("expired"),
        "timeout-callback": () => update("expired"),
        "error-callback": () => { update("error"); return true; },
      });
    })().catch(() => update("error"));
    return () => { live = false; if (widget != null) sdk.remove(widget); };
  }, [id, action, language, report]);

  if (status === "off") return null;
  return <div className="human-check">
    <div ref={container} />
    {status === "loading" && <small role="status">{t("Loading human verification…")}</small>}
    {(status === "error" || status === "expired") && <div role="alert">
      {t(status === "expired" ? "Human verification expired." : "Human verification is unavailable. Please try again.")}
      {" "}<button type="button" className="link-button" onClick={retry}>{t("Retry verification")}</button>
    </div>}
  </div>;
}
