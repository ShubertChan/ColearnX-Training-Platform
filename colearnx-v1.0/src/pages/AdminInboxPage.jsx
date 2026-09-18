import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Mail, MailOpen, ArrowRight, RefreshCw } from "lucide-react";
import { useAdminInbox } from "../context/AdminInboxContext";
import { Badge, Button, Card, EmptyState } from "../components/ui";

const displayDate = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Date unavailable";

export default function AdminInboxPage() {
  const { messages, unreadCount, loading, errors, storageUnavailable, refresh, markRead, markAllRead, dismissArrival } = useAdminInbox();
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const selected = messages.find((message) => message.id === selectedId);
  const visible = messages.filter((message) => filter === "all" || (filter === "unread" ? message.unread : message.status === "pending"));
  useEffect(() => { void refresh(); dismissArrival(); }, []);
  return <div className="stack">
    <Card className="inbox-toolbar-card"><div className="card-heading"><div><span className="eyebrow">Administrator mailbox</span><h2>Application inbox <Badge tone={unreadCount ? "danger" : "neutral"}>{unreadCount} unread</Badge></h2><p>Role applications, Trainer certifications and refund requests in one place. Reading a message does not approve the request.</p></div><div className="button-row"><Button variant="secondary" onClick={markAllRead} disabled={!unreadCount}>Mark all as read</Button><Button variant="secondary" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} />{loading ? "Refreshing…" : "Refresh inbox"}</Button></div></div>
      <div className="button-row" aria-label="Inbox filters">{[["all", "All messages"], ["unread", "Unread"], ["pending", "Awaiting review"]].map(([value, label]) => <Button key={value} variant={filter === value ? "primary" : "secondary"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}</div>
      {errors.length > 0 && <p role="alert" className="form-error">Could not refresh: {errors.join(", ")}. Previously loaded messages are retained. Use Refresh inbox to retry.</p>}
      {storageUnavailable && <p role="status" className="muted">Read status is available in this tab only because browser storage is unavailable.</p>}
    </Card>
    <div className="admin-inbox-layout"><Card className="inbox-list-card">
      {visible.length ? <div className="inbox-list">{visible.map((message) => <button key={message.id} type="button" className={`inbox-message ${message.unread ? "unread" : ""} ${selectedId === message.id ? "selected" : ""}`} aria-pressed={selectedId === message.id} onClick={() => { setSelectedId(message.id); markRead([message.id]); }}>
        {message.unread ? <Mail size={22} /> : <MailOpen size={22} />}<span><b>{message.title}</b><small>{message.sender}</small><time>{displayDate(message.submittedAt)}</time></span><span className="inbox-message-status">{message.unread && <Badge tone="danger">Unread</Badge>}<Badge tone={message.status === "pending" ? "warning" : "neutral"}>{message.status}</Badge></span>
      </button>)}</div> : <EmptyState icon={MailOpen} title={loading ? "Loading messages…" : errors.length ? "Mailbox temporarily unavailable" : "No messages"} description={errors.length ? "Retry to load the missing queues." : filter === "unread" ? "You have read all available messages." : "New requests will appear here after submission."} />}
    </Card><Card className="inbox-detail">
      {selected ? <><div className="card-heading"><div><span className="eyebrow">{selected.sender}</span><h3>{selected.title}</h3><small>{displayDate(selected.submittedAt)}</small></div><Badge tone={selected.status === "pending" ? "warning" : "neutral"}>{selected.status}</Badge></div><p className="inbox-summary">{typeof selected.summary === "string" && selected.summary.trim() ? selected.summary : "Open the review page to inspect the submitted details."}</p><Link className="button primary" to={selected.href}>Open request <ArrowRight size={16} /></Link><p className="muted">Review the evidence and record your decision on the review page.</p></> : <EmptyState icon={Mail} title="Select a message" description="Open an envelope to read the application and continue to its review." />}
    </Card></div>
  </div>;
}
