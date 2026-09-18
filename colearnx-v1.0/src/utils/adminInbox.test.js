import test from "node:test";
import assert from "node:assert/strict";
import { inboxMessages, inboxReadKey, readInboxMarks, saveInboxMarks } from "./adminInbox.js";

test("mail from three queues uses unique IDs and exact review links, newest first", () => {
  const messages = inboxMessages({ role: [{ id: "same", requestedRole: "trainer", applicant: { displayName: "Alice" }, status: "Pending", submittedAt: "2026-09-18" }], certification: [{ id: "same", trainer: { displayName: "Bob" }, status: "pending", createdAt: "2026-09-19" }], refund: [{ id: "a/b", requester: { displayName: "Chris" }, status: "approved", requestedAt: "2026-09-17" }] });
  assert.equal(messages.length, 3);
  assert.equal(new Set(messages.map((message) => message.id)).size, 3);
  assert.equal(messages[0].sender, "Bob");
  assert.equal(messages[1].status, "pending");
  assert.equal(messages[2].href, "/admin/refunds?request=a%2Fb");
});

test("read markers are account scoped and contain IDs only", () => {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(saveInboxMarks("admin-a", ["role:1"]), true);
  assert.deepEqual(readInboxMarks("admin-a").ids, ["role:1"]);
  assert.deepEqual(readInboxMarks("admin-b").ids, []);
  assert.notEqual(inboxReadKey("admin-a"), inboxReadKey("admin-b"));
  delete globalThis.localStorage;
});

test("blocked or corrupt browser storage never stops mailbox loading", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("denied"); } });
  assert.deepEqual(readInboxMarks("admin"), { ids: [], unavailable: true });
  assert.equal(saveInboxMarks("admin", []), false);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "invalid json" } });
  assert.deepEqual(readInboxMarks("admin").ids, []);
  delete globalThis.localStorage;
});
