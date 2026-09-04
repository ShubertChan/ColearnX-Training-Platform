import test from "node:test";
import assert from "node:assert/strict";
import {
  contentDraftFromListing,
  isDeletableDraftListing,
  isEditableContentDraft,
  isMissingContentDraftFile,
} from "./contentDraft.js";

const readyAsset = {
  assetId: "asset-1",
  filename: "guide.pdf",
  mediaType: "application/pdf",
  sizeBytes: 42,
  status: "ready",
};

test("restores an owned draft with only safe ready-asset metadata", () => {
  const draft = contentDraftFromListing({
    id: "content-1",
    kind: "content",
    contentVersionId: "version-1",
    title: "Guide",
    format: "pdf",
    price: 25,
    status: "Draft",
    versionStatus: "Draft",
    asset: readyAsset,
  });

  assert.deepEqual(draft, {
    id: "content-1",
    contentVersionId: "version-1",
    title: "Guide",
    contentType: "pdf",
    price: "25",
    asset: readyAsset,
  });
});

test("does not expose submitted or incomplete content as an editable draft", () => {
  assert.equal(isEditableContentDraft({ kind: "content", status: "Submitted", versionStatus: "Submitted" }), false);
  assert.equal(contentDraftFromListing({
    kind: "content",
    contentVersionId: "version-2",
    status: "Draft",
    versionStatus: "Draft",
  }), null);
});

test("classifies a draft without a ready attachment as missing", () => {
  const missing = {
    id: "content-2",
    kind: "content",
    contentVersionId: "version-2",
    status: "Draft",
    versionStatus: "Draft",
    asset: null,
  };
  assert.equal(isEditableContentDraft(missing), true);
  assert.equal(isMissingContentDraftFile(missing), true);
  assert.equal(isMissingContentDraftFile({ ...missing, asset: { ...readyAsset, status: "pending" } }), true);
  assert.equal(isMissingContentDraftFile({ ...missing, asset: { ...readyAsset, status: "quarantined" } }), true);
  assert.equal(isMissingContentDraftFile({ ...missing, asset: readyAsset }), false);
  assert.equal(isMissingContentDraftFile({ ...missing, status: "Submitted", versionStatus: "Submitted" }), false);
});

test("only draft listings expose the delete action", () => {
  assert.equal(isDeletableDraftListing({ kind: "content", status: "Draft", versionStatus: "Draft" }), true);
  assert.equal(isDeletableDraftListing({ kind: "course", status: "Draft", publicationStatus: "Draft" }), true);
  assert.equal(isDeletableDraftListing({ kind: "content", status: "Submitted", versionStatus: "Submitted" }), false);
  assert.equal(isDeletableDraftListing({ kind: "course", status: "Published", publicationStatus: "Published" }), false);
});
