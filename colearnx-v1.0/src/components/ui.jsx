import { useEffect, useId, useRef } from "react";
import { CheckCircle2, X } from "lucide-react";

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}) {
  return (
    <button className={`button ${variant} ${size} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Card({ className = "", children }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Metric({ label, value, detail, icon: Icon }) {
  return (
    <Card className="metric-card">
      <span className="metric-icon">{Icon && <Icon size={19} />}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
        {detail && <small>{detail}</small>}
      </div>
    </Card>
  );
}

export function Progress({ value, label }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="progress"
      aria-label={`${label || "Progress"}: ${clamped}%`}
    >
      <div>
        <span>{label || "Progress"}</span>
        <b>{clamped}%</b>
      </div>
      <div className="progress-track">
        <span style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <Card className="empty-state">
      {Icon && <Icon size={28} />}
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </Card>
  );
}

export function Modal({ title, children, onClose, footer }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const focusable = () => [
      ...dialog.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    focusable()[0]?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <span className="eyebrow">CoLearnX</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}

export function SuccessPanel({ title, description, children }) {
  return (
    <Card className="success-panel">
      <span className="success-icon">
        <CheckCircle2 size={34} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="button-row center">{children}</div>
    </Card>
  );
}

export function FormField({ label, hint, children }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value ?? option}
          className={(option.value ?? option) === value ? "active" : ""}
          onClick={() => onChange(option.value ?? option)}
        >
          {option.label ?? option}
        </button>
      ))}
    </div>
  );
}
