import test from "node:test";
import assert from "node:assert/strict";
import {
  listingKindForWorkspace,
  listingsForWorkspace,
  removeListingByIdentity,
  workspaceListingCopy,
} from "./listingWorkspace.js";

const listings = [{ id: "course-1", kind: "course" }, { id: "content-1", kind: "content" }];

test("listing workspaces only show the listing type for the active role", () => {
  const snapshot = [...listings];
  assert.deepEqual(listingsForWorkspace(listings, "Trainer"), [listings[0]]);
  assert.deepEqual(listingsForWorkspace(listings, "Creator"), [listings[1]]);
  assert.deepEqual(listingsForWorkspace(listings, "Member"), []);
  assert.equal(listingKindForWorkspace("Admin"), null);
  assert.deepEqual(listings, snapshot);
});

test("listing workspace copy names the active catalogue", () => {
  assert.equal(workspaceListingCopy("Trainer").title, "Trainer course records");
  assert.equal(workspaceListingCopy("Creator").emptyTitle, "No content records yet");
});

test("removes only the matching listing kind and id", () => {
  const sameId = [
    { id: "shared-id", kind: "course" },
    { id: "shared-id", kind: "content" },
    { id: "other-id", kind: "content" },
  ];
  assert.deepEqual(
    removeListingByIdentity(sameId, { id: "shared-id", kind: "content" }),
    [sameId[0], sameId[2]],
  );
});
