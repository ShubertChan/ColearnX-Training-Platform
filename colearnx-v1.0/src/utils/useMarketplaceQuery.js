import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { listCourses, listContent } from "../api/catalog";
import { mapCourse, mapContent } from "../context/PlatformContext";

// Keep filtered results separate from the account catalogue and cart.
export function useMarketplaceQuery(kind, fallbackItems, fallbackState, refreshFallback) {
  const [params] = useSearchParams();
  const filters = { search: params.get("q") || "", category: params.get("category") || "", trainer: params.get("trainer") || "", deliveryMode: params.get("delivery") || "", startsAfter: params.get("date") || "", contentType: params.get("type") || "", sort: params.get("sort") || "" };
  const key = JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([, value]) => value)));
  const active = key !== "{}";
  const [attempt, setAttempt] = useState(0), [remote, setRemote] = useState({ key: "", data: null, status: "loading", error: "" });
  useEffect(() => {
    if (!active) return;
    let current = true;
    setRemote((old) => ({ key, data: old.key === key ? old.data : null, status: "loading", error: "" }));
    const timer = setTimeout(async () => {
      try {
        const result = await (kind === "course" ? listCourses : listContent)(JSON.parse(key));
        if (current) setRemote({ key, data: result.map(kind === "course" ? mapCourse : mapContent), status: "ready", error: "" });
      } catch { if (current) setRemote((old) => ({ ...old, status: "error", error: "Could not refresh the filtered listings. Please retry." })); }
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [active, key, kind, attempt]);
  if (!active) return { items: fallbackItems, state: fallbackState, retry: refreshFallback };
  const state = remote.key === key ? remote : { status: "loading", error: "" };
  const ownership = new Map(fallbackItems.map((item) => [item.id, item]));
  const items = remote.key === key && remote.data ? remote.data.map((item) => ({ ...item, purchased: ownership.get(item.id)?.purchased || false })) : fallbackItems;
  return { items, state, retry: () => setAttempt((value) => value + 1) };
}
