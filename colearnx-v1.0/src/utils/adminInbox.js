export const inboxSources = [
  { kind: "role", label: "Role applications", path: "/admin/role-applications", review: "/admin/applications", parameter: "application" },
  { kind: "certification", label: "Trainer certifications", path: "/admin/trainer-certifications", review: "/admin/certifications", parameter: "request" },
  { kind: "refund", label: "Refund requests", path: "/admin/refund-requests", review: "/admin/refunds", parameter: "request" },
];

export function inboxMessages(queues) {
  return inboxSources.flatMap((source) => (queues[source.kind] || []).map((item) => {
    const sender = item.applicant?.displayName || item.trainer?.displayName || item.requester?.displayName || "Applicant";
    const title = source.kind === "role" ? `${item.requestedRole || "Role"} application`
      : source.kind === "certification" ? "Trainer certification" : "Refund request";
    return {
      id: `${source.kind}:${item.id}`, kind: source.kind, sender, title,
      status: String(item.status || "unknown").toLowerCase(),
      submittedAt: item.submittedAt || item.requestedAt || item.createdAt || "",
      summary: source.kind === "role" ? item.supportingText
        : source.kind === "certification" ? [item.certificationName, item.certificationReference].filter(Boolean).join(" · ")
          : [item.item?.title, item.reason].filter(Boolean).join(" · "),
      href: `${source.review}?${source.parameter}=${encodeURIComponent(item.id)}`,
    };
  })).sort((a, b) => (Date.parse(b.submittedAt) || 0) - (Date.parse(a.submittedAt) || 0) || a.id.localeCompare(b.id));
}

export const inboxReadKey = (accountId) => `colearnx-admin-inbox-read-v1:${encodeURIComponent(accountId)}`;
export function readInboxMarks(accountId) {
  try {
    const value = JSON.parse(localStorage.getItem(inboxReadKey(accountId)) || "[]");
    return { ids: Array.isArray(value) ? value.filter((id) => typeof id === "string") : [], unavailable: false };
  } catch { return { ids: [], unavailable: true }; }
}
export function saveInboxMarks(accountId, ids) {
  try { localStorage.setItem(inboxReadKey(accountId), JSON.stringify(ids)); return true; }
  catch { return false; }
}
