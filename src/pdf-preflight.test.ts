import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  analyzePdfFile,
  buildApplicationPreflightReport,
  detectLanguage,
  detectPlaceholders,
  extractTextFromPdfBuffer,
  findMissingSections,
  looksLikeDocumentType,
} from "./pdf-preflight.js";
import { markdownToPdf } from "./pdf.js";
import { PROJECT_ROOT } from "./config.js";
import type { PdfPreflightReport } from "./types.js";

// Scratch directory for the (few) tests that need a real PDF file on disk.
// Kept inside the repo (never under a system temp dir) and removed after use.
const SCRATCH_ROOT = path.join(PROJECT_ROOT, ".tmp-test-scratch");

async function makeScratchDir(label: string): Promise<string> {
  const dir = path.join(SCRATCH_ROOT, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ── Pure text-analysis helpers ─────────────────────────────────────────────

test("detectPlaceholders: finds common template markers", () => {
  const text = "Dear {{hiring_manager}}, please see [TODO: finish this] and TBD later. undefined";
  const found = detectPlaceholders(text);
  assert.ok(found.some((p) => p.includes("{{hiring_manager}}")));
  assert.ok(found.some((p) => /TODO/i.test(p)));
  assert.ok(found.some((p) => p === "TBD"));
  assert.ok(found.some((p) => p === "undefined"));
});

test("detectPlaceholders: clean text has no findings", () => {
  assert.deepEqual(detectPlaceholders("Experienced backend engineer with 8 years in Node.js."), []);
});

test("detectLanguage: recognizes Danish via characters and stopwords", () => {
  const text = "Jeg har mange års erfaring med udvikling og ledelse af komplekse it-projekter i København.";
  assert.equal(detectLanguage(text), "da");
});

test("detectLanguage: recognizes English", () => {
  const text = "I have extensive experience with the design and development of scalable systems for clients.";
  assert.equal(detectLanguage(text), "en");
});

test("detectLanguage: unknown for empty or inconclusive text", () => {
  assert.equal(detectLanguage(""), "unknown");
  assert.equal(detectLanguage("1234 5678 ###"), "unknown");
});

test("findMissingSections: flags a CV missing education/skills", () => {
  const text = "John Doe john@example.com\nExperience\nSenior Engineer at Acme, 2019-2024";
  const missing = findMissingSections(text, "cv");
  assert.ok(missing.includes("education section"));
  assert.ok(missing.includes("skills section"));
  assert.ok(!missing.includes("experience section"));
});

test("findMissingSections: a complete CV has nothing missing", () => {
  const text = "John Doe john@example.com +45 12345678\nExperience\nSkills\nEducation";
  assert.deepEqual(findMissingSections(text, "cv"), []);
});

test("findMissingSections: a cover letter needs salutation/closing/date", () => {
  const text = "Some body text with no greeting or sign-off at all.";
  const missing = findMissingSections(text, "cover");
  assert.ok(missing.includes("salutation (greeting)"));
  assert.ok(missing.includes("closing (sign-off)"));
});

test("looksLikeDocumentType: a CV-shaped text passes as cv but not cover", () => {
  const text = "john@example.com\nExperience\nSkills\nEducation";
  assert.equal(looksLikeDocumentType(text, "cv"), true);
  assert.equal(looksLikeDocumentType(text, "cover"), false);
});

test("looksLikeDocumentType: a cover-letter-shaped text passes as cover", () => {
  const text = "Dear hiring team,\n\nI would love to join your company.\n\nKind regards,\nJohn";
  assert.equal(looksLikeDocumentType(text, "cover"), true);
});

test("buildApplicationPreflightReport: sendable only when every document passed", () => {
  const passing: PdfPreflightReport = {
    file: "a.pdf", kind: "cv", expectedLanguage: "en", checkedAt: "", pageCount: 1, blankPages: [],
    textExtractable: true, extractedCharCount: 500, detectedLanguage: "en", languageMismatch: false,
    documentTypeMatch: true, missingSections: [], placeholders: [], errors: [], warnings: [], passed: true,
  };
  const failing: PdfPreflightReport = { ...passing, file: "b.pdf", passed: false, errors: ["missing section"] };

  assert.equal(buildApplicationPreflightReport([passing]).status, "sendable");
  assert.equal(buildApplicationPreflightReport([passing]).overallPassed, true);
  assert.equal(buildApplicationPreflightReport([passing, failing]).status, "draft");
  assert.equal(buildApplicationPreflightReport([]).status, "draft");
});

// ── Real-PDF integration: verifies the deterministic extractor against
// actual chromium-rendered output, not just hand-built fixtures. ─────────────

test("extractTextFromPdfBuffer + analyzePdfFile: reads a real generated CV PDF end-to-end", async (t) => {
  const dir = await makeScratchDir("cv");
  const outPath = path.join(dir, "cv.pdf");
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const markdown = `# Jane Doe
jane.doe@example.com · +45 12 34 56 78 · Copenhagen, Denmark

## Professional Summary
Backend engineer with 8 years of experience building distributed systems.

## Skills
- Node.js
- TypeScript
- PostgreSQL

## Experience
### Acme Corp — Senior Backend Engineer | 2019-2024
- Built and operated high-throughput APIs serving millions of requests daily.

## Education
### Aarhus University — MSc Computer Science | 2013-2015
`;

  await markdownToPdf(markdown, outPath, "cv");

  const buffer = await fs.readFile(outPath);
  const extracted = extractTextFromPdfBuffer(buffer);
  assert.ok(extracted.pageCount >= 1, "expected at least one page");
  assert.match(extracted.totalText, /Jane Doe/);
  assert.match(extracted.totalText, /Experience/);

  const report = await analyzePdfFile(outPath, "cv", "en");
  assert.equal(report.textExtractable, true);
  assert.equal(report.documentTypeMatch, true);
  assert.deepEqual(report.missingSections, []);
  assert.deepEqual(report.placeholders, []);
  assert.equal(report.languageMismatch, false);
  assert.equal(report.passed, true);
});

test("analyzePdfFile: a CV missing required sections fails preflight with specific errors", async (t) => {
  const dir = await makeScratchDir("cv-incomplete");
  const outPath = path.join(dir, "cv-incomplete.pdf");
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // No education, no skills section, no contact info — should fail preflight.
  const markdown = `# Untitled\n\nSome placeholder text {{company}} TBD.`;
  await markdownToPdf(markdown, outPath, "cv");

  const report = await analyzePdfFile(outPath, "cv", "en");
  assert.equal(report.passed, false);
  assert.ok(report.missingSections.length > 0);
  assert.ok(report.placeholders.length > 0);
  assert.ok(report.errors.length > 0);
});
