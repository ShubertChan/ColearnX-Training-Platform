import test from "node:test";
import assert from "node:assert/strict";
import { intendedPath, cartStorageKey, readAccountCart, mergeConfirmedOrders } from "./frontendState.js";
test("login return preserves draft query and fragment", () => {
  assert.equal(intendedPath({ pathname: "/creator/content-editor", search: "?draft=123", hash: "#file" }), "/creator/content-editor?draft=123#file");
  assert.equal(intendedPath({ pathname: "//example.test" }), "/home");
});
test("cart keys isolate accounts and never restore legacy global cart", () => {
  const values = new Map([[cartStorageKey("a"), '[{"kind":"course","id":"1"}]'], ["colearnx-draft-cart-v2", '[{"kind":"course","id":"old"}]']]);
  const storage = { getItem: key => values.get(key) };
  assert.equal(readAccountCart(storage, "a").length, 1);
  assert.deepEqual(readAccountCart(storage, "b"), []);
  assert.deepEqual(readAccountCart(storage, null), []);
  assert.deepEqual(readAccountCart({ getItem() { throw Error(); } }, "a"), []);
});
test("delayed empty order lists cannot discard a confirmed purchase", () => {
  assert.deepEqual(mergeConfirmedOrders([], [{ id: "new" }]), [{ id: "new" }]);
  assert.deepEqual(mergeConfirmedOrders([{ id: "new", status: "refunded" }], [{ id: "new" }]), [{ id: "new", status: "refunded" }]);
});
