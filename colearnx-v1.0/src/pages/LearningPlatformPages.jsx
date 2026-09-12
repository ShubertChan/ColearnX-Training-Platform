import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRight, BookOpen, CheckCircle2, ChevronDown, ChevronUp, Download, FileArchive, FileText, GraduationCap, Link2, Mail, ReceiptText, ShoppingCart, Trash2, Video } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import { listContentAssets, requestContentDownloadUrl } from "../api/uploads";
import { getCourseDelivery, requestCourseDownloadUrl } from "../api/courseDelivery";
import CourseVideoPlayer from "../components/CourseVideoPlayer";
import { cartItemKey, deliveryDisclosures, hasPurchasePolicy, refundDisclosure } from "../utils/purchaseDisclosure";
import { createKeyedRequestGuard } from "../utils/keyedRequestGuard";
import { Badge, Button, Card, EmptyState, FormField, Modal, Progress } from "../components/ui";

const deliveryLabel = (modes = []) => modes.map((mode) => `${mode[0].toUpperCase()}${mode.slice(1)}`).join(" + ") || "Not specified";
const purchaseSummaryLabel = (items = []) => !items[0]?.title ? "Purchase record" : items.length === 1 ? items[0].title : `${items[0].title} + ${items.length - 1} other item${items.length === 2 ? "" : "s"}`;
const safeHttpUrl = (value) => {
  try { const url = new URL(value || ""); return ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; }
  catch { return ""; }
};

export function CartPage() {
  const { cart, courses, contents, balance, removeFromCart, checkout, notify } = usePlatform();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(() => cart.map(cartItemKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const catalogue = useMemo(() => [
    ...courses.map((item) => ({ ...item, kind: "course", seller: item.trainer })),
    ...contents.map((item) => ({ ...item, kind: "content", seller: item.creator })),
  ], [contents, courses]);
  const items = cart.map((entry) => catalogue.find((item) => cartItemKey(item) === cartItemKey(entry))).filter((item) => item && !item.purchased);
  useEffect(() => setSelected((current) => current.filter((key) => items.some((item) => cartItemKey(item) === key))), [cart]);
  const selectedItems = items.filter((item) => selected.includes(cartItemKey(item)) && hasPurchasePolicy(item));
  const blockedPolicyCount = items.filter((item) => !hasPurchasePolicy(item)).length;
  const warnedAboutPolicy = useRef(false);
  useEffect(() => {
    if (blockedPolicyCount > 0 && !warnedAboutPolicy.current) {
      warnedAboutPolicy.current = true;
      notify(`${blockedPolicyCount} cart item${blockedPolicyCount === 1 ? " is" : "s are"} paused until the server supplies an exact refund-policy preview.`);
    }
    if (blockedPolicyCount === 0) warnedAboutPolicy.current = false;
  }, [blockedPolicyCount, notify]);
  const total = selectedItems.reduce((sum, item) => sum + item.price, 0);
  const pay = async () => {
    setBusy(true); setError("");
    try {
      const order = await checkout(selectedItems.map(({ kind, id }) => ({ kind, id })));
      if (order) navigate(`/checkout-success/${order.id}`);
    } catch (checkoutError) { setError(checkoutError.message); }
    finally { setBusy(false); }
  };
  if (!items.length) return <EmptyState icon={ShoppingCart} title="Your cart is empty" description="Add a published course or resource, then review everything before points are deducted." action={<div className="button-row"><Link className="button primary" to="/courses">Browse courses</Link><Link className="button secondary" to="/contents">Browse resources</Link></div>} />;
  return <><div className="content-grid cart-layout"><Card className="cart-list"><div className="card-heading"><div><span className="eyebrow">Draft cart</span><h3>{items.length} course/resource item{items.length === 1 ? "" : "s"}</h3></div></div>{items.map((item) => { const key = cartItemKey(item); return <div className="cart-row" key={key}><input type="checkbox" aria-label={`Select ${item.title} for checkout`} checked={selected.includes(key)} onChange={() => setSelected((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key])} /><span className="cart-thumb">{item.kind === "course" ? <GraduationCap size={17} /> : <FileArchive size={17} />}</span><div><b>{item.title}</b><small>{item.seller} · {item.kind === "course" ? deliveryLabel(item.deliveryModes) : item.type}</small><span className="cart-policy">{deliveryDisclosures(item)[0]} {refundDisclosure(item)}</span></div><strong>{item.price} pts</strong><button className="icon-button danger" onClick={() => removeFromCart(item.kind, item.id)} aria-label={`Remove ${item.title}`}><Trash2 size={16} /></button></div>; })}</Card><Card className="order-summary"><span className="eyebrow">Checkout summary</span><h3>Points payment</h3><div className="summary-row"><span>Selected items</span><b>{selectedItems.length}</b></div><div className="summary-row"><span>Total</span><b>{total} points</b></div><div className="summary-row"><span>Available balance</span><b>{balance} points</b></div>{balance < total && <p className="form-error">Your available balance is insufficient.</p>}<Button className="wide" disabled={busy || !selectedItems.length || balance < total} onClick={() => { setAccepted(false); setConfirming(true); }}>Review final order <ArrowRight size={16} /></Button></Card></div>{confirming && <Modal title="Confirm points purchase" onClose={() => !busy && setConfirming(false)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Back</Button><Button disabled={busy || !accepted} onClick={pay}>{busy ? "Processing…" : `Pay ${total} points`}</Button></>}><div className="checkout-confirmation"><p>Review the seller, delivery and purchase-time policy before points are deducted.</p>{selectedItems.map((item) => <div className="confirmation-item" key={cartItemKey(item)}><div><b>{item.title}</b><span>{item.seller} · {item.price} points</span></div><ul>{deliveryDisclosures(item).map((line) => <li key={line}>{line}</li>)}</ul><small>{refundDisclosure(item)}</small></div>)}<div className="summary-row total"><span>Balance after payment</span><b>{balance - total} points</b></div><label className="check-label policy-confirmation"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>I have reviewed the items, delivery method and refund policy. Clicking Pay creates a financial transaction.</span></label>{error && <p className="form-error" role="alert">{error}</p>}</div></Modal>}</>;
}

function ReceiptItems({ order }) {
  return order.items.map((item) => <article className="receipt-item" key={item.id}><div className="summary-row"><span>{item.title}</span><b>{item.price} points</b></div><dl className="receipt-details"><div><dt>Seller</dt><dd>{item.seller}</dd></div><div><dt>Delivery</dt><dd>{item.kind === "content" ? "Authorised digital download" : item.delivery}</dd></div><div><dt>Fulfilment</dt><dd>{item.fulfilmentStatus || "Recorded"}</dd></div><div><dt>Refund snapshot</dt><dd>{item.refundPolicy}</dd></div>{item.refundDeadlineAt && <div><dt>Refund deadline</dt><dd>{new Date(item.refundDeadlineAt).toLocaleString()}</dd></div>}<div><dt>Refund record</dt><dd>{item.refundRecords.length ? item.refundRecords.map((record) => `${record.reference || record.id}: ${record.status}`).join(", ") : "None"}</dd></div></dl></article>);
}

export function CheckoutSuccessPage() {
  const { orderId } = useParams();
  const { lastOrder, orders, purchaseSyncWarning, retryPurchaseSync } = usePlatform();
  const [syncing, setSyncing] = useState(false);
  const order = orderId ? orders.find((item) => item.id === orderId) : lastOrder;
  if (!order) return <EmptyState icon={ReceiptText} title="Order not found" description="Refresh order history after a completed checkout." action={<Link className="button primary" to="/orders">View order history</Link>} />;
  return <Card className="order-receipt"><section><CheckCircle2 size={38} /><span className="eyebrow">Checkout recorded</span><h2>Thank you for your purchase</h2><p>Your order is saved independently of secondary data refreshes.</p></section>{purchaseSyncWarning && <section className="sync-warning" role="status"><p>{purchaseSyncWarning}</p><Button variant="secondary" size="sm" disabled={syncing} onClick={async () => { setSyncing(true); await retryPurchaseSync(); setSyncing(false); }}>{syncing ? "Synchronising…" : "Retry synchronisation"}</Button></section>}<section><div className="summary-row"><span>Status</span><Badge tone="success">{order.status}</Badge></div><div className="summary-row"><span>Order number</span><b>{order.orderNo || order.id}</b></div><div className="summary-row"><span>Wallet transaction</span><b>{order.transactionReference || "Pending reference"}</b></div><div className="summary-row"><span>Total</span><b>{order.total} points</b></div><div className="summary-row"><span>Paid at</span><b>{order.paidAt ? new Date(order.paidAt).toLocaleString() : "—"}</b></div></section><section><h3>Purchased items</h3><ReceiptItems order={order} /></section><div className="button-row"><Link className="button secondary" to="/purchases">My Learning</Link><Link className="button primary" to="/orders">Order history</Link></div></Card>;
}

export function OrderHistoryPage() {
  const { orders, refreshOrders } = usePlatform(); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const refresh = async () => { setLoading(true); setError(""); try { await refreshOrders(); } catch (refreshError) { setError(refreshError.message); } finally { setLoading(false); } };
  if (!orders.length) return <EmptyState icon={ReceiptText} title="No orders yet" description={error || "Completed purchases are recorded here."} action={<Button onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh orders"}</Button>} />;
  return <Card><div className="card-heading"><div><span className="eyebrow">Order history</span><h2>Server-issued receipts</h2></div><Button variant="secondary" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button></div>{error && <p className="form-error">{error}</p>}<div className="order-history-list">{orders.map((order) => <article key={order.id} className="order-history-card"><header><div><b>{purchaseSummaryLabel(order.items)}</b><small>{order.paidAt ? new Date(order.paidAt).toLocaleString() : "Payment time unavailable"}</small></div><Badge tone={order.status === "Paid" ? "success" : "warning"}>{order.status}</Badge></header><div className="order-history-items">{order.items.map((item) => <div key={item.id}>{item.kind === "content" ? <FileArchive size={16} /> : <GraduationCap size={16} />}<span>{item.title}</span><b>{item.price} points</b></div>)}</div><footer><span>Total <b>{order.total} points</b></span><Link className="button secondary sm" to={`/checkout-success/${order.id}`}>View receipt</Link></footer></article>)}</div></Card>;
}

function ContentDownloadButton({ contentVersionId }) {
  const panelId = useId(); const [expanded, setExpanded] = useState(false); const [assets, setAssets] = useState(null); const [loading, setLoading] = useState(false); const [pending, setPending] = useState(() => new Set()); const [error, setError] = useState("");
  const downloadRequests = useMemo(() => createKeyedRequestGuard(setPending), []);
  const load = async () => { setLoading(true); setError(""); try { const result = await listContentAssets(contentVersionId); setAssets(result.filter((asset) => asset.status === "ready")); } catch (loadError) { setError(loadError.message); } finally { setLoading(false); } };
  const download = (asset) => downloadRequests.run(asset.assetId, async () => { setError(""); try { const result = await requestContentDownloadUrl(contentVersionId, asset.assetId, { filename: asset.filename, mediaType: asset.mediaType }); const url = result.demoObjectUrl ? result.downloadUrl : safeHttpUrl(result.downloadUrl); if (!url) throw new Error("The delivery service returned an unsafe URL."); const link = document.createElement("a"); link.href = url; link.download = result.filename || asset.filename; link.rel = "noopener"; document.body.appendChild(link); link.click(); link.remove(); if (result.demoObjectUrl) window.setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (downloadError) { setError(downloadError.message); } });
  return <div className="learning-actions"><Button variant="secondary" size="sm" onClick={() => { const next = !expanded; setExpanded(next); if (next && assets === null) void load(); }} aria-expanded={expanded} aria-controls={panelId}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}{expanded ? "Hide files" : "Show files"}</Button><div id={panelId} hidden={!expanded} className="delivery-panel">{loading && <span role="status">Loading purchased files…</span>}{(assets || []).map((asset) => <div className="asset-download-row" key={asset.assetId}><FileText size={15} /><span>{asset.filename}</span><Button variant="secondary" size="sm" disabled={pending.has(asset.assetId)} onClick={() => void download(asset)}><Download size={15} />{pending.has(asset.assetId) ? "Requesting…" : "Download"}</Button></div>)}{assets !== null && !assets.length && <small>No verified files are available yet.</small>}{error && <p className="form-error">{error}</p>}<Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>Refresh files</Button></div></div>;
}

function CourseDeliveryPanel({ item }) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [delivery, setDelivery] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(() => new Set());
  const downloadRequests = useMemo(() => createKeyedRequestGuard(setDownloading), []);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const modes = item.deliveryModes.map((mode) => String(mode).toLowerCase());
  const load = async () => {
    setLoading(true); setError("");
    try { const result = await getCourseDelivery(item.id); if (mounted.current) setDelivery(result); }
    catch (loadError) { if (mounted.current) setError(loadError.message || "Could not load protected delivery."); }
    finally { if (mounted.current) setLoading(false); }
  };
  const download = (asset) => downloadRequests.run(asset.assetId, async () => {
    setError("");
    try {
      const result = await requestCourseDownloadUrl(item.id, asset.assetId);
      const url = safeHttpUrl(result.downloadUrl);
      if (!url) throw new Error("The delivery service returned an unsafe URL.");
      const link = document.createElement("a");
      link.href = url; link.download = result.filename || asset.filename || "colearnx-course";
      link.target = "_blank"; link.rel = "noopener noreferrer";
      document.body.appendChild(link); link.click(); link.remove();
    } catch (downloadError) { setError(downloadError.message); }
  });
  const joinUrl = safeHttpUrl(delivery?.joinUrl);
  return <div className="learning-actions">
    <Button variant="secondary" size="sm" onClick={() => {
      const next = !expanded; setExpanded(next); if (next && !delivery) void load();
    }} aria-expanded={expanded} aria-controls={panelId}>{expanded ? "Hide delivery" : "Open delivery"}</Button>
    <div id={panelId} hidden={!expanded} className="delivery-panel">
      {loading && <p role="status">Checking purchase authorisation…</p>}
      {delivery && <>
        {modes.includes("cloud") && <section><b>Cloud course files</b>
          {(delivery.assets || []).filter((asset) => !asset.status || asset.status === "ready").map((asset) =>
            <div className="asset-download-row" key={asset.assetId}><FileText size={15} /><span>{asset.filename}</span>
              <Button variant="secondary" size="sm" disabled={downloading.has(asset.assetId)} onClick={() => void download(asset)}>{downloading.has(asset.assetId) ? "Requesting…" : "Download"}</Button></div>)}
          {!(delivery.assets || []).length && <p>No authorised course file is available yet.</p>}
        </section>}
        {(modes.includes("local") || modes.includes("live")) && <section><b>Buyer-only coordination</b>
          <p>{delivery.instructions || "The Trainer has not supplied instructions yet."}</p>
          <dl className="receipt-details"><div><dt>Trainer contact</dt><dd>{delivery.trainerContact || "Not supplied"}</dd></div>
            {joinUrl && <div><dt>Join link</dt><dd><a href={joinUrl} target="_blank" rel="noreferrer">Open meeting or group link</a></dd></div>}</dl>
          <small>The Trainer and learner arrange fulfilment themselves.</small>
        </section>}
        {(delivery.onlineVideo || delivery.progressTrackingType === "online_video" || item.onlineVideo) &&
          <CourseVideoPlayer orderItemId={item.id} playbackUrl={safeHttpUrl(delivery.playbackUrl)} record={delivery}
            onRecorded={(record) => setDelivery((current) => ({ ...current, ...record }))} />}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh protected delivery"}</Button>
    </div>
  </div>;
}

export function PurchasesPage() {
  const { orders } = usePlatform();
  const items = useMemo(() => orders.flatMap((order) => order.items.map((item) => ({ ...item, order }))).filter((item) => ["paid", "reserved", "fulfilled"].includes(item.fulfilmentStatus)), [orders]);
  if (!items.length) return <EmptyState icon={BookOpen} title="No purchases yet" description="Purchased courses and resources appear here after checkout." action={<Link className="button primary" to="/courses">Explore courses</Link>} />;
  return <div className="stack">{items.map((item) => <Card key={item.id} className="learning-row"><span className="list-icon">{item.kind === "course" ? <GraduationCap size={18} /> : <FileArchive size={18} />}</span><div><b>{item.title}</b><small>{item.kind === "course" ? deliveryLabel(item.deliveryModes) : "Digital content"} · {item.price} points</small><p className="learning-policy">{item.kind === "content" ? "Request a short-lived, purchase-authorised download link." : deliveryDisclosures(item).join(" ")}</p></div>{item.kind === "content" ? <ContentDownloadButton contentVersionId={item.productId} /> : <CourseDeliveryPanel item={item} />}<Link className="button secondary sm" to={`/checkout-success/${item.order.id}`}>View receipt</Link></Card>)}</div>;
}

export function RefundPage() {
  const { id } = useParams(); const navigate = useNavigate(); const { courses, submitRefund } = usePlatform(); const course = courses.find((item) => item.id === id); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  if (!course?.purchased) return <EmptyState icon={AlertCircle} title="Purchase not found" description="Only a server-recorded purchase can be considered for a refund." />;
  const submit = async (event) => { event.preventDefault(); setBusy(true); setError(""); try { await submitRefund({ course, reason }); navigate("/orders"); } catch (refundError) { setError(refundError.message); } finally { setBusy(false); } };
  return <Card><span className="eyebrow">Refund request</span><h2>{course.title}</h2><p>{refundDisclosure(course)} The API evaluates the purchase-time snapshot, delivery evidence and any online-video watchedSeconds / totalDurationSeconds record.</p><form onSubmit={submit}><FormField label="Reason for request"><textarea required minLength="3" value={reason} onChange={(event) => setReason(event.target.value)} /></FormField>{error && <p className="form-error">{error}</p>}<div className="button-row"><Button variant="secondary" type="button" onClick={() => navigate(-1)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit for review"}</Button></div></form></Card>;
}
