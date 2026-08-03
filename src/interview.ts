import type { CopilotManager } from "./copilot.js";
import { interviewQuestionPrompt, interpretAnswerPrompt, analysisSystemMessage } from "./prompts.js";
import type { JobInfo, JobRequirement } from "./types.js";

export interface InterpretedAnswer {
  has: boolean;
  unsure: boolean;
  evidence: string;
}

/** Generates the chat question for one missing requirement. */
export async function askGapQuestion(
  requirement: JobRequirement,
  job: JobInfo,
  idx: number,
  total: number,
  manager: CopilotManager,
): Promise<string> {
  try {
    const text = await manager.run({
      prompt: interviewQuestionPrompt(requirement, job, idx, total),
      systemMessage: analysisSystemMessage() as never,
      timeoutMs: 60_000,
    });
    const cleaned = text.replace(/^["'\s]+|["'\s]+$/g, "").trim();
    return cleaned || `Do you have experience with: "${requirement.text}"?`;
  } catch {
    return `Do you have experience with: "${requirement.text}"?`;
  }
}

/**
 * Interprets the user's free-text answer: did they confirm the requirement,
 * deny it, or were they unclear? Extracts evidence when confirmed.
 */
export async function interpretAnswer(
  requirement: JobRequirement,
  userAnswer: string,
  manager: CopilotManager,
): Promise<InterpretedAnswer> {
  try {
    const raw = await manager.run({
      prompt: interpretAnswerPrompt(requirement, userAnswer),
      systemMessage: analysisSystemMessage() as never,
      timeoutMs: 60_000,
    });
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      has: boolean;
      unsure: boolean;
      evidence: string;
    };
    return {
      has: Boolean(obj.has),
      unsure: Boolean(obj.unsure),
      evidence: typeof obj.evidence === "string" ? obj.evidence.trim() : "",
    };
  } catch (err) {
    console.warn(`⚠️ Answer interpretation failed: ${err instanceof Error ? err.message : String(err)}`);
    // Heuristic fallback.
    const t = userAnswer.toLowerCase();
    const positive = /\b(yes|ja|yep|sure|have|do|can|kunne|har|ja det kan jeg|absolutely|of course)\b/.test(t);
    const negative = /\b(no|nej|not|ikke|never|haven'?t|har ikke)\b/.test(t);
    return {
      has: positive && !negative,
      unsure: positive === negative,
      evidence: positive && !negative ? userAnswer.trim() : "",
    };
  }
}
