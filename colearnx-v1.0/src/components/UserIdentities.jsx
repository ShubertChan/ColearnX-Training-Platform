import { BookOpen, FileText, Layers, ShieldCheck, UserRound } from "lucide-react";
import { useTranslation } from "../i18n/LanguageContext";

const identities = [
  { code: "trainer", label: "Trainer", Icon: BookOpen },
  { code: "creator", label: "Creator", Icon: FileText },
  { code: "member", label: "Member", Icon: UserRound },
  { code: "admin", label: "Admin", Icon: ShieldCheck },
];

export function UserIdentities({ roles = [] }) {
  const { t } = useTranslation();
  const assigned = identities.filter(({ code }) => roles.includes(code));
  return <span className="user-identities" role="group" aria-label={t("Granted identities")}>
    {assigned.map(({ code, label, Icon }) => <span key={code} className={`user-identity ${code}`}>
      <Icon size={14} aria-hidden="true" />{t(label)}
    </span>)}
    {roles.includes("trainer") && roles.includes("creator") && <span className="user-identity dual"><Layers size={14} aria-hidden="true" />{t("Trainer and Creator")}</span>}
    {!assigned.length && <span className="user-identity">{t("No active role")}</span>}
  </span>;
}

export function UserIdentityOverview({ users, selected, onSelect, loading }) {
  const { t } = useTranslation();
  const trainers = users.filter(user => user.roles.includes("trainer")).length;
  const creators = users.filter(user => user.roles.includes("creator")).length;
  const dual = users.filter(user => user.roles.includes("trainer") && user.roles.includes("creator")).length;
  const items = [
    { code: "all", label: "All identities", detail: "Accounts on this page", count: users.length, Icon: UserRound },
    { code: "trainer", label: "Trainer", detail: "Creates and teaches courses", count: trainers, Icon: BookOpen },
    { code: "creator", label: "Creator", detail: "Publishes digital resources", count: creators, Icon: FileText },
    { code: "dual", label: "Trainer and Creator", detail: "Both publishing identities", count: dual, Icon: Layers },
  ];
  return <section className="identity-overview" aria-label={t("User identities")}>
    <div><h3>{t("User identities")}</h3><p>{t("Filter the accounts on this page by their granted roles. A dual-role account appears in both Trainer and Creator counts.")}</p></div>
    <div className="identity-filters" role="group" aria-label={t("Filter identities on this page")}>
      {items.map(({ code, label, detail, count, Icon }) => <button type="button" key={code}
        className={`identity-filter ${code}`} aria-pressed={selected === code} disabled={loading}
        onClick={() => onSelect(code)}>
        <span className="identity-filter-title"><Icon size={18} aria-hidden="true" />{t(label)}<b>{count}</b></span>
        <small>{t(detail)}</small>
      </button>)}
    </div>
  </section>;
}
