import zhCN from "./zh-CN.json";

export const LANGUAGE_STORAGE_KEY = "colearnx.language";
export const languages = [
  { value: "en", label: "English", lang: "en" },
  { value: "zh-CN", label: "简体中文", lang: "zh-CN" },
];
export const isSupportedLanguage = (value) => languages.some((entry) => entry.value === value);

export function readLanguage(storage) {
  try {
    const value = (storage ?? window.localStorage).getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLanguage(value) ? value : "en";
  } catch { return "en"; }
}

// English source phrases are stable keys. Missing translations fall back to English.
// Interpolation uses named placeholders and never treats values as HTML or code.
export function translateText(text, language = "en", values = {}) {
  if (text && typeof text === "object" && typeof text.key === "string") return translateText(text.key, language, text.values);
  if (typeof text !== "string") return text;
  const phrase = text.trim();
  if (!phrase) return text;
  const translated = language === "zh-CN" && Object.hasOwn(zhCN, phrase) ? zhCN[phrase] : phrase;
  const result = text.slice(0, text.length - text.trimStart().length) + translated + text.slice(text.trimEnd().length);
  return result.replace(/\{([\w]+)\}/g, (match, name) => {
    if (!Object.hasOwn(values, name)) return match;
    const value = values[name];
    // Only explicit descriptors are translated. Names, titles and other string
    // values stay verbatim even when they happen to match a catalogue key.
    return value && typeof value === "object" && typeof value.key === "string"
      ? translateText(value, language)
      : String(value);
  });
}
