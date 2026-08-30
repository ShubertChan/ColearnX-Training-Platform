import { useMemo, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Edit3,
  GraduationCap,
  Library,
  Save,
  ShieldCheck,
  UserCheck,
  WalletCards,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import { Badge, Button, Card, EmptyState, FormField, Metric } from "../components/ui";

export function HomePage() {
  const { balance, applications, profile, orders, role } = usePlatform();
  const navigate = useNavigate();
  const purchases = useMemo(() => orders.reduce((count, order) => count + order.items.filter((item) => item.fulfilmentStatus !== "refunded").length, 0), [orders]);
  const pendingApplications = Object.values(applications).filter((value) => value === "Pending").length;
  const shortcuts = [
    ["Browse courses", "Explore administrator-approved course offerings.", GraduationCap, "/courses"],
    ["Browse resources", "Explore administrator-approved creator content.", Library, "/contents"],
    ["My purchases", "Review server-issued purchase records.", BookOpen, "/purchases"],
    ["Role applications", "Apply to become a trainer or creator.", UserCheck, "/role-application"],
  ];
  return <>
    <section className="hero-banner"><div><span className="eyebrow light">CoLearnX {String(role || "Member").toLowerCase()} workspace</span><h2>Welcome, {profile.name || "member"}.</h2><p>Browse approved learning offers, manage your wallet and review your server-issued records.</p><div className="button-row"><Button onClick={() => navigate("/courses")}>Explore marketplace <ArrowRight size={17} /></Button><Button variant="glass" onClick={() => navigate("/wallet")}>Open wallet</Button></div></div><div className="hero-orbit"><WalletCards size={30} /><strong>{balance}</strong><span>available points</span></div></section>
    <div className="metric-grid three"><Metric label="Points balance" value={balance} detail="Ledger-backed available balance" icon={WalletCards} /><Metric label="Purchased items" value={purchases} detail="From your server-side order history" icon={BookOpen} /><Metric label="Pending role applications" value={pendingApplications} detail="Awaiting administrator review" icon={UserCheck} /></div>
    <div className="section-heading"><div><h2>What would you like to do?</h2></div></div>
    <div className="action-grid">{shortcuts.map(([title, description, Icon, to]) => <button className="action-card" key={to} onClick={() => navigate(to)}><span><Icon size={21} /></span><div><h3>{title}</h3><p>{description}</p></div><ArrowRight size={18} /></button>)}</div>
  </>;
}

export function ProfilePage() {
  const { profile, approvedRoles, saveProfile } = usePlatform();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try { await saveProfile(draft); setEditing(false); } catch (saveError) { setError(saveError.message); } finally { setBusy(false); }
  };
  return <div className="profile-layout">
    <Card className="profile-hero-card"><div className="avatar large">{(profile.name || "M").split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</div><div><div className="badge-row"><Badge tone="success">Active account</Badge></div><h2>{profile.name || "Member"}</h2><p>{profile.bio || "Add a short profile to help others understand your learning interests."}</p><div className="profile-meta">{profile.location && <span>{profile.location}</span>}<span>{profile.email}</span></div></div><Button variant="secondary" onClick={() => { setDraft(profile); setEditing((value) => !value); }}>{editing ? "Cancel editing" : <><Edit3 size={16} /> Edit profile</>}</Button></Card>
    <div className="content-grid profile-columns"><Card><div className="card-heading"><div><span className="eyebrow">Personal information</span><h3>Account details</h3></div></div><div className="form-grid two"><FormField label="Full name"><input disabled={!editing} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></FormField><FormField label="Email address"><input disabled value={draft.email} /></FormField><FormField label="Phone number"><input disabled={!editing} value={draft.phone || ""} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} /></FormField><FormField label="Location"><input disabled={!editing} value={draft.location || ""} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></FormField></div><FormField label="Bio"><textarea disabled={!editing} value={draft.bio || ""} onChange={(event) => setDraft({ ...draft, bio: event.target.value })} /></FormField>{error && <p className="form-error">{error}</p>}{editing && <Button disabled={busy || !draft.name.trim()} onClick={save}><Save size={16} /> {busy ? "Saving…" : "Save changes"}</Button>}</Card>
    <Card><span className="eyebrow">Current roles</span><h3>Server-issued access</h3><div className="role-list">{["Member", "Trainer", "Creator", "Admin"].map((item) => <div key={item}><span><ShieldCheck size={17} /></span><div><b>{item}</b><small>{approvedRoles.includes(item) ? "Granted by CoLearnX" : "Not granted"}</small></div><Badge tone={approvedRoles.includes(item) ? "success" : "neutral"}>{approvedRoles.includes(item) ? "Active" : "Not active"}</Badge></div>)}</div></Card></div>
  </div>;
}

export function PublicProfilePage() {
  return <EmptyState icon={UserCheck} title="Public profiles are not available" description="CoLearnX does not yet expose public creator profiles or subscriptions. This route intentionally has no synthetic profile data." />;
}
