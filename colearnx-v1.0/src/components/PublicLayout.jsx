import { useTranslation } from "../i18n/LanguageContext";
import { Link, NavLink } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import LanguageSwitcher from "./LanguageSwitcher";
import nextLogo from "../../assets/next-logo.jpg";
import { useRef } from "react";

export default function PublicLayout({ children }) {
  const { t } = useTranslation();
  const { authenticated, role } = usePlatform();
  const mainRef = useRef(null);
  return (
    <div className="public-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>{t("Skip to main content")}</a>
      <header className="public-header">
        <Link className="public-brand" to="/courses">
          <img src={nextLogo} alt="neXt" />
          <span><b>CoLearnX</b><small>{t("Learning marketplace")}</small></span>
        </Link>
        <nav aria-label={t("Public navigation")}>
          <NavLink to="/courses">{t("Courses")}</NavLink>
          <NavLink to="/contents">{t("Resources")}</NavLink>
        </nav>
        <div className="public-auth-actions">
          <LanguageSwitcher />
          {authenticated ? (
            <Link className="button primary sm" to={role === "Admin" ? "/admin" : "/home"}>{t("Open workspace")}</Link>
          ) : (
            <><Link className="button secondary sm" to="/login">{t("Sign in")}</Link><Link className="button primary sm" to="/register">{t("Create account")}</Link></>
          )}
        </div>
      </header>
      <main ref={mainRef} tabIndex={-1} className="public-main" id="main-content">{children}</main>
      <footer className="public-footer">
        <span>CoLearnX</span>
        <nav aria-label={t("Legal")}><Link to="/terms">{t("Terms")}</Link><Link to="/privacy">{t("Privacy Notice")}</Link></nav>
      </footer>
    </div>
  );
}
