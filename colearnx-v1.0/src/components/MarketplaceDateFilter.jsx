import { useId, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Modal } from "./ui";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parseDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) || dateKey(date) !== value ? null : date;
};

export default function MarketplaceDateFilter({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => parseDate(value) || new Date());
  const headingId = useId();
  const selected = parseDate(value);
  const label = selected ? selected.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Starts on or after";
  const monthLabel = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const start = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const choose = (date) => { onChange(date ? dateKey(date) : ""); setOpen(false); };

  return <>
    <button type="button" className="market-date-filter" aria-label={`Starts on or after${selected ? `: ${label}` : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setMonth(selected || new Date()); setOpen(true); }}>
      <span>{label}</span><CalendarDays size={17} aria-hidden="true" />
    </button>
    {open && <Modal title="Choose a start date" onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => choose(null)}>Clear date</Button><Button onClick={() => choose(new Date())}>Today</Button></>}>
      <div className="market-calendar" lang="en">
        <p>Show courses starting on or after the selected date.</p>
        <div className="market-calendar-heading">
          <button type="button" className="icon-button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={18} /></button>
          <b id={headingId} aria-live="polite">{monthLabel}</b>
          <button type="button" className="icon-button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={18} /></button>
        </div>
        <div className="market-calendar-grid" role="group" aria-labelledby={headingId}>
          {weekdays.map(day => <span className="calendar-weekday" key={day}>{day}</span>)}
          {Array.from({ length: start }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
          {Array.from({ length: count }, (_, index) => {
            const date = new Date(month.getFullYear(), month.getMonth(), index + 1);
            const key = dateKey(date);
            return <button type="button" key={key} className={`calendar-day${key === value ? " selected" : ""}`} aria-label={date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} aria-pressed={key === value} aria-current={key === dateKey(new Date()) ? "date" : undefined} onClick={() => choose(date)}>{index + 1}</button>;
          })}
        </div>
      </div>
    </Modal>}
  </>;
}
