export function listingKindForWorkspace(role) {
  if (role === "Trainer") return "course";
  if (role === "Creator") return "content";
  return null;
}

export function listingsForWorkspace(listings, role) {
  const kind = listingKindForWorkspace(role);
  if (!kind) return [];
  return (listings || []).filter((listing) => listing.kind === kind);
}

export function workspaceListingCopy(role) {
  return role === "Creator"
    ? {
      title: "Creator content records",
      emptyTitle: "No content records yet",
      emptyDescription: "Content you create in the Creator workspace will appear here.",
    }
    : {
      title: "Trainer course records",
      emptyTitle: "No course records yet",
      emptyDescription: "Courses you create in the Trainer workspace will appear here.",
    };
}