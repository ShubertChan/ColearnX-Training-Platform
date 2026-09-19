let unavailable = false;
const listeners = new Set();
function blocked() {
  unavailable = true;
  listeners.forEach(listener => listener());
}
export const sessionStorageUnavailable = () => unavailable;
export const subscribeSessionStorage = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export function readSessionValue(key) {
  if (typeof window === "undefined") return "";
  try { return window.sessionStorage.getItem(key) || ""; }
  catch { blocked(); return ""; }
}
export function writeSessionValue(key, value) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch { blocked(); }
}
