import { getFormatLocale, useTranslation } from "../i18n/LanguageContext";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  KeyRound,
  Lock,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
  Users,
} from "lucide-react";
import { getSecurityEvents, getSecuritySummary } from "../api/security";
import { Badge, Button, Card, EmptyState, Metric, Segmented } from "../components/ui";
import {
  buildTrend,
  formatEventType,
  severityLabel,
  severityTone,
} from "../utils/securityDashboard";

const SEVERITY_FILTERS = [
  { label: "All", value: 0 },
  { label: "Medium+", value: 2 },
  { label: "High+", value: 3 },
];

const PAGE_SIZE = 50;

// A step-up prompt the administrator dismissed is a choice, not a fault: show a
// calm re-entry rather than an error wall. A changed session is the same.
const isIdentityInterruption = (error) =>
  error?.code === "STEP_UP_CANCELLED" || error?.code === "SESSION_CHANGED";

function formatWhen(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getFormatLocale());
}

const shortId = (value) => (value ? `${String(value).slice(0, 8)}…` : "—");

function TrendChart({ daily }) {
  const { t } = useTranslation();
  const { peak, bars } = useMemo(() => buildTrend(daily), [daily]);
  if (!bars.length) return <p className="empty-copy">{t("No activity in this window.")}</p>;
  const first = bars[0]?.date;
  const last = bars[bars.length - 1]?.date;
  const label = `Daily security events from ${first} to ${last}; busiest day ${peak} events.`;
  return (
    <div className="sec-trend-wrap">
      <div className="sec-trend" role="img" aria-label={label}>
        {bars.map((bar) => (
          <div
            key={bar.date}
            className="sec-trend-col"
            title={t("{0}: {1} event{2}{3}", { 0: bar.date, 1: bar.total, 2: bar.total === 1 ? "" : "s", 3: bar.severe ? ` · ${bar.severe} high/critical` : "" })}
          >
            <div className="sec-trend-stack">
              {bar.routine > 0 && (
                <span className="sec-bar routine" style={{ height: `${bar.totalPct - bar.severePct}%` }} />
              )}
              {bar.severe > 0 && (
                <span className="sec-bar severe" style={{ height: `${Math.max(bar.severePct, 3)}%` }} />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="sec-trend-axis">
        <span>{first}</span>
        <span>{last}</span>
      </div>
      <div className="sec-legend">
        <span><i className="swatch routine" />{t(" Routine")}</span>
        <span><i className="swatch severe" />{t(" High / critical")}</span>
      </div>
    </div>
  );
}

export default function AdminSecurityDashboardPage() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [minSeverity, setMinSeverity] = useState(0);
  const [typeFilter, setTypeFilter] = useState("");
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const revision = useRef(0);

  const loadEvents = useCallback(async (filters) => {
    const { events: rows, hasNext, nextCursor: cursor } = await getSecurityEvents({
      minSeverity: filters.minSeverity || undefined,
      type: filters.type || undefined,
      limit: PAGE_SIZE,
    });
    return { rows, cursor: hasNext ? cursor : null };
  }, []);

  const load = useCallback(async () => {
    const request = revision.current + 1;
    revision.current = request;
    setLoading(true);
    setError("");
    setPaused(false);
    try {
      const [summaryData, eventPage] = await Promise.all([
        getSecuritySummary(),
        loadEvents({ minSeverity, type: typeFilter }),
      ]);
      if (request !== revision.current) return;
      setSummary(summaryData);
      setEvents(eventPage.rows);
      setNextCursor(eventPage.cursor);
    } catch (loadError) {
      if (request !== revision.current) return;
      if (isIdentityInterruption(loadError)) setPaused(true);
      else setError(loadError.message);
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [loadEvents, minSeverity, typeFilter]);

  // Reload the event stream (not the summary) when a filter changes.
  const reloadEvents = useCallback(async (severity, type) => {
    const request = revision.current + 1;
    revision.current = request;
    setLoading(true);
    setError("");
    try {
      const page = await loadEvents({ minSeverity: severity, type });
      if (request !== revision.current) return;
      setEvents(page.rows);
      setNextCursor(page.cursor);
    } catch (loadError) {
      if (request !== revision.current) return;
      if (isIdentityInterruption(loadError)) setPaused(true);
      else setError(loadError.message);
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [loadEvents]);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const applySeverity = (value) => { setMinSeverity(value); reloadEvents(value, typeFilter); };
  const applyType = (value) => { setTypeFilter(value); reloadEvents(minSeverity, value); };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { events: rows, hasNext, nextCursor: cursor } = await getSecurityEvents({
        minSeverity: minSeverity || undefined,
        type: typeFilter || undefined,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setEvents((current) => [...current, ...rows]);
      setNextCursor(hasNext ? cursor : null);
    } catch (loadError) {
      if (!isIdentityInterruption(loadError)) setError(loadError.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const highlights = summary?.highlights ?? {};
  const typeOptions = summary?.byType ?? [];

  if (paused) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title={t("Confirm your identity to view security telemetry")}
        description={t("The security monitor shows authentication and access-control events, so it asks for a recent second-factor check before loading.")}
        action={<Button onClick={load}>{t("Confirm and load monitor")}</Button>}
      />
    );
  }

  return (
    <>
      <section className="hero-banner">
        <div>
          <span className="eyebrow light">{t("Security monitoring")}</span>
          <h2>{t("Security event monitor")}</h2>
          <p>{t("Failed sign-ins, lockouts, denied authorisations and rate-limit hits recorded across the platform. Sources are shown as salted fingerprints, never raw addresses.")}</p>
          <div className="button-row">
            <Button variant="glass" onClick={load} disabled={loading}>
              <RefreshCw size={15} /> {loading ? t("Refreshing…") : t("Refresh")}
            </Button>
          </div>
        </div>
        <ShieldAlert size={54} />
      </section>

      {error && <p className="form-error" role="alert">{t(error)}</p>}

      {summary && (
        <p className="sec-range" role="note">{t("Window ")}{summary.range.from}{t(" to ")}{summary.range.to} · {summary.total}{t(" event")}{summary.total === 1 ? "" : t("s")} ·{" "}
          {summary.severe}{t(" high or critical")}</p>
      )}

      <div className="metric-grid three">
        <Metric label={t("Failed sign-ins")} value={highlights.failedLogins ?? 0} detail={t("auth.login_failed")} icon={KeyRound} />
        <Metric label={t("Account lockouts")} value={highlights.accountsLocked ?? 0} detail={t("Progressive, auto-releasing")} icon={Lock} />
        <Metric label={t("Rate-limit hits")} value={highlights.rateLimited ?? 0} detail={t("Throttled requests")} icon={Ban} />
        <Metric label={t("High / critical events")} value={summary?.severe ?? 0} detail={t("Severity 3 and above")} icon={AlertTriangle} />
        <Metric label={t("Breach-check outages")} value={highlights.breachUnavailable ?? 0} detail={t("HIBP failed open")} icon={ServerCrash} />
        <Metric label={t("Accounts targeted")} value={highlights.accountsTargeted ?? 0} detail={t("Distinct accounts, severity 2+")} icon={Users} />
      </div>

      <Card>
        <div className="card-heading">
          <div>
            <span className="eyebrow">{t("Activity trend")}</span>
            <h3>{t("Events per day")}</h3>
            <p>{t("Daily volume over the window, with the high and critical share called out.")}</p>
          </div>
          <Activity size={22} />
        </div>
        {summary ? <TrendChart daily={summary.daily} /> : <p role="status">{t("Loading trend…")}</p>}
      </Card>

      <Card>
        <div className="card-heading">
          <div>
            <span className="eyebrow">{t("Breakdown")}</span>
            <h3>{t("Most frequent event types")}</h3>
            <p>{t("The vocabulary firing most often in this window.")}</p>
          </div>
        </div>
        {typeOptions.length ? (
          <ul className="sec-type-list">
            {typeOptions.map((row) => (
              <li key={row.type}>
                <button type="button" className="sec-type-row" onClick={() => applyType(row.type)}>
                  <span className="sec-type-name">{formatEventType(row.type)}</span>
                  <Badge tone={severityTone(row.severity)}>{severityLabel(row.severity)}</Badge>
                  <b className="sec-type-count">{row.count}</b>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-copy">{t("No events recorded in this window.")}</p>
        )}
      </Card>

      <Card>
        <div className="card-heading">
          <div>
            <span className="eyebrow">{t("Event stream")}</span>
            <h3>{t("Recent events")}</h3>
            <p>{t("Newest first. Filter by severity, or select an event type above.")}</p>
          </div>
          <div className="sec-filters">
            <Segmented options={SEVERITY_FILTERS} value={minSeverity} onChange={applySeverity} />
            {typeFilter && (
              <Button variant="secondary" className="sm" onClick={() => applyType("")}>{t("Clear “")}{formatEventType(typeFilter)}”
              </Button>
            )}
          </div>
        </div>
        {loading ? (
          <p role="status">{t("Loading events…")}</p>
        ) : events.length ? (
          <>
            <div className="table-scroll">
              <table className="sec-table">
                <caption className="sr-only">{t("Recent security events, newest first")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("When (UTC-local)")}</th>
                    <th scope="col">{t("Event")}</th>
                    <th scope="col">{t("Severity")}</th>
                    <th scope="col">{t("Decision")}</th>
                    <th scope="col">{t("Source")}</th>
                    <th scope="col">{t("Account")}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td>{formatWhen(event.occurredAt)}</td>
                      <td><span className="sec-event-type">{formatEventType(event.type)}</span></td>
                      <td><Badge tone={severityTone(event.severity)}>{severityLabel(event.severity)}</Badge></td>
                      <td><span className={`sec-decision ${event.decision}`}>{event.decision}</span></td>
                      <td><code className="sec-source">{event.source || "—"}</code></td>
                      <td><code>{shortId(event.actorId)}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {nextCursor && (
              <div className="button-row center">
                <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t("Loading…") : t("Load more")}
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className="empty-copy">{t("No events match the current filters.")}</p>
        )}
      </Card>
    </>
  );
}
