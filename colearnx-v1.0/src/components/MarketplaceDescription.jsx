import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";
import { useTranslation } from "../i18n/LanguageContext";

export default function MarketplaceDescription({ text }) {
  const { t } = useTranslation();
  const id = useId();
  const previewRef = useRef(null);
  const toggleRef = useRef(null);
  const fullRef = useRef(null);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const measure = () => {
      const overflows = preview.scrollHeight > preview.clientHeight + 1;
      setTruncated(overflows);
      if (!overflows) setExpanded(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [text]);

  useLayoutEffect(() => {
    if (expanded) fullRef.current.scrollTop = 0;
  }, [expanded, text]);

  return <div className="marketplace-description" data-expanded={expanded}
    onPointerEnter={(event) => { if (truncated && event.pointerType !== "touch") setExpanded(true); }}
    onPointerLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setExpanded(false); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && expanded) {
        event.preventDefault();
        setExpanded(false);
        toggleRef.current?.focus();
      }
    }}>
    <p ref={previewRef} className="marketplace-description-preview" aria-hidden={expanded}>{text}</p>
    {truncated && <button ref={toggleRef} type="button" className="marketplace-description-toggle"
      aria-label={t("Read full description")} aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded((value) => !value)}><ChevronUp size={16} /></button>}
    <div ref={fullRef} id={id} className="marketplace-description-full" role="region" aria-label={t("Full description")}
      hidden={!expanded} tabIndex={expanded ? 0 : -1}><p>{text}</p></div>
  </div>;
}
