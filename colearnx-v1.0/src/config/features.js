export function isFeatureEnabled(value) {
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

export const paymentsApiEnabled = isFeatureEnabled(
  import.meta.env?.VITE_PAYMENTS_API_ENABLED,
);
