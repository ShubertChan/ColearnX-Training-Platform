import { Link } from "react-router-dom";
import PublicLayout from "../components/PublicLayout";
import { Card } from "../components/ui";

const effectiveDate = "11 September 2026";

function LegalPage({ kind }) {
  const privacy = kind === "privacy";
  return (
    <PublicLayout>
      <Card className="legal-page">
        <span className="eyebrow">Version 1.0 · effective {effectiveDate}</span>
        <h1>{privacy ? "Privacy Notice" : "Terms of Use"}</h1>
        {privacy ? (
          <>
            <p>CoLearnX uses account, profile, purchase, wallet and learning-delivery data to operate the learning marketplace, protect authorised files and maintain financial records.</p>
            <h2>Your choices</h2><p>You may correct profile data in your account and request an export or deletion review. Financial, security and moderation records may need to be retained where required for platform integrity or law.</p>
            <h2>Access and security</h2><p>Private course and resource files are available only to authorised owners, reviewers and purchasers through short-lived links. Online-video progress is recorded only where that product explicitly uses progress tracking.</p>
          </>
        ) : (
          <>
            <p>By creating an account, you agree to use CoLearnX lawfully and to provide accurate information for purchases, publishing and role applications.</p>
            <h2>Purchases and delivery</h2><p>Cloud courses are delivered as authorised downloads. Local and Live courses are arranged directly between the Trainer and learner using buyer-only information. The purchase-time refund policy shown at checkout forms part of the order record.</p>
            <h2>Marketplace conduct</h2><p>Creators and Trainers must have the rights to publish their materials. CoLearnX may review, suspend or remove access where required to protect members or platform records.</p>
          </>
        )}
        <Link className="button secondary" to="/register">Return to registration</Link>
      </Card>
    </PublicLayout>
  );
}

export const TermsPage = () => <LegalPage kind="terms" />;
export const PrivacyPage = () => <LegalPage kind="privacy" />;
