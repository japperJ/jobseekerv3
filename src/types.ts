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

export interface MatchAssessment {
  index: number;
  verdict: "yes" | "partial" | "no";
  reason: string;
}

export interface AnalysisResult {
  job: JobInfo;
  assessments: MatchAssessment[];
  /** Requirements scored "no" (gaps to interview about). */
  missing: JobRequirement[];
  /** Requirements scored "yes" or "partial". */
  covered: JobRequirement[];
  score: number; // 0-100
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

export interface ClientState {
  phase: "idle" | "interview" | "ready";
  job: JobInfo | null;
  analysis: AnalysisResult | null;
  /** The raw job listing text (pasted or fetched from URL). */
  listingText: string;
  /** Gaps still to ask about (indices into analysis.missing). */
  remaining: JobRequirement[];
  /** Answers collected so far. */
  answers: InterviewAnswer[];
  /** Confirmed evidence strings, fed into document generation. */
  confirmed: string[];
}
