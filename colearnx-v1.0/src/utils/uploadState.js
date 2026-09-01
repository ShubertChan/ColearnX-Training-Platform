export const initialUploadState = (asset = null) => ({
  status: asset?.status === "ready" ? "uploaded" : "idle",
  file: null,
  asset: asset?.status === "ready" ? asset : null,
  previousAsset: null,
  progress: 0,
  uploadedBytes: 0,
  totalBytes: 0,
  error: "",
  requestId: "",
});

export function uploadReducer(state, action) {
  switch (action.type) {
    case "RESTORE":
      return initialUploadState(action.asset);
    case "SELECT":
      return {
        ...initialUploadState(),
        status: "selected",
        file: action.file,
        totalBytes: action.file.size,
        previousAsset:
          state.asset?.status === "ready" ? state.asset : state.previousAsset,
      };
    case "PREPARE":
      return { ...state, status: "preparing", error: "", requestId: "" };
    case "UPLOAD":
      return { ...state, status: "uploading", progress: 0, uploadedBytes: 0 };
    case "PROGRESS":
      return {
        ...state,
        progress: action.progress,
        uploadedBytes: action.uploadedBytes,
        totalBytes: action.totalBytes || state.totalBytes,
      };
    case "VERIFY":
      return { ...state, status: "verifying", progress: 100 };
    case "READY":
      return {
        ...initialUploadState(action.asset),
        status: "uploaded",
        progress: 100,
        uploadedBytes: action.asset.sizeBytes,
        totalBytes: action.asset.sizeBytes,
      };
    case "FAIL":
      return {
        ...state,
        status: "error",
        asset: state.previousAsset || state.asset,
        error: action.message,
        requestId: action.requestId || "",
      };
    case "CANCEL":
      return {
        ...state,
        status: "cancelled",
        asset: state.previousAsset || state.asset,
        error: "",
        requestId: "",
      };
    case "REMOVE":
      return initialUploadState();
    default:
      return state;
  }
}

export const hasReadyAsset = (state) => state.asset?.status === "ready";
