import { useTranslation } from "../i18n/LanguageContext";

export function DownloadTrackingDate({ since }) {
  const { t, formatLocale } = useTranslation();
  if (!since || !Number.isFinite(Date.parse(since))) return null;
  const date = new Date(since).toLocaleDateString(formatLocale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return <small className="download-tracking-date">{t("File downloads tracked since {date} (UTC).", { date })}</small>;
}

export default function ListingActivity({ activity, explain = false }) {
  const { t, formatLocale } = useTranslation();
  const number = (value, unit) => {
    if (!Number.isSafeInteger(value) || value < 0) return "—";
    const count = value.toLocaleString(formatLocale);
    return formatLocale === "zh-CN" ? t(unit, { count }) : count;
  };
  return (
    <div className="listing-activity">
      <dl aria-label={t("Listing activity")}>
        <div><dt>{t("Sales")}</dt><dd>{number(activity?.sales, "{count} orders")}</dd></div>
        <div><dt title={t("Orders claiming downloads")}>{explain ? t("Orders claiming downloads") : t("Orders with a link")}</dt><dd>{number(activity?.claimedOrders ?? activity?.downloads, "{count} orders")}</dd></div>
        <div><dt>{t("File downloads")}</dt><dd>{number(activity?.fileDownloads, "{count} times")}</dd></div>
      </dl>
      <DownloadTrackingDate since={activity?.fileDownloadsSince} />
      {explain && <p>{t("Sales include free orders. Each eligible order item that receives a file link counts once as a claim. Refunds and cancellations are excluded from both figures. Every complete buyer file transfer counts as one download, including repeat downloads.")}</p>}
    </div>
  );
}
