import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOverride,
  buildPendingKnowledgeItem,
  buildReviewMatrix,
  computeCoverage,
  makeAssessment,
  recomputeCoverageFromAssessments,
} from "./requirement-review.js";
import type { JobRequirement, MatchAssessment } from "./types.js";

test("computeCoverage: percentage is a plain covered/total ratio", () => {
  assert.deepEqual(computeCoverage(3, 4), { coveredCount: 3, totalCount: 4, percentage: 75 });
});

test("computeCoverage: zero denominator does not throw or divide by zero", () => {
  assert.deepEqual(computeCoverage(0, 0), { coveredCount: 0, totalCount: 0, percentage: 0 });
});

test("recomputeCoverageFromAssessments: counts yes and partial as covered", () => {
  const assessments: MatchAssessment[] = [
    makeAssessment(0, "yes", "", "model", "medium"),
    makeAssessment(1, "partial", "", "model", "medium"),
    makeAssessment(2, "no", "", "model", "medium"),
  ];
  assert.deepEqual(recomputeCoverageFromAssessments(assessments, 3), {
    coveredCount: 2,
    totalCount: 3,
    percentage: 67,
  });
});

test("buildReviewMatrix: preserves requirement order and fills missing assessments", () => {
  const requirements: JobRequirement[] = [
    { text: "Node.js", category: "hard_skill" },
    { text: "Leadership", category: "soft_skill" },
  ];
  const assessments: MatchAssessment[] = [makeAssessment(0, "yes", "matched", "knowledge_match", "high")];
  const matrix = buildReviewMatrix(requirements, assessments);
  assert.equal(matrix.length, 2);
  assert.equal(matrix[0].assessment.verdict, "yes");
  assert.equal(matrix[1].assessment.verdict, "no");
  assert.equal(matrix[1].assessment.source, "fallback_keyword");
});

test("applyOverride: marks the row as a high-confidence user override", () => {
  const assessments: MatchAssessment[] = [makeAssessment(0, "no", "no evidence", "fallback_keyword", "low")];
  const updated = applyOverride(assessments, 0, "yes", "I did this at my last job");
  assert.equal(updated[0].verdict, "yes");
  assert.equal(updated[0].source, "user_override");
  assert.equal(updated[0].confidence, "high");
  assert.equal(updated[0].overridden, true);
  assert.equal(updated[0].overrideNote, "I did this at my last job");
});

test("applyOverride: leaves other rows untouched", () => {
  const assessments: MatchAssessment[] = [
    makeAssessment(0, "no", "", "fallback_keyword", "low"),
    makeAssessment(1, "yes", "", "model", "medium"),
  ];
  const updated = applyOverride(assessments, 0, "yes", "note");
  assert.equal(updated[1].source, "model");
  assert.equal(updated[1].overridden, undefined);
});

test("buildPendingKnowledgeItem: is pre-approved and carries a unique id", () => {
  const a = buildPendingKnowledgeItem("Kubernetes", "Ran a 20-node cluster", "Acme Corp — SRE");
  const b = buildPendingKnowledgeItem("Kubernetes", "Ran a 20-node cluster", "Acme Corp — SRE");
  assert.equal(a.approved, true);
  assert.notEqual(a.id, b.id);
});
