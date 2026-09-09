import type { JsonSchema, LlmManager, TraceEvent } from "./llm/index.js";
import {
  FALLBACK_KEYWORDS,
  FALLBACK_ROLE_PATTERN,
} from "./fallback-config.js";
import { analyzeListingPrompt, matchPrompt, analysisSystemPrompt } from "./prompts.js";
import { computeCoverage, makeAssessment } from "./requirement-review.js";
import type { AnalysisResult, JobInfo, JobRequirement, MatchAssessment } from "./types.js";

/**
 * Shape the listing parser must return. Passed to providers that support
 * structured output; providers that do not simply ignore it, so the regex
 * fallback in {@link extractJson} still has to work.
 */
const JOB_INFO_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["company", "role", "location", "summary", "requirements"],
  properties: {
    company: { type: ["string", "null"] },
    role: { type: "string" },
    location: { type: ["string", "null"] },
    summary: { type: "string" },
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string" },
          category: {
            type: "string",
            enum: ["hard_skill", "soft_skill", "experience", "certification", "education", "task"],
          },
        },
      },
    },
  },
};

/** Shape the match scorer must return. */
const MATCH_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assessments"],
  properties: {
    assessments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "verdict", "reason"],
        properties: {
          index: { type: "integer" },
          verdict: { type: "string", enum: ["yes", "partial", "no", "uncertain", "not_relevant"] },
          reason: { type: "string" },
        },
      },
    },
  },
};

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

/** Pulls a short snippet of knowledgeText around a case-insensitive match, for evidence quoting. */
function quoteAround(knowledgeText: string, needle: string): string | null {
  const idx = knowledgeText.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - 40);
  const end = Math.min(knowledgeText.length, idx + needle.length + 40);
  const snippet = knowledgeText.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + snippet + (end < knowledgeText.length ? "…" : "");
}

/** Checks whether a requirement is explicitly documented in the knowledge folder; returns a quoted snippet when found. */
function findKnowledgeEvidence(requirement: string, knowledgeText: string): { matched: boolean; quote: string | null } {
  const lowerRequirement = requirement.toLowerCase().trim();
  const lowerKnowledge = knowledgeText.toLowerCase();
  if (!lowerRequirement) return { matched: false, quote: null };
  if (lowerKnowledge.includes(lowerRequirement)) {
    return { matched: true, quote: quoteAround(knowledgeText, requirement) };
  }

  const meaningfulTerms = (requirement.match(/[A-Za-z][A-Za-z0-9+#./-]*/g) ?? [])
    .filter((term) => !GENERIC_REQUIREMENT_WORDS.has(term.toLowerCase()))
    .filter((term) => term.length >= 5 || /^[A-Z][A-Z0-9+#./-]*$/.test(term));

  for (const term of meaningfulTerms) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(knowledgeText)) {
      return { matched: true, quote: quoteAround(knowledgeText, term) };
    }
  }
  return { matched: false, quote: null };
}

function normalizeVerdict(value: unknown): MatchAssessment["verdict"] {
  return (["yes", "partial", "no", "uncertain", "not_relevant"] as const).includes(value as never)
    ? value as MatchAssessment["verdict"]
    : "uncertain";
}

/**
 * Runs the full analysis: parse the listing into requirements, score the
 * candidate's knowledge against them, and return gaps + match score.
 */
export async function analyzeJobListing(
  listing: string,
  knowledgeText: string,
  manager: LlmManager,
  onTrace?: (event: TraceEvent) => void,
): Promise<AnalysisResult> {
  let job: JobInfo;
  try {
    const parseRaw = await manager.run({
      prompt: await analyzeListingPrompt(listing, knowledgeText),
      systemPrompt: analysisSystemPrompt(),
      jsonSchema: JOB_INFO_SCHEMA,
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
  // Both paths are normalized to the same MatchAssessment shape (source +
  // confidence) so the review matrix can show provenance consistently.
  let assessments: MatchAssessment[] = [];
  try {
    const matchRaw = await manager.run({
      prompt: await matchPrompt(job.requirements, knowledgeText),
      systemPrompt: analysisSystemPrompt(),
      jsonSchema: MATCH_SCHEMA,
      timeoutMs: 120_000,
      label: "Score job match",
      onTrace,
    });
    const modelAssessments = extractJson<{
      assessments: Array<{ index: number; verdict: MatchAssessment["verdict"]; reason: string }>;
    }>(matchRaw).assessments ?? [];
    assessments = modelAssessments.map((a) =>
      makeAssessment(a.index, normalizeVerdict(a.verdict), a.reason ?? "", "model", "medium"),
    );
  } catch (err) {
    console.warn(`⚠️ Model-based match scoring failed (${err instanceof Error ? err.message : String(err)}); using keyword fallback.`);
    const lower = knowledgeText.toLowerCase();
    assessments = job.requirements.map((r, index) => {
      const words = r.text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const hit = words.filter((w) => lower.includes(w)).length;
      const verdict: MatchAssessment["verdict"] = hit >= 1 ? "yes" : hit === 0 && words.length > 0 ? "no" : "partial";
      return makeAssessment(index, verdict, `matched ${hit}/${words.length} keywords`, "fallback_keyword", "low");
    });
  }

  // Do not ask about a requirement that is already explicitly documented —
  // an exact/near-exact textual match in the knowledge folder is treated as
  // high-confidence evidence, overriding a lower-confidence model/fallback verdict.
  assessments = job.requirements.map((requirement, index) => {
    const existing = assessments.find((assessment) => assessment.index === index);
    const evidence = findKnowledgeEvidence(requirement.text, knowledgeText);
    if (evidence.matched) {
      return makeAssessment(
        index,
        "yes",
        "explicitly documented in the knowledge folder",
        "knowledge_match",
        "high",
        evidence.quote,
      );
    }
    return existing ?? makeAssessment(index, "no", "no matching evidence", "fallback_keyword", "low");
  });

  const byIndex = new Map(assessments.map((a) => [a.index, a.verdict]));
  const covered: JobRequirement[] = [];
  const missing: JobRequirement[] = [];
  job.requirements.forEach((req, i) => {
    const v = byIndex.get(i) ?? "no";
    if (v === "yes" || v === "partial") covered.push(req);
    else missing.push(req);
  });

  const coverage = computeCoverage(covered.length, job.requirements.length);

  return { job, assessments, missing, covered, score: coverage.percentage, coverage };
}
