import { useCallback, useEffect, useSyncExternalStore } from "react";
import { isSupportedLanguage, LANGUAGE_STORAGE_KEY, readLanguage, translateText } from "./locale";

let language = readLanguage();
const listeners = new Set();
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => language;

function applyLanguage(next) {
  language = next;
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
    document.title = translateText("CoLearnX Learning Platform", next);
  }
  for (const listener of listeners) listener();
}

export function setLanguage(next) {
  if (!isSupportedLanguage(next)) return;
  // The in-memory preference still works when storage is blocked or full.
  try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Optional persistence. */ }
  applyLanguage(next);
}

export const translate = (text, values) => translateText(text, language, values);
export const getFormatLocale = () => language === "zh-CN" ? "zh-CN" : "en-SG";

export function useTranslation() {
  const current = useSyncExternalStore(subscribe, snapshot, () => "en");
  const t = useCallback((text, values) => translateText(text, current, values), [current]);
  return { language: current, setLanguage, t, formatLocale: current === "zh-CN" ? "zh-CN" : "en-SG" };
}

export function LanguageEffects() {
  useEffect(() => {
    applyLanguage(language);
    const onStorage = (event) => {
      if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return;
      try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
      applyLanguage(isSupportedLanguage(event.newValue) ? event.newValue : "en");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return null;
}
