import { useTranslation } from "../i18n/LanguageContext";
import { Link } from "react-router-dom";
import PublicLayout from "../components/PublicLayout";
import { Card } from "../components/ui";

const effectiveDate = "11 September 2026";

function LegalPage({ kind }) {
  const { t } = useTranslation();
  const privacy = kind === "privacy";
  return (
    <PublicLayout>
      <Card className="legal-page">
        <span className="eyebrow">{t("Version 1.0 · effective ")}{t(effectiveDate)}</span>
        <h1>{privacy ? t("Privacy Notice") : t("Terms of Use")}</h1>
        {privacy ? (
          <>
            <p>{t("CoLearnX uses account, profile, purchase, wallet and learning-delivery data to operate the learning marketplace, protect authorised files and maintain financial records.")}</p>
            <h2>{t("Your choices")}</h2><p>{t("You may correct profile data in your account and request an export or deletion review. Financial, security and moderation records may need to be retained where required for platform integrity or law.")}</p>
            <h2>{t("Access and security")}</h2><p>{t("Private course and resource files are available only to authorised owners, reviewers and purchasers through short-lived links. Online-video progress is recorded only where that product explicitly uses progress tracking.")}</p>
          </>
        ) : (
          <>
            <p>{t("By creating an account, you agree to use CoLearnX lawfully and to provide accurate information for purchases, publishing and role applications.")}</p>
            <h2>{t("Purchases and delivery")}</h2><p>{t("Cloud courses are delivered as authorised downloads. Local and Live courses are arranged directly between the Trainer and learner using buyer-only information. The purchase-time refund policy shown at checkout forms part of the order record.")}</p>
            <h2>{t("Marketplace conduct")}</h2><p>{t("Creators and Trainers must have the rights to publish their materials. CoLearnX may review, suspend or remove access where required to protect members or platform records.")}</p>
          </>
        )}
        <Link className="button secondary" to="/register">{t("Return to registration")}</Link>
      </Card>
    </PublicLayout>
  );
}

export const TermsPage = () => {  return (<LegalPage kind="terms" />); };
export const PrivacyPage = () => {  return (<LegalPage kind="privacy" />); };
