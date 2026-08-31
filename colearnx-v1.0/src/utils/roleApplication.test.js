import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePortfolioUrl,
  parseRoleApplicationSupportingText,
} from "./roleApplication.js";

test("parses labelled application details", () => {
  const supportingText = [
    "Category: Software development",
    "Portfolio: https://example.com/work",
    "Experience: Five years building web applications",
    "Reason: I want to create practical learning resources.",
  ].join("\n");

  assert.deepEqual(parseRoleApplicationSupportingText(supportingText), {
    category: "Software development",
    portfolio: "https://example.com/work",
    experience: "Five years building web applications",
    reason: "I want to create practical learning resources.",
    raw: supportingText,
  });
});

test("keeps multiline experience and reason text in their sections", () => {
  const supportingText = [
    "Category: Design",
    "Portfolio: www.example.com/portfolio",
    "Experience: I have led three design projects.",
    "I also mentor junior designers.",
    "",
    "My work spans mobile and web products.",
    "Reason: I want to publish reusable design resources.",
    "The resources will include worked examples.",
  ].join("\r\n");

  const result = parseRoleApplicationSupportingText(supportingText);

  assert.equal(
    result.experience,
    "I have led three design projects.\nI also mentor junior designers.\n\nMy work spans mobile and web products.",
  );
  assert.equal(
    result.reason,
    "I want to publish reusable design resources.\nThe resources will include worked examples.",
  );
  assert.equal(result.raw, supportingText);
});

test("parses applications that omit the optional portfolio", () => {
  const result = parseRoleApplicationSupportingText([
    "Category: Data science",
    "Experience: Two years teaching Python",
    "Reason: Help beginners learn data analysis",
  ].join("\n"));

  assert.equal(result.category, "Data science");
  assert.equal(result.portfolio, "");
  assert.equal(result.experience, "Two years teaching Python");
  assert.equal(result.reason, "Help beginners learn data analysis");
});

test("falls back to the original text for legacy unlabelled applications", () => {
  const supportingText = "I have taught adult learners for three years.\nI want to make technical topics approachable.";

  assert.deepEqual(parseRoleApplicationSupportingText(supportingText), {
    category: "",
    portfolio: "",
    experience: "",
    reason: supportingText,
    raw: supportingText,
  });
});

test("returns empty application details for absent text", () => {
  assert.deepEqual(parseRoleApplicationSupportingText(null), {
    category: "",
    portfolio: "",
    experience: "",
    reason: "",
    raw: "",
  });
});

test("normalizes www portfolio URLs to HTTPS", () => {
  assert.equal(
    normalizePortfolioUrl(" www.example.com/portfolio "),
    "https://www.example.com/portfolio",
  );
});

test("accepts only valid HTTP and HTTPS portfolio URLs", () => {
  assert.equal(
    normalizePortfolioUrl("https://example.com/portfolio?q=featured"),
    "https://example.com/portfolio?q=featured",
  );
  assert.equal(
    normalizePortfolioUrl("http://example.com/work"),
    "http://example.com/work",
  );
  assert.equal(normalizePortfolioUrl("javascript:alert(1)"), null);
  assert.equal(normalizePortfolioUrl("data:text/html,unsafe"), null);
  assert.equal(normalizePortfolioUrl("example.com/portfolio"), null);
  assert.equal(normalizePortfolioUrl("not a url"), null);
  assert.equal(normalizePortfolioUrl(""), null);
});
