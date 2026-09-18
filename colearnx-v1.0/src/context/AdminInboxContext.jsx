import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { listAllPages } from "../api/pagination";
import { inboxMessages, inboxSources, inboxReadKey, readInboxMarks, saveInboxMarks } from "../utils/adminInbox";
import { usePlatform } from "./PlatformContext";

const emptyInbox = { messages: [], unreadCount: 0, errors: [], loading: false, arrivalCount: 0, refresh: () => {}, markRead: () => {}, markAllRead: () => {}, dismissArrival: () => {} };
const AdminInboxContext = createContext(emptyInbox);
export const useAdminInbox = () => useContext(AdminInboxContext);

export function AdminInboxProvider({ children }) {
  const { authenticated, role, profile } = usePlatform();
  return authenticated && role === "Admin" && profile.id
    ? <AccountInbox key={profile.id} accountId={profile.id}>{children}</AccountInbox>
    : <AdminInboxContext.Provider value={emptyInbox}>{children}</AdminInboxContext.Provider>;
}

function AccountInbox({ accountId, children }) {
  const [queues, setQueues] = useState({});
  const [marks, setMarks] = useState(() => readInboxMarks(accountId));
  const marksRef = useRef(marks.ids);
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [arrivalCount, setArrivalCount] = useState(0);
  const refreshRef = useRef(() => {});
  const messages = useMemo(() => inboxMessages(queues).map((message) => ({ ...message, unread: message.status === "pending" && !marks.ids.includes(message.id) })), [queues, marks.ids]);

  useEffect(() => {
    let disposed = false, running = false;
    const controller = new AbortController();
    const known = new Set(), initialized = new Set();
    const refresh = async () => {
      if (disposed || running || document.visibilityState === "hidden") return;
      running = true; setLoading(true);
      try {
        const results = await Promise.allSettled(inboxSources.map((source) => listAllPages(source.path, {}, { signal: controller.signal })));
        if (disposed) return;
        const updates = {}, failures = [];
        let arrivals = 0;
        results.forEach((result, index) => {
          const source = inboxSources[index];
          if (result.status === "rejected") { failures.push(source.label); return; }
          updates[source.kind] = result.value;
          inboxMessages({ [source.kind]: result.value }).forEach((message) => {
            if (initialized.has(source.kind) && !known.has(message.id) && message.status === "pending" && !marksRef.current.includes(message.id)) arrivals++;
            known.add(message.id);
          });
          initialized.add(source.kind);
        });
        setQueues((previous) => ({ ...previous, ...updates }));
        setErrors(failures);
        if (arrivals) setArrivalCount((count) => count + arrivals);
      } finally { running = false; if (!disposed) setLoading(false); }
    };
    refreshRef.current = refresh;
    void refresh();
    const interval = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true; controller.abort(); window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      refreshRef.current = () => {};
    };
  }, [accountId]);

  useEffect(() => {
    const update = (event) => {
      if (event.key !== inboxReadKey(accountId) && event.key !== null) return;
      const next = readInboxMarks(accountId); marksRef.current = next.ids; setMarks(next);
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [accountId]);

  const markRead = useCallback((ids) => {
    // Merge other tabs' marks before writing; only opaque IDs are persisted.
    const merged = [...new Set([...readInboxMarks(accountId).ids, ...marksRef.current, ...ids])];
    marksRef.current = merged;
    setMarks({ ids: merged, unavailable: !saveInboxMarks(accountId, merged) });
  }, [accountId]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return <AdminInboxContext.Provider value={{ messages, unreadCount: messages.filter((message) => message.unread).length,
    loading, errors, arrivalCount, storageUnavailable: marks.unavailable, refresh, markRead,
    markAllRead: () => markRead(messages.map((message) => message.id)), dismissArrival: () => setArrivalCount(0),
  }}>{children}</AdminInboxContext.Provider>;
}
