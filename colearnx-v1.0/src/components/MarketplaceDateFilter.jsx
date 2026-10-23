import DateInput from "./DateInput";
import { useTranslation } from "../i18n/LanguageContext";

export default function MarketplaceDateFilter({ value, onChange }) {
  const { t } = useTranslation();
  return <DateInput aria-label={t("Starts on or after")} type="date" value={value} onChange={(event) => onChange(event.target.value)} />;
}
