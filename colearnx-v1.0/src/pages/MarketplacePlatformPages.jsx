import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  FileArchive,
  GraduationCap,
  ShoppingCart,
  WalletCards,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import { Badge, Button, Card, EmptyState } from "../components/ui";

const deliveryLabel = (modes = []) =>
  modes.map((mode) => `${mode[0].toUpperCase()}${mode.slice(1)}`).join(" + ") || "Not specified";

function CourseCard({ course }) {
  return (
    <article className="market-card">
      <div className="market-card-mark"><GraduationCap size={27} /></div>
      <div>
        <div className="badge-row"><Badge>{course.category}</Badge><Badge tone="info">{deliveryLabel(course.deliveryModes)}</Badge></div>
        <Link to={`/courses/${course.id}`}><h3>{course.title}</h3></Link>
        <p>{course.description}</p>
        <div className="market-card-footer">
          <span>{course.trainer}</span>
          <b>{course.purchased ? "Purchased" : `${course.price} points`}</b>
          <Link className="button secondary sm" to={`/courses/${course.id}`}>View <ArrowRight size={15} /></Link>
        </div>
      </div>
    </article>
  );
}

export function CourseMarketplacePage() {
  const { courses } = usePlatform();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => courses.filter((course) =>
    `${course.title} ${course.description} ${course.trainer} ${course.category}`.toLowerCase().includes(query.toLowerCase()),
  ), [courses, query]);
  return (
    <>
      <Card className="market-toolbar">
        <div className="search-field"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search published courses" /></div>
      </Card>
      <div className="result-bar"><span><b>{filtered.length}</b> published courses</span><small>Prices and availability are verified again by the server at checkout.</small></div>
      {filtered.length ? <div className="market-grid">{filtered.map((course) => <CourseCard key={course.id} course={course} />)}</div> : <EmptyState icon={GraduationCap} title="No published courses" description="Published courses will appear here when an administrator approves a trainer submission." />}
    </>
  );
}

export function CourseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { courses, cart, addToCart } = usePlatform();
  const course = courses.find((item) => item.id === id);
  if (!course) return <EmptyState icon={GraduationCap} title="Course not found" description="This course is unavailable or has not been published." />;
  const inCart = cart.includes(course.id);
  return (
    <>
      <button className="back-link" onClick={() => navigate(-1)}><ArrowLeft size={16} /> Back to marketplace</button>
      <Card className="detail-hero">
        <div className="detail-mark"><GraduationCap size={38} /></div>
        <div>
          <div className="badge-row"><Badge>{course.category}</Badge><Badge tone="info">{deliveryLabel(course.deliveryModes)}</Badge></div>
          <h2>{course.title}</h2><p>{course.description}</p>
          <div className="profile-meta"><span>{course.trainer}</span>{course.startsAt && <span>Starts {new Date(course.startsAt).toLocaleString()}</span>}</div>
        </div>
        <aside className="purchase-box">
          <span className="eyebrow">Course price</span><strong>{course.price} <small>points</small></strong>
          {course.purchased ? (
            <>
              <Badge tone="success"><Check size={13} /> Purchased</Badge>
              <p>Purchase and refund records are available in your account. Secure delivery is enabled only after the storage/player integration is configured.</p>
              <Link className="button secondary wide" to={`/refund/${course.id}`}>Request refund</Link>
            </>
          ) : (
            <>
              <p>The final price, capacity and eligibility are checked by the server when you pay.</p>
              <Button className="wide" disabled={inCart || !course.purchaseEnabled} onClick={() => addToCart(course.id)}><ShoppingCart size={16} /> {inCart ? "Already in cart" : "Add to cart"}</Button>
            </>
          )}
        </aside>
      </Card>
      <div className="content-grid two">
        <Card><span className="eyebrow">Delivery</span><h3>{deliveryLabel(course.deliveryModes)}</h3><p>Delivery access and refund eligibility are determined from the server-side order snapshot after purchase.</p></Card>
        <Card><span className="eyebrow">Availability</span><h3>{course.capacity ? `${course.capacity} seats` : "No fixed capacity"}</h3><p>Availability is rechecked in the checkout transaction to prevent overselling.</p></Card>
      </div>
    </>
  );
}

function ContentCard({ content }) {
  return (
    <article className="content-card">
      <div className="content-type"><FileArchive size={26} /><span>{content.type}</span></div>
      <div>
        <div className="badge-row"><Badge>{content.category}</Badge></div>
        <Link to={`/contents/${content.id}`}><h3>{content.title}</h3></Link>
        <p>{content.description}</p>
        <div className="market-card-footer"><span>{content.creator}</span><b>{content.purchased ? "Purchased" : `${content.price} points`}</b><Link className="button secondary sm" to={`/contents/${content.id}`}>View <ArrowRight size={15} /></Link></div>
      </div>
    </article>
  );
}

export function ContentMarketplacePage() {
  const { contents } = usePlatform();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => contents.filter((content) => `${content.title} ${content.creator} ${content.category} ${content.type}`.toLowerCase().includes(query.toLowerCase())), [contents, query]);
  return (
    <>
      <Card className="market-toolbar"><div className="search-field"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search published resources" /></div></Card>
      <div className="result-bar"><span><b>{filtered.length}</b> published resources</span><small>Content access is granted only by a completed server-side order.</small></div>
      {filtered.length ? <div className="content-market-grid">{filtered.map((content) => <ContentCard key={content.id} content={content} />)}</div> : <EmptyState icon={FileArchive} title="No published resources" description="Approved creator content will appear here." />}
    </>
  );
}

export function ContentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { contents, balance, buyContent } = usePlatform();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const item = contents.find((content) => content.id === id);
  if (!item) return <EmptyState icon={FileArchive} title="Content not found" description="This resource is unavailable or has not been published." />;
  const purchase = async () => {
    setBusy(true); setError("");
    try { await buyContent(item.id); } catch (purchaseError) { setError(purchaseError.message); } finally { setBusy(false); }
  };
  return (
    <>
      <button className="back-link" onClick={() => navigate(-1)}><ArrowLeft size={16} /> Back to marketplace</button>
      <Card className="content-detail-hero">
        <div className="content-detail-mark"><FileArchive size={36} /><span>{item.type}</span></div>
        <div><div className="badge-row"><Badge>{item.category}</Badge>{item.purchased && <Badge tone="success"><Check size={13} /> Purchased</Badge>}</div><h2>{item.title}</h2><p>{item.description}</p><span>{item.creator}</span></div>
      </Card>
      <div className="content-grid detail-columns">
        <Card><span className="eyebrow">Access</span><h3>Order-controlled access</h3><p>The storage adapter is not configured yet, so this page does not expose a false download or preview link.</p></Card>
        <Card className="purchase-summary">
          <span className="eyebrow">Purchase summary</span>
          <div className="summary-row"><span>Price</span><b>{item.price} points</b></div>
          <div className="summary-row"><span>Available balance</span><b>{balance} points</b></div>
          {error && <p className="form-error">{error}</p>}
          {item.purchased ? <Link className="button secondary wide" to="/orders">View order history</Link> : <Button className="wide" disabled={busy || balance < item.price} onClick={purchase}><WalletCards size={16} /> {busy ? "Processing…" : "Purchase with points"}</Button>}
        </Card>
      </div>
    </>
  );
}
