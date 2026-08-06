import type {
  AssessmentSource,
  Confidence,
  JobRequirement,
  MatchAssessment,
  PendingKnowledgeItem,
  ProfileCoverage,
  RequirementReviewRow,
} from "./types.js";

/**
 * Evidence-backed requirement review helpers. Pure, deterministic, and
 * independent of the model/CLI so they can be unit tested directly.
 *
 * Every verdict carries provenance (`source`) and a trust level
 * (`confidence`) so the UI can show *why* a requirement is considered
 * covered instead of a single opaque score. Overrides are always explicit
 * and always recorded as `user_override` with `confidence: "high"`.
 */

export function makeAssessment(
  index: number,
  verdict: MatchAssessment["verdict"],
  reason: string,
  source: AssessmentSource,
  confidence: Confidence,
  evidenceQuote?: string | null,
): MatchAssessment {
  return { index, verdict, reason, source, confidence, evidenceQuote: evidenceQuote ?? null };
}

/**
 * Deterministic profile-coverage ratio (covered / total). This is a plain
 * denominator-based fraction of listed requirements the profile addresses —
 * it is NOT a prediction of applicant-tracking-system pass rates and must
 * never be labeled as such in UI copy.
 */
export function computeCoverage(coveredCount: number, totalCount: number): ProfileCoverage {
  const percentage = totalCount > 0 ? Math.round((coveredCount / totalCount) * 100) : 0;
  return { coveredCount, totalCount, percentage };
}

/** Recomputes coverage straight from the current assessment verdicts. */
export function recomputeCoverageFromAssessments(
  assessments: MatchAssessment[],
  totalCount: number,
): ProfileCoverage {
  const coveredCount = assessments.filter((a) => a.verdict === "yes" || a.verdict === "partial").length;
  return computeCoverage(coveredCount, totalCount);
}

/** Builds the compact, user-reviewable matrix: one row per requirement, in listing order. */
export function buildReviewMatrix(
  requirements: JobRequirement[],
  assessments: MatchAssessment[],
): RequirementReviewRow[] {
  const byIndex = new Map(assessments.map((a) => [a.index, a]));
  return requirements.map((requirement, index) => ({
    index,
    requirement,
    assessment:
      byIndex.get(index) ??
      makeAssessment(index, "no", "no assessment produced", "fallback_keyword", "low"),
  }));
}

/**
 * Applies an explicit user override to one requirement's verdict. Returns a
 * new assessments array; callers must recompute coverage afterwards via
 * `recomputeCoverageFromAssessments`.
 */
export function applyOverride(
  assessments: MatchAssessment[],
  index: number,
  verdict: MatchAssessment["verdict"],
  note: string,
): MatchAssessment[] {
  return assessments.map((a) =>
    a.index === index
      ? {
          ...a,
          verdict,
          reason: note.trim() || a.reason,
          source: "user_override" as const,
          confidence: "high" as const,
          overridden: true,
          overrideNote: note.trim(),
        }
      : a,
  );
}

let pendingIdCounter = 0;

/** Monotonic, collision-resistant id for a pending knowledge item within one process. */
export function nextPendingKnowledgeId(): string {
  pendingIdCounter += 1;
  return `pk-${Date.now().toString(36)}-${pendingIdCounter}`;
}

/** Creates a proposed (not yet persisted) knowledge-folder write. Pre-approved by default. */
export function buildPendingKnowledgeItem(
  requirementText: string,
  evidence: string,
  context: string,
): PendingKnowledgeItem {
  return {
    id: nextPendingKnowledgeId(),
    requirementText,
    evidence,
    context,
    approved: true,
  };
}
