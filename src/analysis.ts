import type { CopilotManager } from "./copilot.js";
import {
  FALLBACK_KEYWORDS,
  FALLBACK_ROLE_PATTERN,
} from "./fallback-config.js";
import { analyzeListingPrompt, matchPrompt, analysisSystemMessage } from "./prompts.js";
import type { AnalysisResult, JobInfo, JobRequirement, MatchAssessment } from "./types.js";

/** Extracts the first JSON object from a model response (strips fences/wrappers). */
export function extractJson<T>(text: string): T {
  let s = text.trim();
  // Strip ```json ... ``` fences if present.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model response");
  }
  return JSON.parse(s.slice(start, end + 1)) as T;
}

function fallbackParse(listing: string): JobInfo {
  const roleMatch = listing.match(FALLBACK_ROLE_PATTERN);
  const companyMatch = listing.match(/\b(?:at|by|with)\s+([A-Z][A-Za-z0-9&. ]{2,40})\b/i);
  const requirements: JobRequirement[] = [];
  for (const kw of FALLBACK_KEYWORDS) {
    if (listing.toLowerCase().includes(kw.toLowerCase())) {
      requirements.push({ text: kw, category: "hard_skill" });
    }
  }
  return {
    company: companyMatch ? companyMatch[1].trim() : null,
    role: roleMatch ? roleMatch[1] : "Unknown Role",
    location: null,
    summary: listing.slice(0, 300),
    requirements,
  };
}

const GENERIC_REQUIREMENT_WORDS = new Set([
  "a",
  "an",
  "and",
  "context",
  "experience",
  "have",
  "in",
  "knowledge",
  "of",
  "or",
  "professional",
  "the",
  "to",
  "used",
  "with",
  "worked",
]);

function hasKnowledgeEvidence(requirement: string, knowledgeText: string): boolean {
  const lowerRequirement = requirement.toLowerCase().trim();
  const lowerKnowledge = knowledgeText.toLowerCase();
  if (!lowerRequirement) return false;
  if (lowerKnowledge.includes(lowerRequirement)) return true;

  const meaningfulTerms = (requirement.match(/[A-Za-z][A-Za-z0-9+#./-]*/g) ?? [])
    .filter((term) => !GENERIC_REQUIREMENT_WORDS.has(term.toLowerCase()))
    .filter((term) => term.length >= 5 || /^[A-Z][A-Z0-9+#./-]*$/.test(term));

  return meaningfulTerms.some((term) =>
    new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(knowledgeText),
  );
}

/**
 * Runs the full analysis: parse the listing into requirements, score the
 * candidate's knowledge against them, and return gaps + match score.
 */
export async function analyzeJobListing(
  listing: string,
  knowledgeText: string,
  manager: CopilotManager,
  onTrace?: (event: import("./copilot.js").TraceEvent) => void,
): Promise<AnalysisResult> {
  let job: JobInfo;
  try {
    const parseRaw = await manager.run({
      prompt: analyzeListingPrompt(listing, knowledgeText),
      systemMessage: analysisSystemMessage() as never,
      timeoutMs: 120_000,
      label: "Parse job listing",
      onTrace,
    });
    const parsed = extractJson<{
      company: string | null;
      role: string;
      location: string | null;
      summary: string;
      requirements: Array<{ text: string; category?: JobRequirement["category"] }>;
    }>(parseRaw);
    job = {
      company: parsed.company ?? null,
      role: parsed.role || "Unknown Role",
      location: parsed.location ?? null,
      summary: parsed.summary || "",
      requirements: (parsed.requirements ?? []).map((r) => ({
        text: String(r.text ?? "").trim(),
        category: r.category ?? "hard_skill",
      })).filter((r) => r.text.length > 0),
    };
    if (job.requirements.length === 0) throw new Error("No requirements extracted");
  } catch (err) {
    console.warn(`⚠️ Model-based listing parse failed (${err instanceof Error ? err.message : String(err)}); using fallback.`);
    job = fallbackParse(listing);
  }

  // Score the match using the model when possible, else a keyword heuristic.
  let assessments: MatchAssessment[] = [];
  try {
    const matchRaw = await manager.run({
      prompt: matchPrompt(job.requirements, knowledgeText),
      systemMessage: analysisSystemMessage() as never,
      timeoutMs: 120_000,
      label: "Score job match",
      onTrace,
    });
    assessments = extractJson<{ assessments: MatchAssessment[] }>(matchRaw).assessments ?? [];
  } catch (err) {
    console.warn(`⚠️ Model-based match scoring failed (${err instanceof Error ? err.message : String(err)}); using keyword fallback.`);
    const lower = knowledgeText.toLowerCase();
    assessments = job.requirements.map((r, index) => {
      const words = r.text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const hit = words.filter((w) => lower.includes(w)).length;
      const verdict: MatchAssessment["verdict"] = hit >= 1 ? "yes" : hit === 0 && words.length > 0 ? "no" : "partial";
      return { index, verdict, reason: `matched ${hit}/${words.length} keywords` };
    });
  }

  // Do not ask about a requirement that is already explicitly documented.
  assessments = job.requirements.map((requirement, index) => {
    const existing = assessments.find((assessment) => assessment.index === index);
    if (hasKnowledgeEvidence(requirement.text, knowledgeText)) {
      return {
        index,
        verdict: "yes" as const,
        reason: "explicitly documented in the knowledge folder",
      };
    }
    return existing ?? { index, verdict: "no" as const, reason: "no matching evidence" };
  });

  const byIndex = new Map(assessments.map((a) => [a.index, a.verdict]));
  const covered: JobRequirement[] = [];
  const missing: JobRequirement[] = [];
  job.requirements.forEach((req, i) => {
    const v = byIndex.get(i) ?? "no";
    if (v === "yes" || v === "partial") covered.push(req);
    else missing.push(req);
  });

  const score = job.requirements.length > 0
    ? Math.round((covered.length / job.requirements.length) * 100)
    : 0;

  return { job, assessments, missing, covered, score };
}
