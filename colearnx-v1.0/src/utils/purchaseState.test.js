import assert from "node:assert/strict";
import test from "node:test";
import { decoratePurchasedItems, purchaseMetadataByProduct } from "./purchaseState.js";

const catalog = [{ id: "course-1", title: "Course", purchased: true, orderId: "old-order" }];
const order = (id, status, paidAt = "2026-09-01T00:00:00.000Z") => ({ id, paidAt, items: [{ id: `${id}-item`, kind: "course", productId: "course-1", fulfilmentStatus: status }] });

test("an empty current account order set clears stale Purchased metadata", () => {
  assert.deepEqual(decoratePurchasedItems(catalog, purchaseMetadataByProduct([], "course")), [{ id: "course-1", title: "Course", purchased: false }]);
});

test("catalog data stays unowned when a different account has no active orders", () => {
  const previousAccount = decoratePurchasedItems(catalog, purchaseMetadataByProduct([order("old", "fulfilled")], "course"));
  const nextAccount = decoratePurchasedItems(previousAccount, purchaseMetadataByProduct([], "course"));
  assert.equal(nextAccount[0].purchased, false);
  assert.equal(nextAccount[0].orderId, undefined);
});

test("any active order item owns a product while all refunded items do not", () => {
  const active = decoratePurchasedItems(catalog, purchaseMetadataByProduct([order("older", "refunded"), order("newer", "fulfilled", "2026-09-02T00:00:00.000Z")], "course"));
  const refunded = decoratePurchasedItems(catalog, purchaseMetadataByProduct([order("one", "refunded"), order("two", "refunded")], "course"));
  assert.equal(active[0].purchased, true);
  assert.equal(active[0].orderId, "newer");
  assert.equal(refunded[0].purchased, false);
});

test("catalog and orders may refresh in either order without retaining ownership", () => {
  const orders = [order("current", "fulfilled")];
  const beforeCatalog = decoratePurchasedItems([], purchaseMetadataByProduct(orders, "course"));
  const afterCatalog = decoratePurchasedItems([{ id: "course-1", title: "Course", purchased: false }], purchaseMetadataByProduct(orders, "course"));
  const afterOrdersClear = decoratePurchasedItems(afterCatalog, purchaseMetadataByProduct([], "course"));
  assert.deepEqual(beforeCatalog, []);
  assert.equal(afterCatalog[0].purchased, true);
  assert.equal(afterOrdersClear[0].purchased, false);
});

test("an absent fulfilment status never grants access", () => {
  assert.equal(decoratePurchasedItems(catalog, purchaseMetadataByProduct([order("legacy", undefined)], "course"))[0].purchased, false);
});
