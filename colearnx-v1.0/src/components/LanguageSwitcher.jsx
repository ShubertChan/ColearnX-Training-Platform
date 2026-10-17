import { Globe2 } from "lucide-react";
import { useTranslation } from "../i18n/LanguageContext";
import { languages } from "../i18n/locale";

export default function LanguageSwitcher({ className = "" }) {
  const { language, setLanguage, t } = useTranslation();
  return (
    <label className={`language-switcher ${className}`}>
      <Globe2 size={17} aria-hidden="true" />
      <span className="language-label">{t("Language")}</span>
      <select aria-label={t("Language")} value={language} onChange={(event) => setLanguage(event.target.value)}>
        {languages.map((entry) => <option key={entry.value} value={entry.value} lang={entry.lang}>{entry.label}</option>)}
      </select>
    </label>
  );
}
