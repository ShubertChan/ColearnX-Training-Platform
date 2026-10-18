import { usePlatform } from "../context/PlatformContext";
import { useTranslation } from "../i18n/LanguageContext";

export default function SessionConnectionNotice() {
  const { accountLoading, accountError, retrySession } = usePlatform();
  const { t } = useTranslation();
  if (!accountLoading && !accountError) return null;
  return <div className="session-connection-notice" role="status" aria-live="polite">
    {accountLoading
      ? <><span className="session-spinner" aria-hidden="true" /><span>{t("Connecting securely. You can enter your details while we check your session.")}</span></>
      : <><span>{t("The connection is taking longer than expected. Your details stay on this page; you do not need to refresh it.")}</span><button type="button" className="button secondary sm" onClick={() => void retrySession()}>{t("Retry connection")}</button></>}
  </div>;
}
