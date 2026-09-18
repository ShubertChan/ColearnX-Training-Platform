import * as api from "../api/video.js";

const abortError = () => new DOMException("Upload paused", "AbortError");
const check = signal => { if (signal?.aborted) throw abortError(); };
export const uploadStorageKey = (accountId, courseId) => `colearnx-video-upload:${accountId}:${courseId}`;
export function uploadStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}
export function readUpload(storage, key) {
  try { const saved = JSON.parse(storage.getItem(key)); return saved?.requestKey && saved?.file?.fingerprint ? saved : null; } catch { return null; }
}
export function saveUpload(storage, key, value) {
  // Keep only resumable identifiers and file metadata. Never persist signed URLs.
  try {
    if (!value) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ requestKey: value.requestKey, versionId: value.versionId, file: value.file }));
    return true;
  } catch { return false; }
}
export async function identifyVideoFile(file) {
  if (!file.size || (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name))) throw Object.assign(new Error("Choose a non-empty video file."), { code: "VIDEO_INVALID_SOURCE" });
  // Bounded file samples avoid allocating a multi-gigabyte source in memory.
  const block = 1024 * 1024;
  const samples = await Promise.all([0, Math.max(0, Math.floor(file.size / 2) - block / 2), Math.max(0, file.size - block)].map(start => file.slice(start, start + block).arrayBuffer()));
  const digest = await crypto.subtle.digest("SHA-256", await new Blob(samples).arrayBuffer());
  return { name: file.name, size: file.size, mediaType: file.type || "application/octet-stream", lastModified: file.lastModified, fingerprint: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("") };
}
export const sameVideoFile = (a, b) => a?.size === b?.size && a?.name === b?.name && a?.lastModified === b?.lastModified && a?.fingerprint === b?.fingerprint;
export function approvedUploadUrl(value, origins = import.meta.env?.VITE_UPLOAD_ORIGINS || "") {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && origins.split(",").map(s => s.trim()).includes(url.origin) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
export function putVideoPart(signed, body, signal, onProgress) {
  return new Promise((resolve, reject) => {
    check(signal);
    const url = approvedUploadUrl(signed.url);
    if (!url) { reject(new Error("Unapproved upload origin")); return; }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error, etag) => { signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(etag); };
    xhr.open("PUT", url); xhr.timeout = 120000;
    for (const [name, value] of Object.entries(signed.headers || {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = event => onProgress(event.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) finish(null, etag);
      else finish(Object.assign(new Error("Part upload failed"), { status: xhr.status }));
    };
    xhr.onerror = xhr.ontimeout = () => finish(new Error("Part upload failed"));
    xhr.onabort = () => finish(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(body);
  });
}
export async function uploadVideo({ courseId, file, saved, signal, onSaved, onProgress, service = api, putPart = putVideoPart }) {
  check(signal);
  let upload = saved;
  if (!upload.versionId) {
    const source = upload.file ? { name: upload.file.name, size: upload.file.size, type: upload.file.mediaType } : file;
    const intent = await service.createVideoUpload(courseId, source, upload.requestKey, signal);
    if (!intent?.videoVersionId) throw new Error("Incomplete video upload intent");
    upload = { ...upload, versionId: intent.videoVersionId }; onSaved(upload);
  }
  check(signal);
  const remote = await service.listVideoParts(courseId, upload.versionId, signal);
  // The server lists ALL parts (including paginated R2 results) and fixes partSizeBytes.
  const size = remote?.partSizeBytes;
  if (!Number.isSafeInteger(size) || size < 5 * 1024 * 1024 || !Array.isArray(remote.parts) || Math.ceil(file.size / size) > 10000) throw new Error("Invalid multipart contract");
  const count = Math.ceil(file.size / size);
  const parts = new Map();
  for (const part of remote.parts) {
    if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > count || !part.etag || parts.has(part.partNumber)
      || part.sizeBytes !== Math.min(size, file.size - (part.partNumber - 1) * size)) throw new Error("Invalid remote part");
    parts.set(part.partNumber, { partNumber: part.partNumber, etag: part.etag });
  }
  let uploaded = [...parts.keys()].reduce((sum, n) => sum + Math.min(size, file.size - (n - 1) * size), 0);
  onProgress(Math.floor(uploaded / file.size * 100));
  if (!remote.completed) for (let n = 1; n <= count; n++) {
    if (parts.has(n)) continue;
    const body = file.slice((n - 1) * size, Math.min(n * size, file.size));
    for (let attempt = 0; ; attempt++) {
      check(signal);
      try {
        const signed = await service.signVideoPart(courseId, upload.versionId, n, signal);
        const etag = await putPart(signed, body, signal, loaded => onProgress(Math.min(99, Math.floor((uploaded + loaded) / file.size * 100))));
        parts.set(n, { partNumber: n, etag }); uploaded += body.size; break;
      } catch (error) {
        if (signal?.aborted || attempt >= 2 || [401, 409, 410].includes(error.status)) throw error;
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 500));
      }
    }
  }
  check(signal);
  if (!remote.completed) await service.finishVideoParts(courseId, upload.versionId, [...parts.values()].sort((a, b) => a.partNumber - b.partNumber), `${upload.requestKey}-parts`, signal);
  check(signal);
  await service.completeVideoUpload(courseId, upload.versionId, `${upload.requestKey}-verify`, signal);
  onProgress(100);
  return upload.versionId;
}
