import { useTranslation } from "../i18n/LanguageContext";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ShieldCheck, UserRound, FileArchive, GraduationCap, ShoppingCart } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import { deliveryDisclosures, refundDisclosure, cartItemKey, hasPurchasePolicy } from "../utils/purchaseDisclosure";
import ReportButton from "../components/ReportButton";
import MarketplaceDateFilter from "../components/MarketplaceDateFilter";
import { useMarketplaceQuery } from "../utils/useMarketplaceQuery";
import { getCourseTypeLabel, isVideoCourse } from "../utils/coursePresentation";
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
function CatalogStatus({ state, hasItems, onRetry }) {
  const { t } = useTranslation();
  if (state.status === "loading") return <p role="status">{hasItems ? t("Updating listings…") : t("Loading listings…")}</p>;
  if (state.status !== "error") return null;
  return <div className="catalog-error"><p role="alert">{t(state.error)}{hasItems ? t(" Previously loaded listings are shown below.") : ""}</p><Button variant="secondary" onClick={() => void onRetry()}>{t("Retry loading listings")}</Button></div>;
}

function Pagination({ page, total, onChange }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  return <nav className="pagination" aria-label={t("Marketplace pages")}><Button variant="secondary" size="sm" disabled={page === 1} onClick={() => onChange(page - 1)}>{t("Previous")}</Button><span>{t("Page ")}{page}{t(" of ")}{pages} · {total}{t(" results")}</span><Button variant="secondary" size="sm" disabled={page === pages} onClick={() => onChange(page + 1)}>{t("Next")}</Button></nav>;
}

function DisclosureList({ item }) {
  const { t } = useTranslation();
  return <div className="purchase-disclosure"><b>{t("Delivery and refund information")}</b><ul>{deliveryDisclosures(item).map((line) => <li key={line}>{t(line)}</li>)}</ul><p><strong>{t("Purchase-time refund policy:")}</strong> {t(refundDisclosure(item))}</p></div>;
}

function CourseCard({ course }) {
  const { t } = useTranslation();
  return <article className="market-card"><div className="market-card-mark"><GraduationCap size={27} /></div><div><div className="badge-row"><Badge>{t(course.category)}</Badge><Badge tone="info">{t(getCourseTypeLabel(course))}</Badge></div><Link to={`/courses/${course.id}`}><h3>{course.title}</h3></Link><p>{course.description}</p><div className="market-card-footer"><span>{course.ownerId ? <Link to={`/public-profile/${course.ownerId}`}>{course.trainer}</Link> : course.trainer}</span><b>{course.purchased ? t("Purchased") : t("{0} points", { 0: course.price })}</b><Link className="button secondary sm" to={`/courses/${course.id}`}>{t("View ")}<ArrowRight size={15} /></Link></div></div></article>;
}

export function CourseMarketplacePage() {
  const { t } = useTranslation();
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
    .filter((course) => `${course.title} ${course.description} ${course.trainer} ${t(course.category)}`.toLowerCase().includes(query.toLowerCase()))
    .filter((course) => !category || course.category === category)
    .filter((course) => !trainer || course.trainer === trainer)
    .filter((course) => !mode || (mode === "video" ? isVideoCourse(course) : course.deliveryModes.includes(mode)))
    .filter((course) => !date || (course.startsAt && course.startsAt.slice(0, 10) >= date))
    .sort((a, b) => sort === "price-low" ? a.price - b.price : sort === "price-high" ? b.price - a.price : sort === "date" ? new Date(a.startsAt || 8640000000000000) - new Date(b.startsAt || 8640000000000000) : a.title.localeCompare(b.title)), [courses, query, category, trainer, mode, date, sort]);
  const page = Math.min(Math.max(1, Math.floor(Number(requestedPage)) || 1), Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return <><div className="market-toolbar filter-grid"><div className="search-field"><input aria-label={t("Search published courses")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search courses")} /></div><select aria-label={t("Filter course category")} value={category} onChange={(event) => setCategory(event.target.value)}><option value="">{t("All categories")}</option>{categories.map((value) => <option key={value} value={value}>{t(value)}</option>)}</select><select aria-label={t("Filter Trainer")} value={trainer} onChange={(event) => setTrainer(event.target.value)}><option value="">{t("All Trainers")}</option>{trainers.map((value) => <option key={value} value={value}>{value}</option>)}</select><select aria-label={t("Filter course type")} value={mode} onChange={(event) => setMode(event.target.value)}><option value="">{t("All course types")}</option><option value="video">{t("Video course")}</option><option value="live">{t("Instructor-led: online live")}</option><option value="local">{t("Instructor-led: offline arrangement")}</option></select><MarketplaceDateFilter value={date} onChange={setDate} /><select aria-label={t("Sort courses")} value={sort} onChange={(event) => setSort(event.target.value)}><option value="title">{t("Title")}</option><option value="price-low">{t("Price: low to high")}</option><option value="price-high">{t("Price: high to low")}</option><option value="date">{t("Start date")}</option></select></div><CatalogStatus state={courseCatalogState} hasItems={courses.length > 0} onRetry={refreshCatalog} />{(courseCatalogState.status === "ready" || courses.length > 0) && <div className="result-bar"><span><b>{filtered.length}</b>{t(" published courses")}</span><small>{t("All catalogue pages are loaded; use filters to narrow the result.")}</small></div>}{visible.length ? <><div className="market-grid">{visible.map((course) => <CourseCard key={course.id} course={course} />)}</div><Pagination page={page} total={filtered.length} onChange={setPage} /></> : courseCatalogState.status === "ready" ? <EmptyState icon={GraduationCap} title={courses.length ? t("No matching courses") : t("No published courses")} description={courses.length ? t("Adjust the filters and try again.") : t("Published courses will appear after administrator approval.")} /> : null}</>;
}

export function CourseDetailPage() {
  const { t, formatLocale } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { courses, cart, addToCart, authenticated, canPurchase, courseCatalogState, refreshCatalog } = usePlatform();
  const course = courses.find((item) => item.id === id);
  if (!course) return courseCatalogState.status === "ready" ? <EmptyState icon={GraduationCap} title={t("Course not found")} description={t("This course is unavailable or has not been published.")} /> : <CatalogStatus state={courseCatalogState} hasItems={false} onRetry={refreshCatalog} />;
  const inCart = cart.some((item) => cartItemKey(item) === cartItemKey({ kind: "course", id: course.id }));
  const policyReady = hasPurchasePolicy(course);
  const typeLabel = t(getCourseTypeLabel(course));
  return (
    <div className="course-detail-page">
      <button className="back-link" onClick={() => navigate("/courses")}><ArrowLeft size={16} />{t("Back to marketplace")}</button>
      <div className="course-detail-grid">
        <div className="course-detail-main">
          <section className="course-overview">
            <span className="course-overview-icon"><GraduationCap size={30} /></span>
            <div className="badge-row">{course.category && <Badge>{t(course.category)}</Badge>}<Badge tone="info">{typeLabel}</Badge></div>
            <h2>{course.title}</h2>
            <div className="course-instructor"><span className="course-instructor-avatar"><UserRound size={18} /></span><div><small>{t("Meet your instructor")}</small>{course.ownerId ? <Link to={`/public-profile/${course.ownerId}`}>{course.trainer}</Link> : <strong>{course.trainer}</strong>}</div></div>
          </section>
          <Card className="course-about"><span className="eyebrow">{t("Learning essentials")}</span><h3>{t("About the course")}</h3><p>{course.description}</p></Card>
          <Card className="course-delivery"><span className="eyebrow">{t("Before you enrol")}</span><h3>{t("Delivery and refund information")}</h3><DisclosureList item={course} /></Card>
          <ReportButton kind="course" productId={course.id} />
        </div>
        <aside className="course-purchase-card" aria-label={t("Purchase summary")}>
          <span className="eyebrow">{t("Course price")}</span>
          <div className="course-price">{course.price}<span>{t("points")}</span></div>
          {course.purchased ? <>
            <Badge tone="success"><Check size={13} />{t("Purchased")}</Badge>
            <p>{t("Open My Learning for the protected delivery entry and purchase-time policy.")}</p>
            <Link className="button primary wide" to="/purchases">{t("Open My Learning")}<ArrowRight size={16} /></Link>
            <Link className="button secondary wide" to={`/refund/${course.id}`}>{t("Request refund")}</Link>
          </> : !authenticated ? <Link className="button primary wide" to="/login" state={{ from: { pathname: `/courses/${course.id}` } }}>{t("Sign in to add to cart")}<ArrowRight size={16} /></Link> : canPurchase ? <>
            <Button className="wide" disabled={inCart || !course.purchaseEnabled || !policyReady} onClick={() => addToCart("course", course.id)}>{inCart ? <Check size={17} /> : <ShoppingCart size={17} />}{inCart ? t("Already in cart") : !policyReady ? t("Policy unavailable") : t("Add to cart")}</Button>
            {!policyReady && <p className="form-error">{t("Checkout is paused until the server supplies the exact refund-policy preview.")}</p>}
          </> : <p className="form-error">{t("Administrator accounts have oversight access and cannot purchase marketplace items.")}</p>}
          <p className="course-purchase-note"><ShieldCheck size={15} />{t("Secure points checkout")}</p>
          <dl className="course-facts">
            <div><dt>{t("Course type")}</dt><dd>{typeLabel}</dd></div>
            {course.startsAt && <div><dt>{t("Start date")}</dt><dd>{new Date(course.startsAt).toLocaleString(formatLocale, { dateStyle: "medium", timeStyle: "short" })}</dd></div>}
            <div><dt>{t("Availability")}</dt><dd>{course.capacity ? t("{0} seats", { 0: course.capacity }) : t("No fixed capacity")}</dd></div>
          </dl>
          <p className="course-checkout-hint">{t("Review delivery and refund details before paying.")}</p>
        </aside>
      </div>
    </div>
  );
}

function ContentCard({ content }) {
  const { t } = useTranslation();
  return <article className="content-card"><div className="content-type"><FileArchive size={26} /><span>{t(content.type)}</span></div><div><div className="badge-row">{content.category && <Badge>{t(content.category)}</Badge>}</div><Link to={`/contents/${content.id}`}><h3>{content.title}</h3></Link><p>{content.description}</p><div className="market-card-footer"><span>{content.ownerId ? <Link to={`/public-profile/${content.ownerId}`}>{content.creator}</Link> : content.creator}</span><b>{content.purchased ? t("Purchased") : t("{0} points", { 0: content.price })}</b><Link className="button secondary sm" to={`/contents/${content.id}`}>{t("View ")}<ArrowRight size={15} /></Link></div></div></article>;
}

export function ContentMarketplacePage() {
  const { t } = useTranslation();
  const { contents: allContents, contentCatalogState: globalState, refreshCatalog: refreshGlobal } = usePlatform();
  const { items: contents, state: contentCatalogState, retry: refreshCatalog } = useMarketplaceQuery("content", allContents, globalState, refreshGlobal);
  const field = useMarketplaceFilters();
  const [query, setQuery] = field("q"); const [category, setCategory] = field("category"); const [type, setType] = field("type"); const [sort, setSort] = field("sort", "title"); const [requestedPage, setPage] = field("page", "1");
  // Options belong to the full catalogue, never to the last filtered response.
  const categories = [...new Set(allContents.map((item) => item.category).filter(Boolean))].sort(); const types = [...new Set(allContents.map((item) => item.type).filter(Boolean))].sort();
  useEffect(() => {
    // Old links may retain the former synthetic fallback. Keep real categories intact.
    if (globalState.status === "ready" && category === "General" && !allContents.some(item => item.category === "General")) setCategory("");
  }, [category, globalState.status, allContents, setCategory]);
  const filtered = useMemo(() => contents.filter((item) => `${item.title} ${item.description} ${item.creator} ${t(item.category)} ${t(item.type)}`.toLowerCase().includes(query.toLowerCase())).filter((item) => !category || item.category === category).filter((item) => !type || item.type === type).sort((a, b) => sort === "price-low" ? a.price - b.price : sort === "price-high" ? b.price - a.price : a.title.localeCompare(b.title)), [contents, query, category, type, sort]);
  const page = Math.min(Math.max(1, Math.floor(Number(requestedPage)) || 1), Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return <><div className="market-toolbar filter-grid content-market-toolbar"><input aria-label={t("Search published resources")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search resources")} /><select aria-label={t("Filter resource category")} value={category} onChange={(event) => setCategory(event.target.value)}><option value="">{t("All categories")}</option>{categories.map((value) => <option key={value} value={value}>{t(value)}</option>)}</select><select aria-label={t("Filter resource type")} value={type} onChange={(event) => setType(event.target.value)}><option value="">{t("All types")}</option>{types.map((value) => <option key={value} value={value}>{t(value)}</option>)}</select><select aria-label={t("Sort resources")} value={sort} onChange={(event) => setSort(event.target.value)}><option value="title">{t("Title")}</option><option value="price-low">{t("Price: low to high")}</option><option value="price-high">{t("Price: high to low")}</option></select></div><CatalogStatus state={contentCatalogState} hasItems={contents.length > 0} onRetry={refreshCatalog} />{(contentCatalogState.status === "ready" || contents.length > 0) && <div className="result-bar"><span><b>{filtered.length}</b>{t(" published resources")}</span><small>{t("Access is granted only by a completed order.")}</small></div>}{visible.length ? <><div className="content-market-grid">{visible.map((content) => <ContentCard key={content.id} content={content} />)}</div><Pagination page={page} total={filtered.length} onChange={setPage} /></> : contentCatalogState.status === "ready" ? <EmptyState icon={FileArchive} title={contents.length ? t("No matching resources") : t("No published resources")} description={contents.length ? t("Adjust the filters and try again.") : t("Approved creator content will appear here.")} /> : null}</>;
}

export function ContentDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams(); const navigate = useNavigate();
  const { contents, balance, cart, addToCart, authenticated, canPurchase, contentCatalogState, refreshCatalog } = usePlatform();
  const item = contents.find((content) => content.id === id);
  if (!item) return contentCatalogState.status === "ready" ? <EmptyState icon={FileArchive} title={t("Content not found")} description={t("This resource is unavailable or has not been published.")} /> : <CatalogStatus state={contentCatalogState} hasItems={false} onRetry={refreshCatalog} />;
  const inCart = cart.some((entry) => cartItemKey(entry) === cartItemKey({ kind: "content", id: item.id }));
  const policyReady = hasPurchasePolicy(item);
  return <><button className="back-link" onClick={() => navigate(-1)}><ArrowLeft size={16} />{t(" Back to marketplace")}</button><Card className="content-detail-hero"><div className="content-detail-mark"><FileArchive size={36} /><span>{t(item.type)}</span></div><div><div className="badge-row">{item.category && <Badge>{t(item.category)}</Badge>}{item.purchased && <Badge tone="success"><Check size={13} />{t(" Purchased")}</Badge>}</div><h2>{item.title}</h2><p>{item.description}</p><span>{item.ownerId ? <Link to={`/public-profile/${item.ownerId}`}>{item.creator}</Link> : item.creator}</span></div></Card><div className="content-grid detail-columns"><Card><span className="eyebrow">{t("Access")}</span><h3>{t("Authorised digital download")}</h3><p>{t("Purchased files are listed in My Learning. Each download uses a short-lived server URL; storage keys and credentials are never exposed.")}</p><DisclosureList item={item} /></Card><Card className="purchase-summary"><span className="eyebrow">{t("Purchase summary")}</span><div className="summary-row"><span>{t("Resource")}</span><b>{item.title}</b></div><div className="summary-row"><span>{t("Seller")}</span><b>{item.creator}</b></div><div className="summary-row"><span>{t("Price")}</span><b>{item.price}{t(" points")}</b></div>{authenticated && <div className="summary-row"><span>{t("Available balance")}</span><b>{balance}{t(" points")}</b></div>}{item.purchased ? <Link className="button secondary wide" to="/purchases">{t("Open purchased files")}</Link> : !authenticated ? <Link className="button primary wide" to="/login" state={{ from: { pathname: `/contents/${item.id}` } }}>{t("Sign in to add to cart")}</Link> : canPurchase ? <><Button className="wide" disabled={inCart || balance < item.price || !policyReady} onClick={() => addToCart("content", item.id)}><ShoppingCart size={16} /> {inCart ? t("Already in cart") : balance < item.price ? t("Insufficient balance") : !policyReady ? t("Policy unavailable") : t("Add to cart")}</Button>{!policyReady && <p className="form-error">{t("Checkout is paused until the server supplies the exact refund-policy preview.")}</p>}</> : <p className="form-error">{t("Administrator accounts cannot purchase marketplace items.")}</p>}</Card></div><ReportButton kind="content" productId={item.id} /></>;
}
