import { useEffect, useId, useState } from "react";
import { ImagePlus } from "lucide-react";
import { apiClient, mutateApi } from "../api/client";
import { useTranslation } from "../i18n/LanguageContext";
import { Button } from "./ui";

const coverPath = (kind, id) => `/listing-covers/${kind}/${encodeURIComponent(id)}`;
export const listingCoverUrl = (kind, id) => apiClient.getUri({ url: coverPath(kind, id) });

export function ListingCoverEditor({ kind, id, hasCover, disabled, onBusy }) {
  const { t } = useTranslation();
  const [image, setImage] = useState(null);
  const [loading, setLoading] = useState(Boolean(hasCover));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const path = coverPath(kind, id);
  const inputId = useId();
  useEffect(() => {
    if (!hasCover) return;
    const controller = new AbortController();
    apiClient.get(`${path}/preview`, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setImage(data.data.image); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [hasCover, path]);

  const save = async (file) => {
    setError(""); setNotice("");
    if (file && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Choose a JPG, PNG or WebP image."); return;
    }
    if (file && (file.size === 0 || file.size > 5 * 1024 * 1024)) {
      setError("Choose an image up to 5 MB."); return;
    }
    setBusy(true); onBusy(true);
    try {
      const { data } = file
        ? await apiClient.put(path, file, { headers: { "Content-Type": file.type } })
        : await mutateApi("delete", path);
      setImage(data.data.image);
      setNotice(file ? "Cover image saved." : "Cover image removed.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false); onBusy(false);
    }
  };

  return <div className="listing-cover-editor">
    <div className="listing-cover-preview">
      {image ? <img src={image} alt={t("Listing cover preview")} /> : <ImagePlus aria-hidden="true" size={24} />}
    </div>
    <div className="listing-cover-controls">
      <div className="form-field">
        <label htmlFor={inputId}>{t("Cover image (optional)")}</label>
        <input id={inputId} aria-describedby={inputId + "-hint"} type="file"
          accept="image/jpeg,image/png,image/webp" disabled={disabled || busy || loading}
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void save(file); }} />
        <small id={inputId + "-hint"}>{t("JPG, PNG or WebP, up to 5 MB. The image is public after approval.")}</small>
      </div>
      {image && <Button type="button" variant="secondary" size="sm" disabled={disabled || busy} onClick={() => void save(null)}>{t("Remove cover")}</Button>}
      {busy && <p role="status">{t("Saving cover image…")}</p>}
      {notice && !busy && <p role="status">{t(notice)}</p>}
      {error && <p className="form-error" role="alert">{t(error)}</p>}
    </div>
  </div>;
}

export function ReviewListingCover({ kind, id }) {
  const { t } = useTranslation();
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const preview = async () => {
    setBusy(true); setError("");
    try {
      const { data } = await apiClient.get(`/admin${coverPath(kind, id)}`);
      if (!data.data.image) throw new Error("Listing cover was not found.");
      setImage(data.data.image);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <div className="listing-review-cover">
    {image ? <img src={image} alt={t("Listing cover preview")} />
      : <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void preview()}>{t("Preview cover image")}</Button>}
    {error && <p role="alert" className="form-error">{t(error)}</p>}
  </div>;
}
