import { useTranslation } from "../../i18n/LanguageContext";
import { useId, useState } from "react";
import { UploadCloud } from "lucide-react";

export default function UploadDropzone({ onFiles, inputLabel, accept, hint, multiple = true, disabled = false, describedBy = "", title = "Drop files here", buttonLabel = "Choose files" }) {
  const { t } = useTranslation();
  const [dragActive, setDragActive] = useState(false);
  const hintId = useId();
  return <label
    className={`upload-zone private ${dragActive ? "drag-active" : ""} ${disabled ? "disabled" : ""}`}
    onDragEnter={event => { event.preventDefault(); if (!disabled) setDragActive(true); }}
    onDragOver={event => event.preventDefault()}
    onDragLeave={event => { event.preventDefault(); setDragActive(false); }}
    onDrop={event => {
      event.preventDefault(); setDragActive(false);
      if (!disabled) onFiles(event.dataTransfer.files);
    }}
  >
    <UploadCloud size={30} aria-hidden="true" />
    <div><b>{t(title)}</b><p id={hintId}>{t(hint)}</p></div>
    <span className="button secondary">{t(buttonLabel)}</span>
    <input className="visually-hidden" aria-label={t(inputLabel)} aria-describedby={`${hintId} ${describedBy}`.trim()}
      type="file" accept={accept} multiple={multiple} disabled={disabled}
      onChange={event => { onFiles(event.target.files); event.target.value = ""; }} />
  </label>;
}
