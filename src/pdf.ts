import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium } from "playwright";
import { marked } from "marked";

export type PdfKind = "cv" | "cover";

/** ATS-safe single-column styling: web-safe fonts, standard headings, real text. */
function cvTemplate(htmlBody: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
    font-size: 10.5pt;
    color: #1a1a1a;
    line-height: 1.45;
    margin: 0;
    padding: 0;
  }
  .doc-title { font-size: 17pt; font-weight: bold; margin: 0 0 2pt 0; }
  .contact-line { font-size: 9.5pt; color: #333; margin-bottom: 14pt; }
  h1 { font-size: 15pt; font-weight: bold; margin: 14pt 0 4pt 0; }
  h2 { font-size: 12pt; font-weight: bold; margin: 12pt 0 3pt 0; border-bottom: 0.75pt solid #999; padding-bottom: 2pt; }
  h3 { font-size: 11pt; font-weight: bold; margin: 10pt 0 2pt 0; }
  p { margin: 4pt 0; }
  ul { margin: 3pt 0 6pt 0; padding-left: 14pt; }
  li { margin: 2pt 0; }
  strong { font-weight: bold; }
  em { font-style: italic; }
  a { color: inherit; text-decoration: none; }
</style>
</head>
<body>${htmlBody}</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Cover letter: a proper business-letter layout built from markdown.  */
/* ------------------------------------------------------------------ */

const DATE_RE =
  /\b\d{1,2}(?:st|nd|rd|th)?\.?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Januar|Februar|Marts|Maj|Juni|Juli|August|September|Oktober|November|December)\s+\d{4}\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b/i;
const SUBJECT_RE = /^(?:Re\s*:|Subject\s*:|Vedr\.?\s*:|Ang\.?\s*:|Ans[øo]gning om|Applying for)/i;
const SALUTATION_RE = /^(?:Dear|K[æa]re|Hej|Hello|Hi)\b/i;
const CLOSING_RE = /^(?:Kind regards|Best regards|Sincerely|Yours sincerely|Med venlig hilsen|Venlig hilsen|Med venskabelig hilsen)\b/i;

/** Escapes HTML and strips inline markdown emphasis from plain text fields. */
function plain(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^#{1,4}\s*/, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

interface CoverLetterParts {
  letterheadName: string;
  letterheadContact: string;
  date: string;
  recipient: string[];
  subject: string;
  salutation: string;
  body: string[][];
  closing: string;
  signatureName: string;
  signatureContact: string;
}

/** Splits cover-letter markdown into the structural parts of a letter. */
function parseCoverLetter(markdown: string): CoverLetterParts {
  const parts: CoverLetterParts = {
    letterheadName: "",
    letterheadContact: "",
    date: "",
    recipient: [],
    subject: "",
    salutation: "",
    body: [],
    closing: "",
    signatureName: "",
    signatureContact: "",
  };

  const lines = markdown.split(/\r?\n/).map((l) => l.trim());
  // Drop the document title heading(s) ("## Cover Letter - English").
  const content = lines.filter(
    (l) => !/^#{1,4}\s*(?:Cover Letter|Ans[øo]gning)\b/i.test(l),
  );

  // Group into blocks separated by blank lines.
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const line of content) {
    if (line === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);

  // Letterhead = first block: name on line 1, contact on line 2.
  if (blocks.length) {
    const first = blocks.shift()!;
    parts.letterheadName = plain(first[0] ?? "");
    parts.letterheadContact = plain(first.slice(1).join(" · "));
  }

  // Classify the remaining blocks in order.
  let inBody = false;
  let closingSeen = false;
  for (const block of blocks) {
    const text = block.join(" ");
    if (!parts.date && DATE_RE.test(text)) {
      parts.date = plain(text);
      continue;
    }
    if (!parts.subject && SUBJECT_RE.test(text)) {
      parts.subject = plain(text);
      continue;
    }
    if (!parts.salutation && SALUTATION_RE.test(text)) {
      parts.salutation = plain(text);
      inBody = true;
      continue;
    }
    if (!parts.closing && CLOSING_RE.test(text)) {
      parts.closing = plain(text);
      closingSeen = true;
      continue;
    }
    if (closingSeen) {
      // Signature block: name, then contact line.
      if (!parts.signatureName && block.length) parts.signatureName = plain(block[0]);
      if (block.length > 1) parts.signatureContact = plain(block.slice(1).join(" · "));
      continue;
    }
    if (inBody) {
      parts.body.push(block);
    } else {
      // Between letterhead and salutation: company/recipient address block.
      parts.recipient.push(...block.map(plain));
    }
  }

  // If the model omitted the closing, treat the last short block as signature.
  if (!closingSeen && parts.body.length >= 2) {
    const last = parts.body[parts.body.length - 1];
    if (last.length <= 2 && /[A-Za-z]/.test(last[0] ?? "")) {
      parts.signatureName = plain(last[0] ?? "");
      if (last[1]) parts.signatureContact = plain(last[1]);
      parts.body.pop();
    }
  }

  return parts;
}

/** Renders a cover letter as a proper business letter (ATS-safe real text). */
function coverLetterTemplate(p: CoverLetterParts): string {
  const bodyParagraphs = p.body
    .map((block) => `<p>${marked.parseInline(block.join(" "), { async: false })}</p>`)
    .join("\n");

  const recipientHtml = p.recipient
    .map((l) => `<div class="recipient-line">${l}</div>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
    font-size: 10.5pt;
    color: #1a1a1a;
    line-height: 1.5;
    margin: 0;
    padding: 0;
  }
  .letter { max-width: 100%; }
  .letterhead {
    border-bottom: 2pt solid #1f3a5f;
    padding-bottom: 10pt;
    margin-bottom: 18pt;
  }
  .letterhead .name { font-size: 20pt; font-weight: bold; color: #1f3a5f; letter-spacing: 0.4pt; }
  .letterhead .contact { font-size: 9.5pt; color: #555; margin-top: 4pt; }
  .date { font-size: 10.5pt; color: #333; margin-bottom: 14pt; }
  .recipient { margin-bottom: 14pt; line-height: 1.5; }
  .recipient-line { margin: 0; }
  .subject { font-weight: bold; font-size: 11pt; color: #1f3a5f; margin-bottom: 12pt; }
  .salutation { margin: 0 0 10pt 0; }
  .body p { margin: 0 0 10pt 0; text-align: justify; }
  .closing { margin-top: 16pt; }
  .signature { margin-top: 30pt; }
  .signature .sig-name { font-weight: bold; font-size: 12pt; }
  .signature .sig-contact { font-size: 9.5pt; color: #555; margin-top: 3pt; }
  strong { font-weight: bold; }
  em { font-style: italic; }
  a { color: inherit; text-decoration: none; }
</style>
</head>
<body>
<div class="letter">
  <div class="letterhead">
    <div class="name">${p.letterheadName}</div>
    ${p.letterheadContact ? `<div class="contact">${p.letterheadContact}</div>` : ""}
  </div>
  ${p.date ? `<div class="date">${p.date}</div>` : ""}
  ${recipientHtml ? `<div class="recipient">${recipientHtml}</div>` : ""}
  ${p.subject ? `<div class="subject">${p.subject}</div>` : ""}
  ${p.salutation ? `<div class="salutation">${p.salutation}</div>` : ""}
  <div class="body">
${bodyParagraphs || "<p></p>"}
  </div>
  ${p.closing ? `<div class="closing">${p.closing}</div>` : ""}
  <div class="signature">
    <div class="sig-name">${p.signatureName}</div>
    ${p.signatureContact ? `<div class="sig-contact">${p.signatureContact}</div>` : ""}
  </div>
</div>
</body>
</html>`;
}

/** Converts markdown to a styled HTML string for PDF rendering. */
function markdownToHtml(markdown: string, kind: PdfKind): string {
  if (kind === "cover") return coverLetterTemplate(parseCoverLetter(markdown));
  const raw = marked.parse(markdown, { async: false }) as string;
  // Defense-in-depth: remove any script/style tags.
  const safe = raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  return cvTemplate(safe);
}

/**
 * Renders markdown to an ATS-safe PDF at outPath using headless Chromium.
 * Returns the absolute path to the generated file.
 */
export async function markdownToPdf(
  markdown: string,
  outPath: string,
  kind: PdfKind,
): Promise<string> {
  const html = markdownToHtml(markdown, kind);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", right: "14mm", bottom: "16mm", left: "14mm" },
      preferCSSPageSize: false,
    });
  } finally {
    await browser.close();
  }
  return outPath;
}
