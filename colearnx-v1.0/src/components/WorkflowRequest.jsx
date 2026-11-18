import { useCallback, useEffect, useRef, useState } from "react";
import { serviceMessage } from "../api/workflows";
import { useTranslation } from "../i18n/LanguageContext";
import { Button } from "./ui";

export function useRequest(loader) {
  const revision = useRef(0);
  const [state, setState] = useState({ data: null, status: "loading", error: "" });
  const reload = useCallback(async () => {
    const request = ++revision.current; setState({ data: null, status: "loading", error: "" });
    try { const data = await loader(); if (request === revision.current) setState({ data, status: "ready", error: "" }); }
    catch (error) { if (request === revision.current) setState({ data: null, status: "error", error: serviceMessage(error) }); }
  }, [loader]);
  useEffect(() => { void reload(); return () => { revision.current++; }; }, [reload]);
  return [state, reload];
}
export function RequestState({ state, reload, children }) {
  const { t } = useTranslation();
  if (state.status === "loading") return <p role="status">{t("Loading records…")}</p>;
  if (state.status === "error") return <div className="catalog-error"><p role="alert">{t(state.error)}</p><Button variant="secondary" onClick={() => void reload()}>{t("Retry records")}</Button></div>;
  return children;
}
