import test from "node:test";
import assert from "node:assert/strict";
import { contentDraftFromListing, isEditableContentDraft } from "./contentDraft.js";

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
  assert.equal(contentDraftFromListing({ kind: "content", status: "Draft", versionStatus: "Draft" }), null);
});
