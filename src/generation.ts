import type { CopilotManager } from "./copilot.js";
import { generateDocumentsPrompt, analysisSystemMessage } from "./prompts.js";
import type { GeneratedDocuments, JobInfo } from "./types.js";

/**
 * Generates CV + cover letter (both Danish and English) as markdown.
 * A single Copilot call produces four sections separated by "---".
 */
export async function generateApplicationDocuments(
  job: JobInfo,
  knowledgeText: string,
  confirmedEvidence: string[],
  manager: CopilotManager,
  onChunk?: (chunk: string) => void,
  onTrace?: (event: import("./copilot.js").TraceEvent) => void,
): Promise<GeneratedDocuments> {
  const basePrompt = generateDocumentsPrompt(job, knowledgeText, confirmedEvidence);
  let docs: DocumentSections = {};
  let missing: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nYour previous answer was incomplete: the following document(s) were missing or replaced by a placeholder note instead of full content: ${missing.join(", ")}. Re-output ALL FOUR documents completely and inline, with full content for every document. No placeholders.`;

    const raw = await manager.run({
      prompt,
      systemMessage: analysisSystemMessage() as never,
      timeoutMs: 240_000,
      onChunk,
      label: `Generate documents${attempt ? " (retry)" : ""}`,
      onTrace,
    });

    // Split on the four document headings (robust against "---" used as an
    // internal horizontal rule inside a document, which the model often does).
    docs = splitByHeadings(raw);
    if (!docs.cvEn || !docs.cvDa || !docs.coverEn || !docs.coverDa) {
      // Fallback: split on lines that are exactly "---" (allow surrounding whitespace).
      const parts = raw
        .split(/\r?\n\s*---\s*\r?\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const [cvEn, cvDa, coverEn, coverDa] = parts;
      if (cvEn) docs.cvEn = cvEn;
      if (cvDa) docs.cvDa = cvDa;
      if (coverEn) docs.coverEn = coverEn;
      if (coverDa) docs.coverDa = coverDa;
    }

    missing = missingDocs(docs);
    if (missing.length === 0) {
      return docs as GeneratedDocuments;
    }
    console.warn(`⚠️ Generation attempt ${attempt + 1} produced placeholders/missing docs: ${missing.join(", ")}. Retrying…`);
  }

  return {
    cvEn: docs.cvEn ?? "CV - English\n\n(Generation failed - please try again.)",
    cvDa: docs.cvDa ?? "CV - Dansk\n\n(Generation failed - please try again.)",
    coverEn: docs.coverEn ?? "Cover Letter - English\n\n(Generation failed - please try again.)",
    coverDa: docs.coverDa ?? "Ansogning - Dansk\n\n(Generation failed - please try again.)",
  };
}

/** Patterns that mark a "document" as a placeholder note rather than real content. */
const PLACEHOLDER_RE =
  /\b(saved|written|see|refer(?:ence)?d?|available|identical|full translation|same as|as above|see above|attached)\b[\s\S]{0,50}\b(file|document|above|translation|version|below|here|structure)\b\.?/i;

/** A section is valid if it is long enough and doesn't start with a placeholder note. */
function isValidSection(text: string | undefined): text is string {
  if (!text) return false;
  if (text.split(/\s+/).length < 40) return false; // too short to be a real document
  // A placeholder note sits at the very start of the section; real documents
  // begin with their title/heading and content.
  if (PLACEHOLDER_RE.test(text.slice(0, 300))) return false;
  return true;
}

/** Returns the list of document names that are missing or are placeholders. */
function missingDocs(docs: DocumentSections): string[] {
  const labels: Record<keyof DocumentSections, string> = {
    cvEn: "CV (English)",
    cvDa: "CV (Dansk)",
    coverEn: "Cover Letter (English)",
    coverDa: "Ansøgning (Dansk)",
  };
  return (Object.keys(labels) as (keyof DocumentSections)[]).filter(
    (k) => !isValidSection(docs[k]),
  );
}

interface DocumentSections {
  cvEn?: string;
  cvDa?: string;
  coverEn?: string;
  coverDa?: string;
}

/**
 * Splits the model's response into four documents by locating each document's
 * title heading (e.g. "## CV - English" or "## Cover Letter - English").
 * Robust against the model using "---" as an internal horizontal rule inside
 * documents (which the old "---"-split broke on) and against language words
 * being absent from the heading (English and Danish CV headings are often
 * identical). Documents are assigned by order of appearance:
 * 1st CV → English, 2nd CV → Danish, 1st cover/ansøgning → English, 2nd → Danish.
 */
function splitByHeadings(raw: string): DocumentSections {
  // Normalise common em/en dashes so heading matching is reliable.
  const lines = raw.replace(/[—–]/g, "-").split(/\r?\n/);

  // A "document heading" is a markdown heading whose body begins with one of
  // the four document titles.
  const DOC_RE =
    /^#{1,4}\s*(CV|Curriculum\s*Vitae|Cover\s*Letter|Ans\W*gning|Motivationsskrivelse)\b/i;

  const docLines: { index: number; kind: "cv" | "cover" }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const body = lines[i].trim();
    if (!DOC_RE.test(body)) continue;
    const kind = /^#{1,4}\s*(CV|Curriculum\s*Vitae)\b/i.test(body) ? "cv" : "cover";
    docLines.push({ index: i, kind });
  }

  const cvs = docLines.filter((d) => d.kind === "cv").slice(0, 2);
  const covers = docLines.filter((d) => d.kind === "cover").slice(0, 2);
  const anchors = [cvs[0], cvs[1], covers[0], covers[1]];
  if (anchors.some((a) => !a)) return {}; // need at least 1 CV + 1 cover pair

  const take = (anchor: { index: number }, nextIndex: number | null) =>
    lines
      .slice(anchor.index, nextIndex ?? lines.length)
      .join("\n")
      .trim();

  const positions = anchors.map((a) => a!.index).sort((a, b) => a - b);
  const byPos = new Map(anchors.map((a) => [a!.index, a]));
  const ordered = positions.map((p) => byPos.get(p)!);

  const sections: DocumentSections = {};
  let coverSeen = 0;
  for (let i = 0; i < ordered.length; i++) {
    const body = take(ordered[i], positions[i + 1] ?? null);
    if (!body) continue;
    if (ordered[i].kind === "cv") {
      sections[i === 0 ? "cvEn" : "cvDa"] = body;
    } else {
      sections[coverSeen === 0 ? "coverEn" : "coverDa"] = body;
      coverSeen++;
    }
  }
  return sections;
}
