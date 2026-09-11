import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalogSection } from "./catalogState.js";

function dataset(initial = []) {
  const result = { items: initial, states: [] };
  result.options = {
    mapItem: (item) => ({ ...item, mapped: true }),
    setItems: (items) => { result.items = items; },
    setState: (state) => result.states.push(state),
  };
  return result;
}

test("catalogue failure preserves prior listings and exposes a retryable error", async () => {
  const data = dataset([{ id: "previous" }]);
  const ok = await loadCatalogSection({ ...data.options, fetchItems: async () => { throw new Error("offline"); } });
  assert.equal(ok, false);
  assert.deepEqual(data.items, [{ id: "previous" }]);
  assert.deepEqual(data.states.map((state) => state.status), ["loading", "error"]);
  assert.match(data.states.at(-1).error, /try again/i);
});

test("successful empty response is ready and clears stale listings", async () => {
  const data = dataset([{ id: "previous" }]);
  await loadCatalogSection({ ...data.options, fetchItems: async () => [] });
  assert.deepEqual(data.items, []);
  assert.deepEqual(data.states.at(-1), { status: "ready", error: "" });
});

test("retry recovers after first-load failure", async () => {
  const data = dataset();
  await loadCatalogSection({ ...data.options, fetchItems: async () => { throw new Error("timeout"); } });
  assert.equal(data.states.at(-1).status, "error");
  await loadCatalogSection({ ...data.options, fetchItems: async () => [{ id: "new" }] });
  assert.deepEqual(data.items, [{ id: "new", mapped: true }]);
  assert.deepEqual(data.states.at(-1), { status: "ready", error: "" });
});

test("one catalogue failure does not discard the other catalogue's success", async () => {
  const courses = dataset(), content = dataset();
  const result = await Promise.all([
    loadCatalogSection({ ...courses.options, fetchItems: async () => { throw new Error("503"); } }),
    loadCatalogSection({ ...content.options, fetchItems: async () => [{ id: "resource" }] }),
  ]);
  assert.deepEqual(result, [false, true]);
  assert.equal(content.items[0].id, "resource");
  assert.equal(courses.states.at(-1).status, "error");
});
