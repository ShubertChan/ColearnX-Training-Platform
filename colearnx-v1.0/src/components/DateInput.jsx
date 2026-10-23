import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "../i18n/LanguageContext";
import { calendarDay, dateInputError, displayDateInput, localToday, monthDays, normalizeDateInput, shiftCalendarDay, shiftCalendarMonth, utcCalendarDate } from "../utils/dateInput";
import { Button, Modal } from "./ui";
import "../styles/date-input.css";

export default function DateInput({ type = "date", value = "", onChange, onValidityChange, min = "", max = "", disabled = false, required = false, ...props }) {
  const { t, language } = useTranslation();
  const withTime = type === "datetime-local";
  const [draft, setDraft] = useState(() => displayDateInput(value));
  const [open, setOpen] = useState(false), [touched, setTouched] = useState(false);
  const input = useRef(null), lastValue = useRef(value);
  const errorId = useId();
  const feedback = required && !draft.trim() ? t(withTime ? "Choose a date and time." : "Choose a date.") : t(dateInputError(draft, { withTime, min, max }));
  useEffect(() => {
    if (value !== lastValue.current) { lastValue.current = value; setDraft(displayDateInput(value)); }
  }, [value]);
  useEffect(() => { input.current?.setCustomValidity(feedback); }, [feedback]);
  useEffect(() => { onValidityChange?.(disabled || !feedback); }, [disabled, feedback, onValidityChange]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const commit = next => {
    lastValue.current = next;
    onChange?.({ target: { value: next, name: props.name, id: props.id } });
  };
  const pick = next => { setDraft(displayDateInput(next)); setTouched(false); commit(next); setOpen(false); };
  return <span className="date-input" lang={language}>
    <span className="date-input-control">
      <input {...props} ref={input} type="text" inputMode="text" autoComplete="off"
        value={draft} disabled={disabled} required={required}
        placeholder={t(withTime ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD")}
        aria-invalid={Boolean(touched && feedback)} aria-describedby={[props["aria-describedby"], touched && feedback ? errorId : ""].filter(Boolean).join(" ") || undefined}
        onChange={event => {
          const text = event.target.value; setDraft(text);
          const next = normalizeDateInput(text, withTime);
          if (next !== null && !dateInputError(text, { withTime, min, max })) commit(next);
        }}
        onBlur={() => { setTouched(true); const next = normalizeDateInput(draft, withTime); if (next !== null) setDraft(displayDateInput(next)); }}
        onKeyDown={event => { if (event.key === "ArrowDown" && event.altKey) { event.preventDefault(); setOpen(true); } }} />
      <button className="date-input-toggle" type="button" disabled={disabled} aria-label={t("Open calendar")}
        aria-haspopup="dialog" aria-expanded={open} onClick={event => { event.preventDefault(); setOpen(true); }}><CalendarDays size={18} aria-hidden="true" /></button>
    </span>
    {touched && feedback && <small id={errorId} className="date-input-error" role="alert">{feedback}</small>}
    {open && createPortal(<CalendarPicker value={normalizeDateInput(draft, withTime) || normalizeDateInput(value, withTime) || ""} withTime={withTime} min={min} max={max} onPick={pick} onClose={() => setOpen(false)} />, document.body)}
  </span>;
}

function CalendarPicker({ value, withTime, min, max, onPick, onClose }) {
  const { t, formatLocale, language } = useTranslation();
  const today = localToday();
  const seed = (value || today).slice(0, 10);
  const bounded = seed < min.slice(0, 10) ? min.slice(0, 10) : max && seed > max.slice(0, 10) ? max.slice(0, 10) : seed;
  const [selected, setSelected] = useState(bounded);
  const [time, setTime] = useState(value?.slice(11, 16) || "00:00");
  const [view, setView] = useState(() => bounded.slice(0, 7));
  const [cursor, setCursor] = useState(bounded);
  const [year, month] = view.split("-").map(Number);
  const grid = useRef(null), keyboardFocus = useRef(false);
  const dateFormat = new Intl.DateTimeFormat(formatLocale, { dateStyle: "full", timeZone: "UTC" });
  const monthFormat = new Intl.DateTimeFormat(formatLocale, { month: "long", timeZone: "UTC" });
  const weekdayFormat = new Intl.DateTimeFormat(formatLocale, { weekday: "short", timeZone: "UTC" });
  const allowed = day => /^\d{4}-/.test(day) && day.slice(0, 4) !== "0000" && (!min || day >= min.slice(0, 10)) && (!max || day <= max.slice(0, 10));
  const selectedValue = `${selected}${withTime ? `T${time}` : ""}`;
  const valid = !dateInputError(selectedValue, { withTime, min, max });
  const changeMonth = amount => {
    const date = utcCalendarDate(`${view}-01`); date.setUTCMonth(date.getUTCMonth() + amount);
    const next = calendarDay(date).slice(0, 7);
    if (date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999) { setView(next); setCursor(`${next}-01`); }
  };
  useEffect(() => {
    if (!keyboardFocus.current) return;
    grid.current?.querySelector(`[data-date="${cursor}"]`)?.focus();
    keyboardFocus.current = false;
  }, [cursor, view]);
  const navigate = (event, day) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    let next;
    if (offset !== undefined) next = shiftCalendarDay(day, offset);
    else if (event.key === "Home") next = shiftCalendarDay(day, -(utcCalendarDate(day).getUTCDay() + 6) % 7);
    else if (event.key === "End") next = shiftCalendarDay(day, 6 - (utcCalendarDate(day).getUTCDay() + 6) % 7);
    else if (event.key === "PageUp" || event.key === "PageDown") next = shiftCalendarMonth(day, event.key === "PageUp" ? -1 : 1);
    else return;
    event.preventDefault();
    if (allowed(next)) { keyboardFocus.current = true; setCursor(next); setView(next.slice(0, 7)); }
  };
  return <div className="calendar-overlay" lang={language}><Modal title={t(withTime ? "Choose date and time" : "Choose date")} onClose={onClose}
    footer={<><Button type="button" variant="secondary" onClick={() => onPick("")}>{t("Clear date")}</Button><Button type="button" disabled={!valid} onClick={() => onPick(selectedValue)}>{t("Apply date")}</Button></>}>
    <div className="calendar-month">
      <button type="button" className="icon-button" aria-label={t("Previous month")} disabled={view === "0001-01"} onClick={() => changeMonth(-1)}><ChevronLeft size={18} /></button>
      <select aria-label={t("Calendar month")} value={month} onChange={event => { const next = `${String(year).padStart(4, "0")}-${String(event.target.value).padStart(2, "0")}`; setView(next); setCursor(`${next}-01`); }}>
        {Array.from({ length: 12 }, (_, index) => <option key={index} value={index + 1}>{monthFormat.format(utcCalendarDate(`2000-${String(index + 1).padStart(2, "0")}-01`))}</option>)}
      </select>
      <input type="number" aria-label={t("Calendar year")} min={1} max={9999} value={year} onChange={event => {
        const nextYear = Number(event.target.value);
        if (Number.isInteger(nextYear) && nextYear >= 1 && nextYear <= 9999) { const next = `${String(nextYear).padStart(4, "0")}-${String(month).padStart(2, "0")}`; setView(next); setCursor(`${next}-01`); }
      }} />
      <button type="button" className="icon-button" aria-label={t("Next month")} disabled={view === "9999-12"} onClick={() => changeMonth(1)}><ChevronRight size={18} /></button>
    </div>
    <div className="calendar-weekdays" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index}>{weekdayFormat.format(utcCalendarDate(shiftCalendarDay("2024-01-01", index)))}</span>)}</div>
    <div className="calendar-grid" role="grid" aria-label={monthFormat.format(utcCalendarDate(`${view}-01`)) + " " + year} ref={grid}>
      {Array.from({ length: 6 }, (_, week) => <div role="row" key={week}>{monthDays(year, month).slice(week * 7, week * 7 + 7).map(day => <span role="gridcell" key={day} aria-selected={selected === day}>
        <button type="button" data-date={day} disabled={!allowed(day)} tabIndex={cursor === day ? 0 : -1}
          aria-label={allowed(day) ? dateFormat.format(utcCalendarDate(day)) : undefined} aria-current={day === today ? "date" : undefined}
          className={`${day.slice(0, 7) === view ? "" : "outside-month"} ${selected === day ? "selected" : ""}`}
          onKeyDown={event => navigate(event, day)} onClick={() => { setSelected(day); setCursor(day); setView(day.slice(0, 7)); }}>{Number(day.slice(-2))}</button>
      </span>)}</div>)}
    </div>
    <div className="calendar-bottom"><button type="button" className="link-button" disabled={!allowed(today)} onClick={() => { setSelected(today); setCursor(today); setView(today.slice(0, 7)); }}>{t("Today")}</button><output aria-live="polite">{selected}</output></div>
    {withTime && <label className="calendar-time"><span>{t("Time (24-hour)")}</span><input type="text" value={time} placeholder={t("HH:mm")} onChange={event => setTime(event.target.value)} /></label>}
  </Modal></div>;
}
