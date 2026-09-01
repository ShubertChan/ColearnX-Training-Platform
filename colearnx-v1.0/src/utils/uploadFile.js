export class UploadRequestError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "UploadRequestError";
    this.status = status;
  }
}

export function uploadFileToPresignedUrl({
  uploadUrl,
  file,
  requiredHeaders = {},
  onProgress = () => {},
  xhrFactory = () => new XMLHttpRequest(),
}) {
  const xhr = xhrFactory();
  const promise = new Promise((resolve, reject) => {
    xhr.open("PUT", uploadUrl, true);
    Object.entries(requiredHeaders).forEach(([name, value]) => {
      xhr.setRequestHeader(name, value);
    });
    xhr.upload.onprogress = (event) => {
      onProgress({
        lengthComputable: event.lengthComputable,
        loaded: event.loaded,
        total: event.total || file.size,
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ status: xhr.status });
      else reject(new UploadRequestError("The private upload was rejected. Request a new upload authorisation and retry.", xhr.status));
    };
    xhr.onerror = () => reject(new UploadRequestError("The network connection was interrupted during upload."));
    xhr.ontimeout = () => reject(new UploadRequestError("The private upload timed out."));
    xhr.onabort = () => {
      const error = new DOMException("Upload cancelled", "AbortError");
      reject(error);
    };
    xhr.send(file);
  });

  return { promise, abort: () => xhr.abort() };
}

export function uploadFileInLocalDemo({ file, onProgress = () => {} }) {
  let cancelled = false;
  const abort = () => {
    cancelled = true;
  };
  const promise = (async () => {
    const reader = file.stream?.().getReader?.();
    if (!reader) {
      await file.arrayBuffer();
      if (cancelled) throw new DOMException("Upload cancelled", "AbortError");
      onProgress({ lengthComputable: true, loaded: file.size, total: file.size });
      return { status: 200 };
    }
    let loaded = 0;
    while (true) {
      if (cancelled) {
        await reader.cancel();
        throw new DOMException("Upload cancelled", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      onProgress({ lengthComputable: true, loaded, total: file.size });
      await new Promise((resolve) => window.setTimeout(resolve, 24));
    }
    return { status: 200 };
  })();
  return { promise, abort };
}
