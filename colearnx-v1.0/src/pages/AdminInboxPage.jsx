import { getFormatLocale, useTranslation } from "../i18n/LanguageContext";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Mail, MailOpen, ArrowRight, RefreshCw } from "lucide-react";
import { useAdminInbox } from "../context/AdminInboxContext";
import { Badge, Button, Card, EmptyState } from "../components/ui";

const displayDate = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(getFormatLocale()) : "Date unavailable";

export default function AdminInboxPage() {
  const { t } = useTranslation();
  const { messages, unreadCount, loading, errors, storageUnavailable, refresh, markRead, markAllRead, dismissArrival } = useAdminInbox();
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const selected = messages.find((message) => message.id === selectedId);
  const visible = messages.filter((message) => filter === "all" || (filter === "unread" ? message.unread : message.status === "pending"));
  useEffect(() => { void refresh(); dismissArrival(); }, []);
  return <div className="stack">
    <Card className="inbox-toolbar-card"><div className="card-heading"><div><span className="eyebrow">{t("Administrator mailbox")}</span><h2>{t("Application inbox ")}<Badge tone={unreadCount ? "danger" : "neutral"}>{unreadCount}{t(" unread")}</Badge></h2><p>{t("Role applications, Trainer certifications and refund requests in one place. Reading a message does not approve the request.")}</p></div><div className="button-row"><Button variant="secondary" onClick={markAllRead} disabled={!unreadCount}>{t("Mark all as read")}</Button><Button variant="secondary" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} />{loading ? t("Refreshing…") : t("Refresh inbox")}</Button></div></div>
      <div className="button-row" aria-label={t("Inbox filters")}>{[["all", "All messages"], ["unread", "Unread"], ["pending", "Awaiting review"]].map(([value, label]) => <Button key={value} variant={filter === value ? "primary" : "secondary"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(label)}</Button>)}</div>
      {errors.length > 0 && <p role="alert" className="form-error">{t("Could not refresh: ")}{errors.join(", ")}{t(". Previously loaded messages are retained. Use Refresh inbox to retry.")}</p>}
      {storageUnavailable && <p role="status" className="muted">{t("Read status is available in this tab only because browser storage is unavailable.")}</p>}
    </Card>
    <div className="admin-inbox-layout"><Card className="inbox-list-card">
      {visible.length ? <div className="inbox-list">{visible.map((message) => <button key={message.id} type="button" className={`inbox-message ${message.unread ? "unread" : ""} ${selectedId === message.id ? "selected" : ""}`} aria-pressed={selectedId === message.id} onClick={() => { setSelectedId(message.id); markRead([message.id]); }}>
        {message.unread ? <Mail size={22} /> : <MailOpen size={22} />}<span><b>{message.title}</b><small>{message.sender}</small><time>{displayDate(message.submittedAt)}</time></span><span className="inbox-message-status">{message.unread && <Badge tone="danger">{t("Unread")}</Badge>}<Badge tone={message.status === "pending" ? "warning" : "neutral"}>{t(message.status)}</Badge></span>
      </button>)}</div> : <EmptyState icon={MailOpen} title={loading ? t("Loading messages…") : errors.length ? t("Mailbox temporarily unavailable") : t("No messages")} description={errors.length ? t("Retry to load the missing queues.") : filter === "unread" ? t("You have read all available messages.") : t("New requests will appear here after submission.")} />}
    </Card><Card className="inbox-detail">
      {selected ? <><div className="card-heading"><div><span className="eyebrow">{selected.sender}</span><h3>{selected.title}</h3><small>{displayDate(selected.submittedAt)}</small></div><Badge tone={selected.status === "pending" ? "warning" : "neutral"}>{t(selected.status)}</Badge></div><p className="inbox-summary">{typeof selected.summary === "string" && selected.summary.trim() ? selected.summary : t("Open the review page to inspect the submitted details.")}</p><Link className="button primary" to={selected.href}>{t("Open request ")}<ArrowRight size={16} /></Link><p className="muted">{t("Review the evidence and record your decision on the review page.")}</p></> : <EmptyState icon={Mail} title={t("Select a message")} description={t("Open an envelope to read the application and continue to its review.")} />}
    </Card></div>
  </div>;
}
