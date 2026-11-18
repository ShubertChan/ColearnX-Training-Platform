import { useTranslation } from "../i18n/LanguageContext";

export default function ListingActivity({ activity, explain = false }) {
  const { t, formatLocale } = useTranslation();
  const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString(formatLocale) : "—";
  return (
    <div className="listing-activity">
      <dl aria-label={t("Listing activity")}>
        <div><dt>{t("Sales")}</dt><dd>{number(activity?.sales)}</dd></div>
        <div><dt>{t("Downloads")}</dt><dd>{number(activity?.downloads)}</dd></div>
      </dl>
      {explain && <p>{t("Sales include free orders and exclude refunds and cancellations. Downloads count once per order item, on the first resource link issued or recorded course-file download. Both totals are lifetime figures for this listing.")}</p>}
    </div>
  );
}
