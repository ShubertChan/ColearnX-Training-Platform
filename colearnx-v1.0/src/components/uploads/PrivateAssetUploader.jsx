import { useEffect, useReducer, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileUp,
  LoaderCircle,
  RefreshCw,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { Button, Modal } from "../ui";
import {
  completeUploadIntent,
  getSafeUploadError,
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
  hasReadyAsset,
  initialUploadState,
  uploadReducer,
} from "../../utils/uploadState";
import {
  uploadFileInLocalDemo,
  uploadFileToPresignedUrl,
} from "../../utils/uploadFile";

export default function PrivateAssetUploader({
  contentVersionId,
  existingAsset,
  onAssetChange,
  onStatusChange = () => {},
  disabled = false,
}) {
  const [state, dispatch] = useReducer(
    uploadReducer,
    existingAsset,
    initialUploadState,
  );
  const [dragActive, setDragActive] = useState(false);
  const [pendingReplacement, setPendingReplacement] = useState(null);
  const activeTransfer = useRef(null);
  const activeIntent = useRef(null);
  const ready = hasReadyAsset(state);

  useEffect(() => {
    onStatusChange(state.status);
  }, [onStatusChange, state.status]);

  useEffect(() => {
    if (existingAsset?.assetId !== state.asset?.assetId && !state.file) {
      dispatch({ type: "RESTORE", asset: existingAsset });
    }
  }, [existingAsset, state.asset?.assetId, state.file]);

  useEffect(
    () => () => {
      activeTransfer.current?.abort?.();
    },
    [],
  );

  const selectFile = (file, confirmed = false) => {
    if (!file) return;
    const validation = validatePrivateAsset(file);
    if (!validation.valid) {
      dispatch({ type: "FAIL", message: validation.message });
      return;
    }
    const prepared = file;
    if (ready && !confirmed) {
      setPendingReplacement(prepared);
      return;
    }
    dispatch({ type: "SELECT", file: prepared });
  };

  const reportProgress = ({ lengthComputable, loaded, total }) => {
    const progress = lengthComputable && total ? Math.round((loaded / total) * 100) : 0;
    dispatch({
      type: "PROGRESS",
      progress,
      uploadedBytes: loaded,
      totalBytes: total,
    });
  };

  const upload = async () => {
    if (!contentVersionId || !state.file || disabled) return;
    dispatch({ type: "PREPARE" });
    try {
      const intent = await requestUploadIntent(contentVersionId, state.file);
      activeIntent.current = intent;
      dispatch({ type: "UPLOAD" });
      const transfer = usingLocalUploadDemo
        ? uploadFileInLocalDemo({ file: state.file, onProgress: reportProgress })
        : uploadFileToPresignedUrl({
            uploadUrl: intent.uploadUrl,
            file: state.file,
            requiredHeaders: intent.requiredHeaders,
            onProgress: reportProgress,
          });
      activeTransfer.current = transfer;
      await transfer.promise;
      activeTransfer.current = null;
      dispatch({ type: "VERIFY" });
      const asset = await completeUploadIntent(contentVersionId, intent.assetId);
      if (asset.status !== "ready") {
        const error = new Error("The server has not verified this file yet. Refresh the draft before submitting.");
        error.code = "CONTENT_FILE_NOT_READY";
        throw error;
      }
      dispatch({ type: "READY", asset });
      onAssetChange(asset);
      activeIntent.current = null;
    } catch (error) {
      activeTransfer.current = null;
      if (error.name === "AbortError") {
        dispatch({ type: "CANCEL" });
        return;
      }
      const safe = getSafeUploadError(error);
      dispatch({ type: "FAIL", message: safe.message, requestId: safe.requestId });
    }
  };

  const cancel = async () => {
    activeTransfer.current?.abort?.();
    const intent = activeIntent.current;
    activeTransfer.current = null;
    dispatch({ type: "CANCEL" });
    if (intent?.assetId) {
      try {
        await removeUploadIntent(contentVersionId, intent.assetId);
      } catch {
        // Best-effort cleanup only. The UI remains cancelled and cannot submit.
      }
    }
    activeIntent.current = null;
  };

  const remove = async () => {
    const assetId = state.asset?.assetId;
    try {
      if (assetId) await removeUploadIntent(contentVersionId, assetId);
      dispatch({ type: "REMOVE" });
      onAssetChange(null);
    } catch (error) {
      const safe = getSafeUploadError(error);
      dispatch({ type: "FAIL", message: safe.message, requestId: safe.requestId });
    }
  };

  const busy = ["preparing", "uploading", "verifying"].includes(state.status);
  const statusText = {
    idle: "No private file selected.",
    selected: "File selected. Start upload when ready.",
    preparing: "Requesting a short-lived private upload authorisation.",
    uploading: `Uploading ${state.progress}% — ${formatBytes(state.uploadedBytes)} of ${formatBytes(state.totalBytes)}`,
    verifying: "Upload sent. The server is verifying the private object.",
    uploaded: "Uploaded and verified by the server.",
    error: state.error,
    cancelled: "Upload cancelled. Choose retry or select another file.",
  }[state.status];

  return (
    <div className={`private-uploader state-${state.status}`}>
      {usingLocalUploadDemo && (
        <div className="upload-demo-note" role="note">
          Local API simulation: the browser reads the selected bytes, but no file is sent to R2. Configure the staging API to run the real presigned PUT flow.
        </div>
      )}
      <label
        className={`upload-zone private ${dragActive ? "drag-active" : ""} ${disabled || busy ? "disabled" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled && !busy) setDragActive(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (!disabled && !busy) selectFile(event.dataTransfer.files?.[0]);
        }}
      >
        <UploadCloud size={30} />
        <div>
          <b>{state.file?.name || state.asset?.filename || "Drop a private file here"}</b>
          <p>
            {state.file || state.asset
              ? `${formatBytes(state.file?.size || state.asset?.sizeBytes)} · ${state.file ? validatePrivateAsset(state.file).mediaType : state.asset?.mediaType}`
              : "PDF, ZIP, JPEG, PNG, WebP or MP4 · maximum 100 MiB"}
          </p>
        </div>
        <span className="button secondary">
          {ready ? "Replace file" : "Choose file"}
        </span>
        <input
          className="visually-hidden"
          type="file"
          accept={PRIVATE_ASSET_ACCEPT}
          disabled={disabled || busy}
          onChange={(event) => {
            selectFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </label>

      <div className="upload-status" aria-live="polite">
        <span className={`upload-status-icon ${state.status}`}>
          {state.status === "uploaded" ? (
            <CheckCircle2 size={19} />
          ) : state.status === "error" ? (
            <AlertCircle size={19} />
          ) : busy ? (
            <LoaderCircle className="spin" size={19} />
          ) : state.status === "cancelled" ? (
            <X size={19} />
          ) : (
            <FileUp size={19} />
          )}
        </span>
        <div>
          <b>{state.status === "uploaded" ? "Private asset ready" : "Upload status"}</b>
          <p>{statusText}</p>
          {state.requestId && (
            <small>Request ID: <code>{state.requestId}</code></small>
          )}
          {state.previousAsset?.status === "ready" && state.status !== "uploaded" && (
            <small>The existing verified file remains active until replacement succeeds.</small>
          )}
        </div>
      </div>

      {state.status === "uploading" && (
        <div
          className="upload-progress"
          role="progressbar"
          aria-label="Private file upload progress"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={state.progress}
        >
          <span style={{ width: `${state.progress}%` }} />
        </div>
      )}

      <div className="button-row upload-actions">
        {state.status === "selected" && (
          <Button type="button" onClick={upload} disabled={!contentVersionId || disabled}>
            <UploadCloud size={16} /> Upload private file
          </Button>
        )}
        {state.status === "uploading" && (
          <Button type="button" variant="danger" onClick={cancel}>
            <X size={16} /> Cancel upload
          </Button>
        )}
        {["error", "cancelled"].includes(state.status) && state.file && (
          <Button type="button" onClick={upload} disabled={!contentVersionId || disabled}>
            <RefreshCw size={16} /> Retry with new authorisation
          </Button>
        )}
        {ready && (
          <Button type="button" variant="danger" onClick={remove} disabled={disabled}>
            <Trash2 size={16} /> Remove file
          </Button>
        )}
      </div>
      {!contentVersionId && (
        <small className="upload-gate-note">Save the content draft before choosing a private file.</small>
      )}

      {pendingReplacement && (
        <Modal
          title="Replace the verified file?"
          onClose={() => setPendingReplacement(null)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setPendingReplacement(null)}>
                Keep current file
              </Button>
              <Button type="button"
                onClick={() => {
                  selectFile(pendingReplacement, true);
                  setPendingReplacement(null);
                }}
              >
                Replace with {pendingReplacement.name}
              </Button>
            </>
          }
        >
          <p>
            <b>{state.asset?.filename}</b> remains available until the new file is uploaded and verified. A failed replacement will not remove the current file.
          </p>
        </Modal>
      )}
    </div>
  );
}
