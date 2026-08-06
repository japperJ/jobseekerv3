/** Shared types for the Jobseeker v2 app. */

export type RequirementCategory =
  | "hard_skill"
  | "soft_skill"
  | "experience"
  | "certification"
  | "education"
  | "task";

export interface JobRequirement {
  text: string;
  category: RequirementCategory;
}

export interface JobInfo {
  company: string | null;
  role: string;
  location: string | null;
  summary: string;
  requirements: JobRequirement[];
}

/**
 * Where an assessment's verdict came from. Used so the UI can show the
 * candidate *why* a requirement is considered covered, and how much to
 * trust it, instead of a single opaque score.
 */
export type AssessmentSource =
  | "model"
  | "fallback_keyword"
  | "knowledge_match"
  | "user_override";

export type Confidence = "high" | "medium" | "low";

export interface MatchAssessment {
  index: number;
  verdict: "yes" | "partial" | "no" | "uncertain" | "not_relevant";
  reason: string;
  /** Provenance: what produced this verdict. */
  source: AssessmentSource;
  /** How much this verdict should be trusted. */
  confidence: Confidence;
  /** Short quoted/derived snippet from the knowledge base backing the verdict, if any. */
  evidenceQuote?: string | null;
  /** True once a human has explicitly overridden the original verdict. */
  overridden?: boolean;
  /** Free-text note the user attached when overriding a verdict. */
  overrideNote?: string;
}

/**
 * Deterministic coverage of the profile against the job's requirements.
 * This is a simple ratio, not a prediction of ATS/recruiter outcomes —
 * callers must not describe it as an "ATS probability" or similar.
 */
export interface ProfileCoverage {
  coveredCount: number;
  totalCount: number;
  /** Rounded 0-100 percentage: coveredCount / totalCount. 0 when totalCount is 0. */
  percentage: number;
}

export interface AnalysisResult {
  job: JobInfo;
  assessments: MatchAssessment[];
  /** Requirements scored "no" (gaps to interview about). */
  missing: JobRequirement[];
  /** Requirements scored "yes" or "partial". */
  covered: JobRequirement[];
  /**
   * Deterministic profile-coverage ratio (covered / total requirements).
   * Kept as a plain percentage for backward compatibility; prefer `coverage`
   * for the full numerator/denominator. Not an ATS pass/fail probability.
   */
  score: number; // 0-100
  coverage: ProfileCoverage;
}

/** One row of the user-reviewable requirement matrix. */
export interface RequirementReviewRow {
  index: number;
  requirement: JobRequirement;
  assessment: MatchAssessment;
}

/** A knowledge-folder write proposed during the interview, awaiting explicit approval. */
export interface PendingKnowledgeItem {
  id: string;
  requirementText: string;
  evidence: string;
  context: string;
  /** Pre-selected so "approve all" is the common case; the user can uncheck items. */
  approved: boolean;
}

export interface InterviewAnswer {
  requirement: JobRequirement;
  has: boolean;
  unsure: boolean;
  evidence: string;
}

export interface GeneratedDocuments {
  cvEn: string;
  cvDa: string;
  coverEn: string;
  coverDa: string;
}

export interface ApplicationFiles {
  folder: string;
  cvEn: string;
  cvDa: string;
  coverEn: string;
  coverDa: string;
  jobDescription: string;
}

// ── Listing extraction preview (URL ingestion) ─────────────────────────────

export type ListingQuality = "good" | "fair" | "poor";

export interface ListingFieldGuess {
  company: string | null;
  title: string | null;
  location: string | null;
}

/**
 * The result of fetching a URL, before any analysis runs. Shown to the user
 * so they can confirm/edit/cancel instead of trusting extraction blindly.
 */
export interface ListingPreview {
  url: string;
  /** Exact extracted text, unmodified. */
  text: string;
  quality: ListingQuality;
  warnings: string[];
  guess: ListingFieldGuess;
  fetchedAt: string;
}

// ── PDF preflight ───────────────────────────────────────────────────────────

export type DocumentKind = "cv" | "cover";
export type DocumentLanguage = "en" | "da";

export interface PdfPreflightReport {
  file: string;
  kind: DocumentKind;
  expectedLanguage: DocumentLanguage;
  checkedAt: string;
  pageCount: number;
  blankPages: number[];
  textExtractable: boolean;
  extractedCharCount: number;
  detectedLanguage: DocumentLanguage | "unknown";
  languageMismatch: boolean;
  documentTypeMatch: boolean;
  missingSections: string[];
  placeholders: string[];
  errors: string[];
  warnings: string[];
  /** True only when there are no errors (warnings alone do not fail preflight). */
  passed: boolean;
}

export type ApplicationStatus = "draft" | "sendable";

export interface ApplicationPreflightReport {
  generatedAt: string;
  documents: PdfPreflightReport[];
  overallPassed: boolean;
  status: ApplicationStatus;
}

export interface ClientState {
  phase: "idle" | "listingPreview" | "interview" | "review" | "ready";
  job: JobInfo | null;
  analysis: AnalysisResult | null;
  /** The raw job listing text (pasted or fetched from URL). */
  listingText: string;
  /** Gaps still to ask about (indices into analysis.missing). */
  remaining: JobRequirement[];
  /** Answers collected so far. */
  answers: InterviewAnswer[];
  /** Confirmed evidence strings, fed into document generation this session. */
  confirmed: string[];
  /** A fetched URL awaiting explicit user confirm/cancel before analysis. */
  pendingListing: ListingPreview | null;
  /** Compact, user-reviewable requirement matrix (provenance + confidence). */
  reviewMatrix: RequirementReviewRow[];
  /** Knowledge-folder writes proposed during interview, awaiting approval. */
  pendingKnowledge: PendingKnowledgeItem[];
}
