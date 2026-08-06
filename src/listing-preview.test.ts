import { test } from "node:test";
import assert from "node:assert/strict";
import { assessListingQuality, quickGuessFields } from "./listing-preview.js";

test("assessListingQuality: flags short extracted text as poor", () => {
  const { quality, warnings } = assessListingQuality("Too short.");
  assert.equal(quality, "poor");
  assert.ok(warnings.length > 0);
});

test("assessListingQuality: flags cookie/JS boilerplate", () => {
  const text = "Please enable JavaScript to view this job listing. ".repeat(5);
  const { warnings } = assessListingQuality(text);
  assert.ok(warnings.some((w) => /javascript/i.test(w)));
});

test("assessListingQuality: a real-looking listing scores good with no warnings", () => {
  const text = `Senior Backend Engineer

We are looking for an experienced backend engineer to join our platform team.

Responsibilities:
- Design and build scalable APIs
- Own our Node.js services in production
- Collaborate with product and design

Requirements:
- 5+ years of experience with Node.js and TypeScript
- Experience with PostgreSQL and distributed systems
- Strong communication skills

We offer a competitive salary and a hybrid work model. Apply now to join our growing team in Copenhagen.`;
  const { quality, warnings } = assessListingQuality(text);
  assert.equal(quality, "good");
  assert.equal(warnings.length, 0);
});

test("assessListingQuality: flags repetitive/templated text", () => {
  const text = ("menu item link click here ").repeat(60);
  const { warnings } = assessListingQuality(text);
  assert.ok(warnings.some((w) => /repetitive/i.test(w)));
});

test("quickGuessFields: extracts explicit labeled fields", () => {
  const text = "Job Title: Senior Backend Engineer\nCompany: Acme Corp\nLocation: Aarhus, Denmark\n\nWe are looking for...";
  const guess = quickGuessFields(text);
  assert.equal(guess.title, "Senior Backend Engineer");
  assert.equal(guess.company, "Acme Corp");
  assert.match(guess.location ?? "", /Aarhus/);
});

test("quickGuessFields: falls back to 'at <company>' phrasing when unlabeled", () => {
  const text = "We are hiring a Platform Engineer at Globex Corporation to help scale our systems.";
  const guess = quickGuessFields(text);
  assert.match(guess.company ?? "", /Globex/);
});

test("quickGuessFields: returns nulls when nothing recognizable is present", () => {
  const guess = quickGuessFields("lorem ipsum dolor sit amet consectetur");
  assert.equal(guess.company, null);
  assert.equal(guess.location, null);
});
