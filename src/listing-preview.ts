import { fetchListingText } from "./fetch-listing.js";
import type { ListingFieldGuess, ListingPreview, ListingQuality } from "./types.js";

/**
 * Pure heuristics for the listing-extraction preview shown before analysis
 * runs. These never call the model: the preview must be fast, and the point
 * is to let the user see and correct *exactly* what was scraped before it
 * feeds anything downstream.
 */

const BOILERPLATE_MARKERS = [
  "accept cookies",
  "accepter cookies",
  "cookie policy",
  "cookiepolitik",
  "javascript is disabled",
  "enable javascript",
  "please enable javascript",
  "you need to enable javascript",
  "sign in to continue",
  "log ind for at forts\u00e6tte",
  "403 forbidden",
  "404 not found",
  "page not found",
  "access denied",
  "captcha",
];

const LISTING_SIGNAL_RE =
  /(we are looking|we'?re looking|ans[øo]g|stilling|stillingsopslag|job title|responsibilities|qualifications|requirements|about the role|apply now|s[øo]g stillingen|om stillingen|dine opgaver|dine kvalifikationer)/i;

/** Assesses how trustworthy a scraped listing's text looks, without any LLM call. */
export function assessListingQuality(text: string): { quality: ListingQuality; warnings: string[] } {
  const warnings: string[] = [];
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (trimmed.length < 200) {
    warnings.push("Extracted text is short (under 200 characters) — the page may require login or JavaScript we couldn't run.");
  }

  for (const marker of BOILERPLATE_MARKERS) {
    if (lower.includes(marker)) {
      warnings.push(`Extracted text contains a possible non-listing marker: "${marker}".`);
    }
  }

  if (!LISTING_SIGNAL_RE.test(trimmed)) {
    warnings.push("No common job-listing phrasing detected (e.g. \"responsibilities\", \"requirements\") — this may not be the job description.");
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const uniqueRatio = new Set(words.map((w) => w.toLowerCase())).size / words.length;
    if (words.length > 40 && uniqueRatio < 0.3) {
      warnings.push("Extracted text looks repetitive — likely navigation or template clutter rather than the listing body.");
    }
  }

  let quality: ListingQuality = "good";
  if (warnings.length >= 2 || trimmed.length < 80) quality = "poor";
  else if (warnings.length === 1) quality = "fair";

  return { quality, warnings };
}

const GENERIC_TITLE_WORDS = new Set(["the", "a", "an", "and", "or", "of", "for", "at", "in"]);

/** Best-effort, regex-only guesses for company/title/location so the user can confirm or fix them. */
export function quickGuessFields(text: string): ListingFieldGuess {
  const trimmed = text.trim();

  const titleMatch =
    trimmed.match(/\b(?:job title|stilling(?:sbetegnelse)?|position)\s*[:\-]\s*([^\n]{3,80})/i) ??
    trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length >= 4 && l.length <= 80 && /^[A-Z\u00c6\u00d8\u00c5]/.test(l) && !GENERIC_TITLE_WORDS.has(l.toLowerCase()))
      ?.match(/^(.{4,80})$/);

  const companyMatch =
    trimmed.match(/\b(?:company|virksomhed|employer|arbejdsgiver)\s*[:\-]\s*([^\n]{2,60})/i) ??
    trimmed.match(/\b(?:at|hos|by|with)\s+([A-Z][A-Za-z0-9&.\- ]{2,50})(?:\s|,|\.|$)/);

  const locationMatch =
    trimmed.match(/\b(?:location|placering|sted|arbejdssted)\s*[:\-]\s*([^\n]{2,60})/i) ??
    trimmed.match(/\b([A-Z\u00c6\u00d8\u00c5][a-z\u00e6\u00f8\u00e5]+),\s*(?:Denmark|Danmark)\b/);

  return {
    title: titleMatch ? titleMatch[1].trim() : null,
    company: companyMatch ? companyMatch[1].trim() : null,
    location: locationMatch ? (locationMatch[0].includes(",") ? locationMatch[0].trim() : locationMatch[1].trim()) : null,
  };
}

/** Fetches a URL and builds the full preview payload (text + quality + field guesses). Never mutates state. */
export async function buildListingPreview(url: string): Promise<ListingPreview> {
  const text = await fetchListingText(url);
  const { quality, warnings } = assessListingQuality(text);
  const guess = quickGuessFields(text);
  return {
    url,
    text,
    quality,
    warnings,
    guess,
    fetchedAt: new Date().toISOString(),
  };
}
