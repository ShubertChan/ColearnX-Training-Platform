const supportedFields = {
  category: "category",
  portfolio: "portfolio",
  experience: "experience",
  reason: "reason",
};

const labelledLine = /^\s*(Category|Portfolio|Experience|Reason)\s*:\s*(.*)$/i;

function trimBlock(lines) {
  return lines.join("\n").trim();
}

export function parseRoleApplicationSupportingText(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const details = {
    category: "",
    portfolio: "",
    experience: "",
    reason: "",
    raw,
  };

  if (!raw) return details;

  const sections = {
    category: [],
    portfolio: [],
    experience: [],
    reason: [],
  };
  const preamble = [];
  let currentField = null;
  let foundLabel = false;

  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(labelledLine);
    if (match) {
      currentField = supportedFields[match[1].toLowerCase()];
      foundLabel = true;
      sections[currentField].push(match[2]);
      continue;
    }

    if (currentField) {
      sections[currentField].push(line);
    } else {
      preamble.push(line);
    }
  }

  if (!foundLabel) {
    details.reason = raw;
    return details;
  }

  details.category = trimBlock(sections.category);
  details.portfolio = trimBlock(sections.portfolio);
  details.experience = trimBlock(sections.experience);
  details.reason = trimBlock(sections.reason);

  const unlabelledPreamble = trimBlock(preamble);
  if (unlabelledPreamble) {
    details.reason = [unlabelledPreamble, details.reason]
      .filter(Boolean)
      .join("\n");
  }

  return details;
}

export function normalizePortfolioUrl(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const candidate = /^www\./i.test(trimmed)
    ? `https://${trimmed}`
    : trimmed;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}
