import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  FileUp,
  LoaderCircle,
  RefreshCw,
  UploadCloud,
  X,
} from "lucide-react";
import {
  completeUploadIntent,
  getSafeUploadError,
  listContentAssets,
  removeUploadIntent,
  requestUploadIntent,
  usingLocalUploadDemo,
} from "../../api/uploads";
import {
  formatBytes,
  PRIVATE_ASSET_ACCEPT,
  validatePrivateAsset,
} from "../../utils/uploadPolicy";
import {
  uploadFileInLocalDemo,
  uploadFileToPresignedUrl,
} from "../../utils/uploadFile";

const activeStatuses = new Set(["preparing", "uploading", "verifying", "deleting"]);

function localItem(file, validation) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${file.name}-${Date.now()}-${Math.random()}`,
    file,
    assetId: "",
    filename: file.name,
    mediaType: validation.mediaType,
    sizeBytes: file.size,
    status: "queued",
    progress: 0,
    error: "",
  };
}

function remoteItem(asset) {
  return {
    id: asset.assetId,
    file: null,
    assetId: asset.assetId,
    filename: asset.filename,
    mediaType: asset.mediaType,
    sizeBytes: asset.sizeBytes,
    status: asset.status === "ready" ? "ready" : "interrupted",
    progress: asset.status === "ready" ? 100 : 0,
    error: asset.status === "ready" ? "" : "This earlier upload did not finish. Remove it, then add the file again.",
  };
}

function itemMessage(item, contentVersionId) {
  if (item.status === "queued") {
    return contentVersionId ? "Waiting to upload." : "Will upload automatically after you create the content.";
  }
  if (item.status === "preparing") return "Preparing upload…";
  if (item.status === "uploading") return `Uploading ${item.progress}%`;
  if (item.status === "verifying") return "Checking file…";
  if (item.status === "ready") return "Uploaded";
  if (item.status === "deleting") return "Removing file…";
  return item.error || "Upload needs attention.";
}

function ItemIcon({ item }) {
  if (item.status === "ready") return <CheckCircle2 aria-hidden="true" size={20} />;
  if (item.status === "error" || item.status === "interrupted") return <AlertCircle aria-hidden="true" size={20} />;
  if (activeStatuses.has(item.status)) return <LoaderCircle className="spin" aria-hidden="true" size={20} />;
  if (item.status === "queued") return <Clock3 aria-hidden="true" size={20} />;
  return <FileUp aria-hidden="true" size={20} />;
}

export default function PrivateAssetUploader({
  contentVersionId,
  onAssetsChange = () => {},
  disabled = false,
}) {
  const [items, setItems] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const itemsRef = useRef(items);
  const activeTransfer = useRef(null);
  const cancelledIds = useRef(new Set());

  useEffect(() => {
    itemsRef.current = items;
    const readyCount = items.filter((item) => item.status === "ready").length;
    const activeCount = items.filter((item) => activeStatuses.has(item.status)).length;
    onAssetsChange({ readyCount, activeCount });
  }, [items, onAssetsChange]);

  useEffect(
    () => () => {
      activeTransfer.current?.transfer?.abort?.();
    },
    [],
  );

  useEffect(() => {
    if (!contentVersionId) return undefined;
    let current = true;
    listContentAssets(contentVersionId)
      .then((assets) => {
        if (!current) return;
        setItems((existing) => {
          const byAssetId = new Map(existing.filter((item) => item.assetId).map((item) => [item.assetId, item]));
          const restored = assets.map((asset) => {
            const local = byAssetId.get(asset.assetId);
            return local && activeStatuses.has(local.status) ? local : remoteItem(asset);
          });
          const staged = existing.filter((item) => !item.assetId);
          return [...restored, ...staged];
        });
      })
      .catch(() => {
        // The upload itself will surface a clear error if the service remains unavailable.
      });
    return () => {
      current = false;
    };
  }, [contentVersionId]);

  const patchItem = (id, patch) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const cleanupIntent = async (assetId) => {
    if (!contentVersionId || !assetId) return;
    try {
      await removeUploadIntent(contentVersionId, assetId);
    } catch {
      // The server-side reconciler will retry a deletion that cannot complete now.
    }
  };

  const uploadQueuedItem = async (id) => {
    if (!contentVersionId || disabled || activeTransfer.current) return;
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item?.file || item.status !== "queued") return;

    const active = { id, intent: null, transfer: null };
    activeTransfer.current = active;
    patchItem(id, { status: "preparing", error: "", progress: 0 });
    try {
      const intent = await requestUploadIntent(contentVersionId, item.file);
      active.intent = intent;
      if (cancelledIds.current.has(id)) {
        await cleanupIntent(intent.assetId);
        return;
      }
      patchItem(id, { assetId: intent.assetId, status: "uploading" });
      const transfer = usingLocalUploadDemo
        ? uploadFileInLocalDemo({
            file: item.file,
            onProgress: ({ loaded, total }) => patchItem(id, {
              progress: total ? Math.round((loaded / total) * 100) : 0,
            }),
          })
        : uploadFileToPresignedUrl({
            uploadUrl: intent.uploadUrl,
            file: item.file,
            requiredHeaders: intent.requiredHeaders,
            onProgress: ({ loaded, total }) => patchItem(id, {
              progress: total ? Math.round((loaded / total) * 100) : 0,
            }),
          });
      active.transfer = transfer;
      await transfer.promise;
      if (cancelledIds.current.has(id)) return;
      patchItem(id, { status: "verifying", progress: 100 });
      const asset = await completeUploadIntent(contentVersionId, intent.assetId);
      if (asset.status !== "ready") throw new Error("The file could not be verified. Choose it again and retry.");
      patchItem(id, {
        file: null,
        assetId: asset.assetId,
        filename: asset.filename,
        mediaType: asset.mediaType,
        sizeBytes: asset.sizeBytes,
        status: "ready",
        progress: 100,
      });
    } catch (error) {
      if (active.intent?.assetId) await cleanupIntent(active.intent.assetId);
      if (!cancelledIds.current.has(id)) {
        const safe = getSafeUploadError(error);
        patchItem(id, { status: "error", error: safe.message, progress: 0 });
      }
    } finally {
      cancelledIds.current.delete(id);
      if (activeTransfer.current?.id === id) activeTransfer.current = null;
      setItems((current) => [...current]);
    }
  };

  useEffect(() => {
    if (!contentVersionId || disabled || activeTransfer.current) return;
    const next = items.find((item) => item.status === "queued" && item.file);
    if (next) void uploadQueuedItem(next.id);
  }, [contentVersionId, disabled, items]);

  const addFiles = (fileList) => {
    if (disabled) return;
    const nextItems = Array.from(fileList || []).map((file) => {
      const validation = validatePrivateAsset(file);
      if (validation.valid) return localItem(file, validation);
      return {
        id: globalThis.crypto?.randomUUID?.() || `${file.name}-${Date.now()}-${Math.random()}`,
        file: null,
        assetId: "",
        filename: file.name,
        mediaType: file.type || "Unknown type",
        sizeBytes: file.size,
        status: "error",
        progress: 0,
        error: validation.message,
      };
    });
    if (nextItems.length) setItems((current) => [...current, ...nextItems]);
  };

  const removeItem = async (id) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    if (activeTransfer.current?.id === id) {
      cancelledIds.current.add(id);
      activeTransfer.current.transfer?.abort?.();
      setItems((current) => current.filter((candidate) => candidate.id !== id));
      return;
    }
    if (!item.assetId || !contentVersionId) {
      setItems((current) => current.filter((candidate) => candidate.id !== id));
      return;
    }
    patchItem(id, { status: "deleting", error: "" });
    try {
      await removeUploadIntent(contentVersionId, item.assetId);
      setItems((current) => current.filter((candidate) => candidate.id !== id));
    } catch (error) {
      patchItem(id, { status: "error", error: getSafeUploadError(error).message });
    }
  };

  const retryItem = (id) => {
    patchItem(id, { assetId: "", status: "queued", error: "", progress: 0 });
  };

  const hasQueuedFiles = items.some((item) => item.status === "queued");

  return (
    <section className="private-uploader" aria-label="Content files">
      <label
        className={`upload-zone private ${dragActive ? "drag-active" : ""} ${disabled ? "disabled" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        <UploadCloud size={30} aria-hidden="true" />
        <div>
          <b>Drop files here</b>
          <p>PDF, DOCX, ZIP and images up to 25 MiB · MP4 up to 100 MiB · 500 MiB total</p>
        </div>
        <span className="button secondary">Choose files</span>
        <input
          className="visually-hidden"
          type="file"
          accept={PRIVATE_ASSET_ACCEPT}
          multiple
          disabled={disabled}
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </label>

      {!contentVersionId && hasQueuedFiles && (
        <small className="upload-gate-note">Files will start uploading automatically when you create the content.</small>
      )}

      <div className="upload-file-list" aria-live="polite">
        {items.map((item) => (
          <article className={`upload-file-row ${item.status}`} key={item.id}>
            <span className={`upload-file-icon ${item.status}`}><ItemIcon item={item} /></span>
            <div className="upload-file-main">
              <b>{item.filename}</b>
              <small>{formatBytes(item.sizeBytes)} · {item.mediaType}</small>
              <span className="upload-file-message">{itemMessage(item, contentVersionId)}</span>
              {item.status === "uploading" && (
                <div className="upload-progress" role="progressbar" aria-label={`${item.filename} upload progress`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={item.progress}>
                  <span style={{ width: `${item.progress}%` }} />
                </div>
              )}
            </div>
            {item.status === "error" && item.file && contentVersionId && (
              <button className="asset-icon-action retry" type="button" onClick={() => retryItem(item.id)} aria-label={`Retry ${item.filename}`} title="Retry upload">
                <RefreshCw size={17} />
              </button>
            )}
            <button className="asset-icon-action remove" type="button" disabled={item.status === "deleting"} onClick={() => void removeItem(item.id)} aria-label={`Remove ${item.filename}`} title="Remove file">
              <X size={18} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}