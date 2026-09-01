const normalizeStatus = (value) => String(value || "").trim().toLowerCase();

export const isEditableContentDraft = (listing) =>
  listing?.kind === "content" &&
  normalizeStatus(listing.status) === "draft" &&
  normalizeStatus(listing.versionStatus || listing.status) === "draft";

export function contentDraftFromListing(listing) {
  if (!isEditableContentDraft(listing) || !listing.contentVersionId) return null;
  return {
    id: listing.id,
    contentVersionId: listing.contentVersionId,
    title: listing.title || "",
    price: String(Number(listing.price || 0)),
    contentType: listing.format || "digital",
    asset: listing.asset?.status === "ready" ? listing.asset : null,
  };
}
