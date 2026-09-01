import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Download,
  FileArchive,
  GraduationCap,
  ReceiptText,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import { requestContentDownloadUrl } from "../api/uploads";
import { Badge, Button, Card, EmptyState, FormField } from "../components/ui";

const deliveryLabel = (modes = []) =>
  modes.map((mode) => `${mode[0].toUpperCase()}${mode.slice(1)}`).join(" + ") || "Not specified";

export function CartPage() {
  const { cart, courses, balance, removeFromCart, checkout } = usePlatform();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(cart);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = courses.filter((course) => cart.includes(course.id) && !course.purchased);
  useEffect(() => setSelected((current) => current.filter((id) => cart.includes(id))), [cart]);
  const total = items.filter((course) => selected.includes(course.id)).reduce((sum, course) => sum + course.price, 0);
  const pay = async () => {
    setBusy(true); setError("");
    try {
      const order = await checkout(selected);
      if (order) navigate(`/checkout-success/${order.id}`);
    } catch (checkoutError) {
      setError(checkoutError.message);
    } finally {
      setBusy(false);
    }
  };
  if (!items.length) return <EmptyState icon={ShoppingCart} title="Your cart is empty" description="Add a published course to compare or purchase it." action={<Link className="button primary" to="/courses">Browse courses</Link>} />;
  return (
    <div className="content-grid cart-layout">
      <Card className="cart-list">
        <div className="card-heading"><div><span className="eyebrow">Selected courses</span><h3>{items.length} items in cart</h3></div></div>
        {items.map((course) => (
          <div className="cart-row" key={course.id}>
            <input type="checkbox" checked={selected.includes(course.id)} onChange={() => setSelected((current) => current.includes(course.id) ? current.filter((id) => id !== course.id) : [...current, course.id])} />
            <span className="cart-thumb"><GraduationCap size={17} /></span>
            <div><b>{course.title}</b><small>{course.trainer} · {deliveryLabel(course.deliveryModes)}</small><span className="cart-policy">The server validates availability, capacity and payment eligibility.</span></div>
            <strong>{course.price} pts</strong>
            <button className="icon-button danger" onClick={() => removeFromCart(course.id)} aria-label={`Remove ${course.title}`}><Trash2 size={16} /></button>
          </div>
        ))}
      </Card>
      <Card className="order-summary">
        <span className="eyebrow">Checkout summary</span><h3>Points payment</h3>
        <div className="summary-row"><span>Selected courses</span><b>{selected.length}</b></div>
        <div className="summary-row"><span>Total</span><b>{total} points</b></div>
        <div className="summary-row"><span>Available balance</span><b>{balance} points</b></div>
        {balance < total && <p className="form-error">Your available balance is insufficient. Add points before checkout.</p>}
        {error && <p className="form-error">{error}</p>}
        <Button className="wide" disabled={busy || !selected.length || balance < total} onClick={pay}>{busy ? "Processing…" : "Confirm server-side checkout"} <ArrowRight size={16} /></Button>
      </Card>
    </div>
  );
}

export function CheckoutSuccessPage() {
  const { orderId } = useParams();
  const { lastOrder, orders } = usePlatform();
  const order = orderId ? orders.find((item) => item.id === orderId) : lastOrder;
  if (!order) return <EmptyState icon={ReceiptText} title="Order not found" description="Refresh your order history after a completed checkout." action={<Link className="button primary" to="/orders">View order history</Link>} />;
  return (
    <Card className="order-receipt">
      <section><CheckCircle2 size={38} /><span className="eyebrow">Checkout recorded</span><h2>Thank you for your purchase</h2><p>Order {order.orderNo}. The points ledger and access records were created by the server.</p></section>
      <section><div className="summary-row"><span>Status</span><Badge tone="success">{order.status}</Badge></div><div className="summary-row"><span>Total</span><b>{order.total} points</b></div><div className="summary-row"><span>Paid at</span><b>{order.paidAt ? new Date(order.paidAt).toLocaleString() : "—"}</b></div></section>
      <section><h3>Purchased items</h3>{order.items.map((item) => <div className="summary-row" key={item.id}><span>{item.title}</span><b>{item.price} points</b></div>)}</section>
      <div className="button-row"><Link className="button secondary" to="/purchases">My learning</Link><Link className="button primary" to="/orders">Order history</Link></div>
    </Card>
  );
}

export function OrderHistoryPage() {
  const { orders, refreshOrders } = usePlatform();
  const [loading, setLoading] = useState(false);
  const refresh = async () => { setLoading(true); try { await refreshOrders(); } finally { setLoading(false); } };
  if (!orders.length) return <EmptyState icon={ReceiptText} title="No orders yet" description="Completed course and content purchases are recorded here." action={<Button onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh orders"}</Button>} />;
  return <Card><div className="card-heading"><div><span className="eyebrow">Order history</span><h2>Server-issued receipts</h2></div><Button variant="secondary" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button></div><div className="responsive-table"><table><thead><tr><th>Order</th><th>Items</th><th>Total</th><th>Status</th><th /></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><b>{order.orderNo}</b><span className="table-subtitle">{order.paidAt ? new Date(order.paidAt).toLocaleString() : "—"}</span></td><td>{order.items.length}</td><td>{order.total} points</td><td><Badge tone="success">{order.status}</Badge></td><td><Link className="button secondary sm" to={`/checkout-success/${order.id}`}>View</Link></td></tr>)}</tbody></table></div></Card>;
}

function ContentDownloadButton({ contentVersionId }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestDownload = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await requestContentDownloadUrl(contentVersionId);
      const link = document.createElement("a");
      link.href = result.downloadUrl;
      link.download = result.filename || "colearnx-content";
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (result.demoObjectUrl) window.setTimeout(() => URL.revokeObjectURL(result.downloadUrl), 1000);
    } catch (downloadError) {
      setError(downloadError.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="learning-actions">
      <Button type="button" variant="secondary" size="sm" onClick={requestDownload} disabled={busy}>
        <Download size={15} /> {busy ? "Requesting…" : "Download"}
      </Button>
      {error && <small className="form-error" role="alert">{error}</small>}
    </div>
  );
}

export function PurchasesPage() {
  const { orders } = usePlatform();
  const items = useMemo(
    () => orders
      .flatMap((order) => order.items.map((item) => ({ ...item, order })))
      .filter((item) => item.fulfilmentStatus !== "refunded"),
    [orders],
  );
  if (!items.length) return <EmptyState icon={BookOpen} title="No purchases yet" description="Your purchased courses and resources will appear here after server-side checkout." action={<Link className="button primary" to="/courses">Explore courses</Link>} />;
  return (
    <div className="stack">
      {items.map((item) => (
        <Card key={item.id} className="learning-row">
          <span className="list-icon">{item.kind === "course" ? <GraduationCap size={18} /> : <FileArchive size={18} />}</span>
          <div>
            <b>{item.title}</b>
            <small>{item.kind === "course" ? deliveryLabel(item.deliveryModes) : "Digital content"} · {item.price} points</small>
            <p className="learning-policy">
              {item.kind === "content"
                ? "Request a short-lived, server-authorized download link. The R2 bucket and object key remain private."
                : "Course delivery access is determined from the server-side order snapshot."}
            </p>
          </div>
          {item.kind === "content" ? <ContentDownloadButton contentVersionId={item.productId} /> : null}
          <Link className="button secondary sm" to={`/checkout-success/${item.order.id}`}>View receipt</Link>
        </Card>
      ))}
    </div>
  );
}

export function RefundPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { courses, submitRefund } = usePlatform();
  const course = courses.find((item) => item.id === id);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!course?.purchased) return <EmptyState icon={AlertCircle} title="Purchase not found" description="Only a server-recorded purchase can be considered for a refund." />;
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await submitRefund({ course, reason }); navigate("/orders"); } catch (refundError) { setError(refundError.message); } finally { setBusy(false); }
  };
  return <Card><span className="eyebrow">Refund request</span><h2>{course.title}</h2><p>The server evaluates the purchase-time policy, delivery evidence and current eligibility. This page does not decide eligibility locally.</p><form onSubmit={submit}><FormField label="Reason for request"><textarea required minLength="3" value={reason} onChange={(event) => setReason(event.target.value)} /></FormField>{error && <p className="form-error">{error}</p>}<div className="button-row"><Button variant="secondary" type="button" onClick={() => navigate(-1)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit for review"}</Button></div></form></Card>;
}
