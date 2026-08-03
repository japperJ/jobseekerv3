import type { JobInfo, JobRequirement } from "./types.js";

/**
 * System prompts and message builders used to drive the Copilot assistant.
 * Kept in one place so the agent's behavior is easy to tune.
 */

export const SYSTEM_IDENTITY = `You are Jobseeker, a personal job-application assistant. You help a senior IT Solutions Architect (Jan Petersen) turn any job listing into a tailored, ATS-safe CV and cover letter.

Rules:
- Be concise and professional.
- Never invent facts, skills, or experience that are not present in the provided knowledge.
- Always tailor to the exact wording of the job listing.
- Both Danish and English output are always produced.
`;

export const SYSTEM_TONE = `Be direct, confident, and helpful. Respond in the same language the user writes in (Danish for Danish users/companies, English otherwise). Keep chat messages short and friendly.`;

/**
 * Builds a system message for a Copilot session used for structured analysis.
 */
export function analysisSystemMessage(): Record<string, unknown> {
  return {
    mode: "customize",
    sections: {
      identity: {
        action: "replace",
        content: `${SYSTEM_IDENTITY}\n\nYou are currently performing STRUCTURED JOB ANALYSIS.`,
      },
      tone: { action: "replace", content: SYSTEM_TONE },
    },
  };
}

/**
 * Prompt asking Copilot to extract structured requirements from a job listing.
 */
export function analyzeListingPrompt(listing: string, knowledgeText: string): string {
  return `You are analyzing a job listing to help a job seeker understand requirements.

## Job listing
"""
${listing}
"""

## The candidate's known profile (for reference only — do NOT add requirements from here)
"""
${knowledgeText}
"""

Extract the following and respond with a SINGLE valid JSON object (no markdown fences, no commentary):

{
  "company": "Company name, or null if unknown",
  "role": "Job title",
  "location": "Location, or null if unknown",
  "summary": "One short paragraph summarizing the role",
  "requirements": [
    {
      "text": "A single concrete requirement phrased exactly as the listing states it (skill, certification, experience level, or task)",
      "category": "hard_skill | soft_skill | experience | certification | education | task"
    }
  ]
}

Rules:
- Extract 5 to 20 requirements. Prefer concrete, checkable items (technologies, tools, certs, years of experience, specific tasks).
- Keep the wording close to the listing so keyword matching against the candidate profile works.
- Do not invent requirements.`;
}

/**
 * Prompt asking Copilot to score the match between requirements and the profile.
 */
export function matchPrompt(
  requirements: JobRequirement[],
  knowledgeText: string,
): string {
  const reqList = requirements.map((r, i) => `${i + 1}. ${r.text}`).join("\n");
  return `You are scoring how well a candidate's known profile covers a job's requirements.

## Candidate profile
"""
${knowledgeText}
"""

## Job requirements
${reqList}

For each requirement, decide whether the candidate's profile demonstrates it.
- "yes": clearly demonstrated (skill, experience, or evidence in profile)
- "partial": partially demonstrated (related skill or adjacent experience)
- "no": not demonstrated at all

Respond with a SINGLE valid JSON object (no markdown fences):
{
  "assessments": [
    { "index": 1, "verdict": "yes | partial | no", "reason": "short justification" }
  ]
}`;
}

/**
 * Prompt that generates the interview question for a single gap.
 */
export function interviewQuestionPrompt(
  requirement: JobRequirement,
  job: JobInfo,
  idx: number,
  total: number,
): string {
  return `You are interviewing a job seeker to confirm whether they have a specific requirement for a job.

Job: ${job.role} at ${job.company ?? "the company"}
Requirement (${idx}/${total}): "${requirement.text}"

Write ONE short, natural chat question (max 40 words) that asks whether the candidate has this exact knowledge/experience and invites them to briefly describe evidence (what they did, where, with what result). Keep it friendly and specific, referencing the requirement wording. Respond with only the question text, no quotes.`;
}

/**
 * Prompt that interprets a user's answer to an interview question.
 */
export function interpretAnswerPrompt(
  requirement: JobRequirement,
  userAnswer: string,
): string {
  return `The job seeker was asked whether they have this requirement: "${requirement.text}".

Their answer: """${userAnswer}"""

Decide whether they confirmed having this knowledge/experience (yes), clearly said no (no), or were ambiguous (unsure).
Respond with a SINGLE valid JSON object (no markdown fences):
{
  "has": true | false,
  "unsure": true | false,
  "evidence": "A concise factual statement of what they actually did, based ONLY on their answer. Empty string if unsure."
}`;
}

/**
 * Prompt that generates the CV + cover letter markdown (both languages).
 */
export function generateDocumentsPrompt(
  job: JobInfo,
  knowledgeText: string,
  confirmedAnswers: string[],
): string {
  const answersBlock =
    confirmedAnswers.length > 0
      ? confirmedAnswers.map((a) => `- ${a}`).join("\n")
      : "- (none)";

  return `Generate a tailored job application for the following job.

## Job
Company: ${job.company ?? "Unknown"}
Role: ${job.role}
Location: ${job.location ?? "Unknown"}
Summary: ${job.summary}
Requirements: ${job.requirements.map((r) => r.text).join(" | ")}

## Candidate knowledge
${knowledgeText}

## Additional confirmed during interview
${answersBlock}

Produce FOUR markdown documents, separated by exactly one line of "---". In order:

1. **CV — English** (Professional Summary, Skills, Work Experience with quantified achievements, Education). Single column, ATS-safe, max 2 pages, MM/YYYY dates, mirror the job's exact keyword phrasing where truthful.
2. **CV — Dansk** (same content, in Danish, Professional Summary, Kompetencer, Erfaring, Uddannelse).
3. **Cover Letter — English** (max 350 words, confident, achievement-focused, references the company's actual requirements, no "I am writing to apply" opening).
4. **Ansøgning — Dansk** (max 350 words, formal but warm, Danish).

SKILLS SECTION GUIDELINES (apply to BOTH CVs):
- Include a dedicated "Skills" section (English) / "Kompetencer" (Danish) immediately after the Professional Summary.
- The section MUST be a visible bulleted list: each skill on its own line starting with "- ". Do NOT write comma-separated sentences or inline paragraphs — every skill gets its own bullet line.
- Curate 6-12 individual skills relevant to THIS job. Mirror the job description's exact keyword phrasing where truthful.
- Include every skill from the candidate's knowledge and the "Additional confirmed during interview" list that is relevant to this role.
- Exclude skills irrelevant to this job — a focused list of relevant skills is stronger than a long unfocused one.
- Group the bullets under 3-5 bold category sub-headings (e.g. **Cloud & Infrastructure**, **AI & Analytics**, **DevOps & Automation**, **Unified Communications**, **Architecture & Security**). One skill per bullet, no nested lists.
- The Skills section lives inside the CV only — do not add any extra document or appendix.

COVER LETTER STRUCTURE (apply to BOTH cover letters):
Format each cover letter as a proper business letter. After the title heading, write the sections below, each separated by a blank line, in exactly this order:
- Line 1: the candidate's full name (no formatting).
- Line 2: one contact line — "City, Country | phone | email".
- Then: the date (e.g. "03 August 2026" in English, "3. august 2026" in Danish).
- Then: the company name on one line, and the company location on the next line.
- Then: a subject line starting with "Re: " (English) or "Vedr.: " (Danish), e.g. "Re: Application for <Role>".
- Then: a salutation — "Dear hiring team," (English) or "Kære <company or team name>," (Danish).
- Then: 3–4 short body paragraphs, each its own paragraph separated by blank lines (2–3 sentences each). First paragraph: one strong, quantified achievement that matches the company's needs. Middle paragraphs: the key skills/experience that map to the job's specific requirements. Final paragraph: why you want this company and your availability.
- Then: the closing — "Kind regards," (English) or "Med venlig hilsen," (Danish).
- Then: your full name on one line, and a contact line ("phone | email") on the final line.

CRITICAL OUTPUT RULES:
- Output the COMPLETE, FINAL text of all four documents inline — never a summary, never a placeholder, never a reference like "saved to file" or "see above". A document that is replaced by a note is a failure.
- Each document starts with a title heading on its own line: "## CV - English", "## CV - Dansk", "## Cover Letter - English", "## Ansogning - Dansk". Use these EXACT headings.
- You are a content writer, not a coding agent. Do not mention saving files, writing files, or creating files. Just output the documents.
- The Danish CV must be a full translation, not "identical to the English one" — write it out completely.
- Do not use "---" (horizontal rules) inside a document. Use it only between the four documents.

Markdown rules: use ONLY standard headings (##), bullets (-), and plain paragraphs. No tables, no emoji, no images, no HTML. Keep the first line of each document a clear title.`;
}

/** Short chat acknowledgment used when the assistant is idle. */
export function idleChatPrompt(userMessage: string): string {
  return `The job seeker sent: """${userMessage}"""

This does not look like a job listing. Reply in 1–2 short sentences telling them to paste a job listing (or a URL to one) so you can analyze it and build a tailored CV and cover letter.`;
}
