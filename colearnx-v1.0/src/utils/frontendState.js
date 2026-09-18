export function intendedPath(location, fallback = "/home") {
  if (!location?.pathname?.startsWith("/") || location.pathname.startsWith("//")) return fallback;
  return `${location.pathname}${location.search || ""}${location.hash || ""}`;
}

export function cartStorageKey(accountId) {
  return accountId ? `colearnx-cart-v3:${encodeURIComponent(accountId)}` : null;
}

export function readAccountCart(storage, accountId) {
  const key = cartStorageKey(accountId);
  if (!key) return [];
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    const seen = new Set();
    return (Array.isArray(value) ? value : []).filter((item) => {
      if (!["course", "content"].includes(item?.kind) || typeof item.id !== "string" || !item.id) return false;
      const identity = `${item.kind}:${item.id}`;
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    });
  } catch { return []; }
}

export function mergeConfirmedOrders(serverOrders, confirmedOrders) {
  const ids = new Set(serverOrders.map((order) => order.id));
  return [...confirmedOrders.filter((order) => !ids.has(order.id)), ...serverOrders];
}
