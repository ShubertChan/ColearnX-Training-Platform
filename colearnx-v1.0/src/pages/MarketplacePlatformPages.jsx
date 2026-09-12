import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FileArchive, GraduationCap, ShoppingCart } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import { deliveryDisclosures, refundDisclosure, cartItemKey, hasPurchasePolicy } from "../utils/purchaseDisclosure";
import ReportButton from "../components/ReportButton";
import { useMarketplaceQuery } from "../utils/useMarketplaceQuery";
import { Badge, Button, Card, EmptyState } from "../components/ui";

const PAGE_SIZE = 12;
function useMarketplaceFilters() {
  const [params, setParams] = useSearchParams();
  return (name, fallback = "") => [params.get(name) || fallback, (value) => {
    const next = new URLSearchParams(params);
    if (value && String(value) !== String(fallback)) next.set(name, String(value)); else next.delete(name);
    if (name !== "page") next.delete("page");
    setParams(next, { replace: true });
  }];
}
const deliveryLabel = (modes = []) =>
  modes.map((mode) => `${mode[0].toUpperCase()}${mode.slice(1)}`).join(" + ") || "Not specified";

function CatalogStatus({ state, hasItems, onRetry }) {
  if (state.status === "loading") return <p role="status">{hasItems ? "Updating listings…" : "Loading listings…"}</p>;
  if (state.status !== "error") return null;
  return <div className="catalog-error"><p role="alert">{state.error}{hasItems ? " Previously loaded listings are shown below." : ""}</p><Button variant="secondary" onClick={() => void onRetry()}>Retry loading listings</Button></div>;
}

function Pagination({ page, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  return <nav className="pagination" aria-label="Marketplace pages"><Button variant="secondary" size="sm" disabled={page === 1} onClick={() => onChange(page - 1)}>Previous</Button><span>Page {page} of {pages} · {total} results</span><Button variant="secondary" size="sm" disabled={page === pages} onClick={() => onChange(page + 1)}>Next</Button></nav>;
}

function DisclosureList({ item }) {
  return <div className="purchase-disclosure"><b>Delivery and refund information</b><ul>{deliveryDisclosures(item).map((line) => <li key={line}>{line}</li>)}</ul><p><strong>Purchase-time refund policy:</strong> {refundDisclosure(item)}</p></div>;
}

function CourseCard({ course }) {
  return <article className="market-card"><div className="market-card-mark"><GraduationCap size={27} /></div><div><div className="badge-row"><Badge>{course.category}</Badge><Badge tone="info">{deliveryLabel(course.deliveryModes)}</Badge>{course.onlineVideo && <Badge tone="warning">Online video</Badge>}</div><Link to={`/courses/${course.id}`}><h3>{course.title}</h3></Link><p>{course.description}</p><div className="market-card-footer"><span>{course.ownerId ? <Link to={`/public-profile/${course.ownerId}`}>{course.trainer}</Link> : course.trainer}</span><b>{course.purchased ? "Purchased" : `${course.price} points`}</b><Link className="button secondary sm" to={`/courses/${course.id}`}>View <ArrowRight size={15} /></Link></div></div></article>;
}

export function CourseMarketplacePage() {
  const { courses: allCourses, courseCatalogState: globalState, refreshCatalog: refreshGlobal } = usePlatform();
  const { items: courses, state: courseCatalogState, retry: refreshCatalog } = useMarketplaceQuery("course", allCourses, globalState, refreshGlobal);
  const field = useMarketplaceFilters();
  const [query, setQuery] = field("q");
  const [category, setCategory] = field("category");
  const [trainer, setTrainer] = field("trainer");
  const [mode, setMode] = field("delivery");
  const [date, setDate] = field("date");
  const [sort, setSort] = field("sort", "title");
  const [requestedPage, setPage] = field("page", "1");
  const categories = [...new Set(courses.map((item) => item.category))].sort();
  const trainers = [...new Set(courses.map((item) => item.trainer))].sort();
  const filtered = useMemo(() => courses
    .filter((course) => `${course.title} ${course.description} ${course.trainer} ${course.category}`.toLowerCase().includes(query.toLowerCase()))
    .filter((course) => !category || course.category === category)
    .filter((course) => !trainer || course.trainer === trainer)
    .filter((course) => !mode || course.deliveryModes.includes(mode))
    .filter((course) => !date || (course.startsAt && course.startsAt.slice(0, 10) >= date))
    .sort((a, b) => sort === "price-low" ? a.price - b.price : sort === "price-high" ? b.price - a.price : sort === "date" ? new Date(a.startsAt || 8640000000000000) - new Date(b.startsAt || 8640000000000000) : a.title.localeCompare(b.title)), [courses, query, category, trainer, mode, date, sort]);
  const page = Math.min(Math.max(1, Math.floor(Number(requestedPage)) || 1), Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return <><div className="market-toolbar filter-grid"><div className="search-field"><input aria-label="Search published courses" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search courses" /></div><select aria-label="Filter course category" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{categories.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter Trainer" value={trainer} onChange={(event) => setTrainer(event.target.value)}><option value="">All Trainers</option>{trainers.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter delivery mode" value={mode} onChange={(event) => setMode(event.target.value)}><option value="">All delivery modes</option><option value="cloud">Cloud download</option><option value="local">Local</option><option value="live">Live</option></select><input aria-label="Starts on or after" type="date" value={date} onChange={(event) => setDate(event.target.value)} /><select aria-label="Sort courses" value={sort} onChange={(event) => setSort(event.target.value)}><option value="title">Title</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option><option value="date">Start date</option></select></div><CatalogStatus state={courseCatalogState} hasItems={courses.length > 0} onRetry={refreshCatalog} />{(courseCatalogState.status === "ready" || courses.length > 0) && <div className="result-bar"><span><b>{filtered.length}</b> published courses</span><small>All catalogue pages are loaded; use filters to narrow the result.</small></div>}{visible.length ? <><div className="market-grid">{visible.map((course) => <CourseCard key={course.id} course={course} />)}</div><Pagination page={page} total={filtered.length} onChange={setPage} /></> : courseCatalogState.status === "ready" ? <EmptyState icon={GraduationCap} title={courses.length ? "No matching courses" : "No published courses"} description={courses.length ? "Adjust the filters and try again." : "Published courses will appear after administrator approval."} /> : null}</>;
}

export function CourseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { courses, cart, addToCart, authenticated, canPurchase, courseCatalogState, refreshCatalog } = usePlatform();
  const course = courses.find((item) => item.id === id);
  if (!course) return courseCatalogState.status === "ready" ? <EmptyState icon={GraduationCap} title="Course not found" description="This course is unavailable or has not been published." /> : <CatalogStatus state={courseCatalogState} hasItems={false} onRetry={refreshCatalog} />;
  const inCart = cart.some((item) => cartItemKey(item) === cartItemKey({ kind: "course", id: course.id }));
  const policyReady = hasPurchasePolicy(course);
  return <><button className="back-link" onClick={() => navigate(-1)}><ArrowLeft size={16} /> Back to marketplace</button><Card className="detail-hero"><div className="detail-mark"><GraduationCap size={38} /></div><div><div className="badge-row"><Badge>{course.category}</Badge><Badge tone="info">{deliveryLabel(course.deliveryModes)}</Badge>{course.onlineVideo && <Badge tone="warning">Online video</Badge>}</div><h2>{course.title}</h2><p>{course.description}</p><div className="profile-meta"><span>{course.ownerId ? <Link to={`/public-profile/${course.ownerId}`}>{course.trainer}</Link> : course.trainer}</span>{course.startsAt && <span>Starts {new Date(course.startsAt).toLocaleString()}</span>}</div></div><aside className="purchase-box"><span className="eyebrow">Course price</span><strong>{course.price} <small>points</small></strong>{course.purchased ? <><Badge tone="success"><Check size={13} /> Purchased</Badge><p>Open My Learning for the protected delivery entry and purchase-time policy.</p><Link className="button primary wide" to="/purchases">Open My Learning</Link><Link className="button secondary wide" to={`/refund/${course.id}`}>Request refund</Link></> : !authenticated ? <Link className="button primary wide" to="/login" state={{ from: { pathname: `/courses/${course.id}` } }}>Sign in to add to cart</Link> : canPurchase ? <><Button className="wide" disabled={inCart || !course.purchaseEnabled || !policyReady} onClick={() => addToCart("course", course.id)}><ShoppingCart size={16} /> {inCart ? "Already in cart" : !policyReady ? "Policy unavailable" : "Add to cart"}</Button>{!policyReady && <p className="form-error">Checkout is paused until the server supplies the exact refund-policy preview.</p>}</> : <p className="form-error">Administrator accounts have oversight access and cannot purchase marketplace items.</p>}</aside></Card><div className="content-grid two"><Card><span className="eyebrow">Delivery</span><h3>{deliveryLabel(course.deliveryModes)}</h3><DisclosureList item={course} /></Card><Card><span className="eyebrow">Availability</span><h3>{course.capacity ? `${course.capacity} seats` : "No fixed capacity"}</h3><p>Availability and the purchase policy are revalidated by the server before points are deducted.</p></Card></div><ReportButton kind="course" productId={course.id} /></>;
}

function ContentCard({ content }) {
  return <article className="content-card"><div className="content-type"><FileArchive size={26} /><span>{content.type}</span></div><div><div className="badge-row"><Badge>{content.category}</Badge></div><Link to={`/contents/${content.id}`}><h3>{content.title}</h3></Link><p>{content.description}</p><div className="market-card-footer"><span>{content.ownerId ? <Link to={`/public-profile/${content.ownerId}`}>{content.creator}</Link> : content.creator}</span><b>{content.purchased ? "Purchased" : `${content.price} points`}</b><Link className="button secondary sm" to={`/contents/${content.id}`}>View <ArrowRight size={15} /></Link></div></div></article>;
}

export function ContentMarketplacePage() {
  const { contents: allContents, contentCatalogState: globalState, refreshCatalog: refreshGlobal } = usePlatform();
  const { items: contents, state: contentCatalogState, retry: refreshCatalog } = useMarketplaceQuery("content", allContents, globalState, refreshGlobal);
  const field = useMarketplaceFilters();
  const [query, setQuery] = field("q"); const [category, setCategory] = field("category"); const [type, setType] = field("type"); const [sort, setSort] = field("sort", "title"); const [requestedPage, setPage] = field("page", "1");
  const categories = [...new Set(contents.map((item) => item.category))].sort(); const types = [...new Set(contents.map((item) => item.type))].sort();
  const filtered = useMemo(() => contents.filter((item) => `${item.title} ${item.description} ${item.creator} ${item.category} ${item.type}`.toLowerCase().includes(query.toLowerCase())).filter((item) => !category || item.category === category).filter((item) => !type || item.type === type).sort((a, b) => sort === "price-low" ? a.price - b.price : sort === "price-high" ? b.price - a.price : a.title.localeCompare(b.title)), [contents, query, category, type, sort]);
  const page = Math.min(Math.max(1, Math.floor(Number(requestedPage)) || 1), Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return <><div className="market-toolbar filter-grid"><div className="search-field"><input aria-label="Search published resources" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search resources" /></div><select aria-label="Filter resource category" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{categories.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter resource type" value={type} onChange={(event) => setType(event.target.value)}><option value="">All types</option>{types.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Sort resources" value={sort} onChange={(event) => setSort(event.target.value)}><option value="title">Title</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option></select></div><CatalogStatus state={contentCatalogState} hasItems={contents.length > 0} onRetry={refreshCatalog} />{(contentCatalogState.status === "ready" || contents.length > 0) && <div className="result-bar"><span><b>{filtered.length}</b> published resources</span><small>Access is granted only by a completed order.</small></div>}{visible.length ? <><div className="content-market-grid">{visible.map((content) => <ContentCard key={content.id} content={content} />)}</div><Pagination page={page} total={filtered.length} onChange={setPage} /></> : contentCatalogState.status === "ready" ? <EmptyState icon={FileArchive} title={contents.length ? "No matching resources" : "No published resources"} description={contents.length ? "Adjust the filters and try again." : "Approved creator content will appear here."} /> : null}</>;
}

export function ContentDetailPage() {
  const { id } = useParams(); const navigate = useNavigate();
  const { contents, balance, cart, addToCart, authenticated, canPurchase, contentCatalogState, refreshCatalog } = usePlatform();
  const item = contents.find((content) => content.id === id);
  if (!item) return contentCatalogState.status === "ready" ? <EmptyState icon={FileArchive} title="Content not found" description="This resource is unavailable or has not been published." /> : <CatalogStatus state={contentCatalogState} hasItems={false} onRetry={refreshCatalog} />;
  const inCart = cart.some((entry) => cartItemKey(entry) === cartItemKey({ kind: "content", id: item.id }));
  const policyReady = hasPurchasePolicy(item);
  return <><button className="back-link" onClick={() => navigate(-1)}><ArrowLeft size={16} /> Back to marketplace</button><Card className="content-detail-hero"><div className="content-detail-mark"><FileArchive size={36} /><span>{item.type}</span></div><div><div className="badge-row"><Badge>{item.category}</Badge>{item.purchased && <Badge tone="success"><Check size={13} /> Purchased</Badge>}</div><h2>{item.title}</h2><p>{item.description}</p><span>{item.ownerId ? <Link to={`/public-profile/${item.ownerId}`}>{item.creator}</Link> : item.creator}</span></div></Card><div className="content-grid detail-columns"><Card><span className="eyebrow">Access</span><h3>Authorised digital download</h3><p>Purchased files are listed in My Learning. Each download uses a short-lived server URL; storage keys and credentials are never exposed.</p><DisclosureList item={item} /></Card><Card className="purchase-summary"><span className="eyebrow">Purchase summary</span><div className="summary-row"><span>Resource</span><b>{item.title}</b></div><div className="summary-row"><span>Seller</span><b>{item.creator}</b></div><div className="summary-row"><span>Price</span><b>{item.price} points</b></div>{authenticated && <div className="summary-row"><span>Available balance</span><b>{balance} points</b></div>}{item.purchased ? <Link className="button secondary wide" to="/purchases">Open purchased files</Link> : !authenticated ? <Link className="button primary wide" to="/login" state={{ from: { pathname: `/contents/${item.id}` } }}>Sign in to add to cart</Link> : canPurchase ? <><Button className="wide" disabled={inCart || balance < item.price || !policyReady} onClick={() => addToCart("content", item.id)}><ShoppingCart size={16} /> {inCart ? "Already in cart" : balance < item.price ? "Insufficient balance" : !policyReady ? "Policy unavailable" : "Add to cart"}</Button>{!policyReady && <p className="form-error">Checkout is paused until the server supplies the exact refund-policy preview.</p>}</> : <p className="form-error">Administrator accounts cannot purchase marketplace items.</p>}</Card></div><ReportButton kind="content" productId={item.id} /></>;
}
