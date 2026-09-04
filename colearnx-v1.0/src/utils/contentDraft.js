const normalizeStatus = (value) => String(value || "").trim().toLowerCase();

export const isEditableContentDraft = (listing) =>
  listing?.kind === "content" &&
  normalizeStatus(listing.status) === "draft" &&
  normalizeStatus(listing.versionStatus || listing.status) === "draft";

export const isMissingContentDraftFile = (listing) =>
  isEditableContentDraft(listing) && listing?.asset?.status !== "ready";

export const isDeletableDraftListing = (listing) =>
  isEditableContentDraft(listing) || (
    listing?.kind === "course" &&
    normalizeStatus(listing.status) === "draft" &&
    normalizeStatus(listing.publicationStatus || listing.status) === "draft"
  );

export function contentDraftFromListing(listing) {
  if (!isEditableContentDraft(listing) || isMissingContentDraftFile(listing) || !listing.contentVersionId) return null;
  return {
    id: listing.id,
    contentVersionId: listing.contentVersionId,
    title: listing.title || "",
    price: String(Number(listing.price || 0)),
    contentType: listing.format || "digital",
    asset: listing.asset?.status === "ready" ? listing.asset : null,
  };
}
