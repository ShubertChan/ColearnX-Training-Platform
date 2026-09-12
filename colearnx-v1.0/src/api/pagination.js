import { apiClient } from "./client.js";

export async function listAllPages(path, filters = {}) {
  const items = [], seen = new Set(), cursors = new Set();
  let cursor;
  for (let page = 1; page <= 10000; page++) {
    const response = await apiClient.get(path, { params: { ...filters, page, limit: 100, ...(cursor ? { cursor } : {}) } });
    const data = response.data.data;
    const batch = Array.isArray(data) ? data : data?.items;
    if (!Array.isArray(batch)) throw new Error("The list response is incomplete. Please retry.");
    const meta = { ...response.data.meta, ...(Array.isArray(data) ? {} : data) };
    let added = 0;
    for (const item of batch) {
      const key = `${item.kind || path}:${item.id}`;
      if (!seen.has(key)) { items.push(item); seen.add(key); added++; }
    }
    const next = meta.nextCursor;
    if (next) {
      if (cursors.has(next)) throw new Error("The service repeated a page cursor. Please retry the list.");
      cursors.add(next); cursor = next; continue;
    }
    cursor = undefined;
    if (meta.hasNext === false || (meta.total != null && Number.isFinite(Number(meta.total)) && items.length >= Number(meta.total)) || (meta.hasNext !== true && (batch.length < 100 || !added))) return items;
    if (!added) throw new Error("The service did not advance to the next page.");
  }
  throw new Error("The list exceeds the supported batch size. Narrow the filters and retry.");
}
