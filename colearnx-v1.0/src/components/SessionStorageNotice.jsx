import { useSyncExternalStore } from "react";
import { sessionStorageUnavailable, subscribeSessionStorage } from "../utils/sessionStorage";

export default function SessionStorageNotice() {
  const unavailable = useSyncExternalStore(subscribeSessionStorage, sessionStorageUnavailable, () => false);
  return unavailable ? <p role="status" className="session-storage-notice">Browser session storage is unavailable. You can continue in this tab, but may need to sign in again after reloading.</p> : null;
}
