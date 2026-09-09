import type { JobInfo, JobRequirement } from "./types.js";
import {
  loadPromptTemplate,
  renderPrompt,
  type EditablePromptId,
} from "./prompt-settings.js";

/**
 * Protected system rules. These are intentionally not user-editable because
 * they prevent unsupported claims from being invented.
 */
export const SYSTEM_IDENTITY = `You are Jobseeker, a personal job-application assistant. You help the candidate turn any job listing into a tailored, ATS-safe CV and cover letter.

Rules:
- Be concise and professional.
- Never invent facts, skills, or experience that are not present in the provided knowledge.
- Always tailor to the exact wording of the job listing.
- Both Danish and English output are always produced.
`;

export const SYSTEM_TONE = `Be direct, confident, and helpful. Respond in the same language the user writes in (Danish for Danish users/companies, English otherwise). Keep chat messages short and friendly.`;

/**
 * Provider-neutral system instructions for the analysis/interview/generation
 * calls. Providers translate this plain text into their own system-message
 * shape, so it must not contain provider-specific structure.
 */
export function analysisSystemPrompt(): string {
  return [
    SYSTEM_IDENTITY,
    "You are currently performing STRUCTURED JOB ANALYSIS.",
    SYSTEM_TONE,
  ].join("\n\n");
}

export const DEFAULT_PROMPT_TEMPLATES: Record<EditablePromptId, string> = {
  "analyze-listing": `You are analyzing a job listing to help a job seeker understand requirements.

## Job listing
"""
{{listing}}
"""

## The candidate's known profile (for reference only — do NOT add requirements from here)
"""
{{knowledge}}
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
- Do not invent requirements.`,
  "match-requirements": `You are scoring how well a candidate's known profile covers a job's requirements.

## Candidate profile
"""
{{knowledge}}
"""

## Job requirements
{{requirements}}

For each requirement, decide whether the candidate's profile demonstrates it.
- "yes": clearly demonstrated (skill, experience, or evidence in profile)
- "partial": partially demonstrated (related skill or adjacent experience)
- "no": not demonstrated at all

Respond with a SINGLE valid JSON object (no markdown fences):
{
  "assessments": [
   { "index": 0, "verdict": "yes | partial | no", "reason": "short justification" }
  ]
}

Use zero-based requirement indices exactly as listed above: the first requirement is index 0, the second is index 1, and so on.`,
  "interview-question": `You are interviewing a job seeker to confirm whether they have a specific requirement for a job.

Job: {{jobRole}} at {{company}}
Requirement ({{index}}/{{total}}): "{{requirement}}"

Write ONE short, natural chat question (max 40 words) that asks whether the candidate has this exact knowledge/experience and invites them to briefly describe evidence (what they did, where, with what result). Keep it friendly and specific, referencing the requirement wording. Respond with only the question text, no quotes.`,
  "interpret-answer": `The job seeker was asked whether they have this requirement: "{{requirement}}".

Their answer: """{{answer}}"""

Decide whether they confirmed having this knowledge/experience (yes), clearly said no (no), or were ambiguous (unsure).
Respond with a SINGLE valid JSON object (no markdown fences):
{
  "has": true | false,
  "unsure": true | false,
  "evidence": "A concise factual statement of what they actually did, based ONLY on their answer. Empty string if unsure."
}`,
  "generate-documents": `Generate a tailored job application for the following job.

## Job
Company: {{company}}
Role: {{role}}
Location: {{location}}
Summary: {{summary}}
Requirements: {{requirements}}

## Candidate knowledge
{{knowledge}}

## Additional confirmed during interview
{{confirmed}}

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
- Group the bullets under 3-5 bold category sub-headings that are relevant to this job. One skill per bullet, no nested lists.
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

Markdown rules: use ONLY standard headings (##), bullets (-), and plain paragraphs. No tables, no emoji, no images, no HTML. Keep the first line of each document a clear title.`,
  "idle-chat": `The job seeker sent: """{{message}}"""

This does not look like a job listing. Reply in 1–2 short sentences telling them to paste a job listing (or a URL to one) so you can analyze it and build a tailored CV and cover letter.`,
};

async function editable(id: EditablePromptId, values: Record<string, string>): Promise<string> {
  const template = await loadPromptTemplate(id, DEFAULT_PROMPT_TEMPLATES[id]);
  return renderPrompt(template, values);
}

export async function analyzeListingPrompt(listing: string, knowledgeText: string): Promise<string> {
  return editable("analyze-listing", { listing, knowledge: knowledgeText });
}

export async function matchPrompt(requirements: JobRequirement[], knowledgeText: string): Promise<string> {
  return editable("match-requirements", {
    requirements: requirements.map((r, i) => `${i + 1}. ${r.text}`).join("\n"),
    knowledge: knowledgeText,
  });
}

export async function interviewQuestionPrompt(
  requirement: JobRequirement,
  job: JobInfo,
  idx: number,
  total: number,
): Promise<string> {
  return editable("interview-question", {
    jobRole: job.role,
    company: job.company ?? "the company",
    index: String(idx),
    total: String(total),
    requirement: requirement.text,
  });
}

export async function interpretAnswerPrompt(requirement: JobRequirement, userAnswer: string): Promise<string> {
  return editable("interpret-answer", { requirement: requirement.text, answer: userAnswer });
}

export async function generateDocumentsPrompt(
  job: JobInfo,
  knowledgeText: string,
  confirmedAnswers: string[],
): Promise<string> {
  return editable("generate-documents", {
    company: job.company ?? "Unknown",
    role: job.role,
    location: job.location ?? "Unknown",
    summary: job.summary,
    requirements: job.requirements.map((r) => r.text).join(" | "),
    knowledge: knowledgeText,
    confirmed: confirmedAnswers.length > 0 ? confirmedAnswers.map((a) => `- ${a}`).join("\n") : "- (none)",
  });
}

export async function idleChatPrompt(userMessage: string): Promise<string> {
  return editable("idle-chat", { message: userMessage });
}
