import * as fs from "node:fs/promises";
import * as zlib from "node:zlib";
import type {
  ApplicationPreflightReport,
  ApplicationStatus,
  DocumentKind,
  DocumentLanguage,
  PdfPreflightReport,
} from "./types.js";

/**
 * Deterministic PDF preflight. No LLM calls: everything here is a plain,
 * repeatable check against the actual bytes of the generated PDF (not the
 * markdown source), so a regression in rendering (fonts not embedding,
 * blank pages, a stray template placeholder) is caught before the file is
 * ever handed to the candidate.
 */

// ── Minimal PDF text extraction (FlateDecode content streams) ──────────────

interface RawPdfObject {
  dict: string;
  streamBytes: Buffer | null;
}

/** Parses indirect objects (`N G obj ... endobj`) out of a raw PDF buffer. */
function parseIndirectObjects(buffer: Buffer): Map<number, RawPdfObject> {
  // latin1 keeps a 1:1 byte<->char mapping so slices can be converted back
  // to exact original bytes for stream decoding.
  const text = buffer.toString("latin1");
  const objects = new Map<number, RawPdfObject>();
  const objRe = /(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g;
  let match: RegExpExecArray | null;
  while ((match = objRe.exec(text))) {
    const num = Number(match[1]);
    const body = match[2];
    const streamMatch = /stream\r?\n([\s\S]*?)\r?\n?endstream/.exec(body);
    let streamBytes: Buffer | null = null;
    let dict = body;
    if (streamMatch) {
      dict = body.slice(0, streamMatch.index);
      streamBytes = Buffer.from(streamMatch[1], "latin1");
    }
    objects.set(num, { dict, streamBytes });
  }
  return objects;
}

/** Decodes a content/object stream, honoring /Filter /FlateDecode when present. */
function decodeStream(obj: RawPdfObject): string {
  if (!obj.streamBytes) return "";
  const usesFlate = /\/Filter\s*(?:\/FlateDecode|\[[^\]]*\/FlateDecode[^\]]*\])/.test(obj.dict);
  if (!usesFlate) return obj.streamBytes.toString("latin1");
  try {
    return zlib.inflateSync(obj.streamBytes).toString("latin1");
  } catch {
    return "";
  }
}

/** Decodes a PDF literal-string escape sequence body, e.g. from `(Hello\)World)`. */
function decodePdfLiteralString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      const octal = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? "";
      out += String.fromCharCode(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    switch (next) {
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "(": out += "("; break;
      case ")": out += ")"; break;
      case "\\": out += "\\"; break;
      case "\r": case "\n": break; // escaped line break: ignore
      default: out += next;
    }
    i += 1;
  }
  return out;
}

// ── ToUnicode CMap parsing ───────────────────────────────────────────────
//
// Chromium (and most modern PDF writers) embed subset fonts as Type0/CID
// fonts with `/Encoding /Identity-H`: the bytes shown by Tj/TJ are glyph
// codes, not character codes, so they only become readable text via each
// font's `/ToUnicode` CMap. Without this step "text extraction" would
// silently return glyph-index gibberish or nothing at all.

function hexToCodeUnits(hex: string): number[] {
  const units: number[] = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return units;
}

function codeUnitsToString(units: number[]): string {
  return String.fromCharCode(...units);
}

/** Parses a `/ToUnicode` CMap stream's bfchar/bfrange sections into code → Unicode text. */
function parseToUnicodeCMap(cmapText: string): Map<number, string> {
  const map = new Map<number, string>();

  for (const block of cmapText.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), codeUnitsToString(hexToCodeUnits(m[2])));
    }
  }

  for (const block of cmapText.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    // Array form: <start> <end> [ <d1> <d2> ... ]
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g)) {
      const start = parseInt(m[1], 16);
      const dsts = [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((d) => codeUnitsToString(hexToCodeUnits(d[1])));
      dsts.forEach((unicode, i) => map.set(start + i, unicode));
    }
    // Linear form: <start> <end> <dstStart>
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(m[1], 16);
      const end = parseInt(m[2], 16);
      const dstUnits = hexToCodeUnits(m[3]);
      for (let code = start; code <= end; code++) {
        const units = [...dstUnits];
        units[units.length - 1] += code - start;
        map.set(code, codeUnitsToString(units));
      }
    }
  }

  return map;
}

/** Resolves each `/Font` resource name (e.g. "F4") used on a page to its ToUnicode map, if any. */
function resolveFontToUnicodeMaps(
  pageObj: RawPdfObject,
  objects: Map<number, RawPdfObject>,
): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();

  let resourceDictText = pageObj.dict;
  const indirectResources = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageObj.dict);
  if (indirectResources) {
    resourceDictText = objects.get(Number(indirectResources[1]))?.dict ?? "";
  }

  const fontDictMatch = /\/Font\s*<<([\s\S]*?)>>/.exec(resourceDictText);
  if (!fontDictMatch) return result;

  for (const m of fontDictMatch[1].matchAll(/\/(\S+)\s+(\d+)\s+\d+\s+R/g)) {
    const [, resourceName, fontObjNumStr] = m;
    const fontObj = objects.get(Number(fontObjNumStr));
    if (!fontObj) continue;
    const toUnicodeRef = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObj.dict);
    if (!toUnicodeRef) continue;
    const cmapObj = objects.get(Number(toUnicodeRef[1]));
    if (!cmapObj) continue;
    result.set(resourceName, parseToUnicodeCMap(decodeStream(cmapObj)));
  }

  return result;
}

/** Decodes a run of hex-string bytes (from `<..>Tj`/`<..>` inside a TJ array) using a font's ToUnicode map. */
function decodeHexShowBytes(hex: string, fontMap: Map<number, string> | undefined): string {
  const cleaned = hex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 4 <= cleaned.length; i += 4) {
    const code = parseInt(cleaned.slice(i, i + 4), 16);
    if (fontMap) {
      if (fontMap.has(code)) out += fontMap.get(code);
    } else {
      // No ToUnicode available (e.g. a non-embedded simple font): best-effort
      // fallback assuming the code roughly tracks its Unicode code point.
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/** Decodes the mixed `(literal) <hex> -120 (literal) ...` payload of a TJ array. */
function decodeTJArrayTokens(arrayContent: string, fontMap: Map<number, string> | undefined): string {
  let out = "";
  const tokenRe = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(arrayContent))) {
    if (m[1] !== undefined) out += decodePdfLiteralString(m[1]);
    else if (m[2] !== undefined) out += decodeHexShowBytes(m[2], fontMap);
  }
  return out;
}

/**
 * Extracts human-readable text from a decoded PDF content stream, tracking
 * the active font (via `Tf`) so hex-encoded show strings can be resolved
 * through that font's ToUnicode CMap.
 */
function extractTextFromContentStream(content: string, fontMaps: Map<string, Map<number, string>>): string {
  const chunks: string[] = [];
  let currentFont: string | null = null;

  const opRe =
    /\/(\S+)\s+[\d.]+\s+Tf|\(((?:\\.|[^\\()])*)\)\s*'?\s*Tj|<([0-9A-Fa-f\s]*)>\s*Tj|\[((?:[^\[\]]|\\.)*)\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = opRe.exec(content))) {
    if (m[1] !== undefined) {
      currentFont = m[1];
      continue;
    }
    if (m[2] !== undefined) {
      chunks.push(decodePdfLiteralString(m[2]));
      continue;
    }
    if (m[3] !== undefined) {
      chunks.push(decodeHexShowBytes(m[3], currentFont ? fontMaps.get(currentFont) : undefined));
      continue;
    }
    if (m[4] !== undefined) {
      chunks.push(decodeTJArrayTokens(m[4], currentFont ? fontMaps.get(currentFont) : undefined));
    }
  }

  return chunks.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** Walks the page tree from the Catalog to return leaf page object numbers in document order. */
function resolvePageOrder(objects: Map<number, RawPdfObject>): number[] {
  const catalogEntry = [...objects.entries()].find(([, o]) => /\/Type\s*\/Catalog\b/.test(o.dict));
  const rootPagesRef = catalogEntry
    ? /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalogEntry[1].dict)?.[1]
    : undefined;

  const order: number[] = [];
  const visited = new Set<number>();
  const visit = (num: number): void => {
    if (visited.has(num)) return;
    visited.add(num);
    const obj = objects.get(num);
    if (!obj) return;
    if (/\/Type\s*\/Page(?!s)\b/.test(obj.dict)) {
      order.push(num);
      return;
    }
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(obj.dict);
    if (kidsMatch) {
      for (const kidMatch of kidsMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)) visit(Number(kidMatch[1]));
    }
  };

  if (rootPagesRef) visit(Number(rootPagesRef));
  if (order.length > 0) return order;

  // Fallback: no resolvable Catalog/Pages tree — take every /Type /Page object
  // in ascending object-number order (still deterministic).
  return [...objects.entries()]
    .filter(([, o]) => /\/Type\s*\/Page(?!s)\b/.test(o.dict))
    .map(([num]) => num)
    .sort((a, b) => a - b);
}

function resolveContentsText(pageObj: RawPdfObject, objects: Map<number, RawPdfObject>): string {
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageObj.dict);
  const refs: number[] = [];
  if (single) {
    refs.push(Number(single[1]));
  } else {
    const arr = /\/Contents\s*\[([^\]]*)\]/.exec(pageObj.dict);
    if (arr) for (const m of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(m[1]));
  }
  const fontMaps = resolveFontToUnicodeMaps(pageObj, objects);
  return refs
    .map((ref) => objects.get(ref))
    .filter((o): o is RawPdfObject => Boolean(o))
    .map((o) => extractTextFromContentStream(decodeStream(o), fontMaps))
    .join(" ")
    .trim();
}

export interface ExtractedPdfText {
  pages: string[];
  pageCount: number;
  totalText: string;
}

/** Deterministically extracts per-page and total text from a PDF file's raw bytes. */
export function extractTextFromPdfBuffer(buffer: Buffer): ExtractedPdfText {
  const objects = parseIndirectObjects(buffer);
  const pageOrder = resolvePageOrder(objects);
  const pages = pageOrder.map((num) => resolveContentsText(objects.get(num)!, objects));
  return { pages, pageCount: pages.length, totalText: pages.join("\n\n").trim() };
}

// ── Content analysis (pure text-based checks) ──────────────────────────────

const BLANK_PAGE_CHAR_THRESHOLD = 10;
const MIN_EXTRACTABLE_CHARS = 30;

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\{\{[^}]*\}\}/g,
  /\[\s*(?:TODO[^\]]*|PLACEHOLDER[^\]]*|INSERT[^\]]*|YOUR\s+NAME|YOUR\s+ADDRESS|COMPANY\s*NAME|XXX+)\s*\]/gi,
  /\blorem ipsum\b/gi,
  /\bTBD\b/g,
  /\bXXX+\b/g,
  /\bundefined\b/g,
  /\bNaN\b/g,
];

/** Finds placeholder/template markers left in the final rendered text. */
export function detectPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PLACEHOLDER_PATTERNS) {
    for (const m of text.matchAll(pattern)) found.add(m[0].trim());
  }
  return [...found];
}

const DANISH_CHAR_RE = /[æøåÆØÅ]/g;
const DANISH_WORDS = ["og", "ikke", "jeg", "med", "som", "for", "det", "er", "en", "et", "kompetencer", "erfaring", "uddannelse", "ansøgning", "venlig", "hilsen"];
const ENGLISH_WORDS = ["the", "and", "of", "to", "in", "is", "with", "for", "experience", "skills", "education", "regards", "sincerely"];

function countWordOccurrences(text: string, words: string[]): number {
  const lower = text.toLowerCase();
  return words.reduce((sum, word) => {
    const re = new RegExp(`\\b${word}\\b`, "g");
    return sum + (lower.match(re)?.length ?? 0);
  }, 0);
}

/** Best-effort English/Danish detection from plain extracted text; "unknown" if inconclusive. */
export function detectLanguage(text: string): DocumentLanguage | "unknown" {
  if (text.trim().length === 0) return "unknown";
  const danishScore = (text.match(DANISH_CHAR_RE)?.length ?? 0) * 3 + countWordOccurrences(text, DANISH_WORDS);
  const englishScore = countWordOccurrences(text, ENGLISH_WORDS);
  if (danishScore === 0 && englishScore === 0) return "unknown";
  if (danishScore > englishScore) return "da";
  if (englishScore > danishScore) return "en";
  return "unknown";
}

interface SectionRule {
  label: string;
  pattern: RegExp;
}

const CV_SECTION_RULES: SectionRule[] = [
  { label: "contact info (email or phone)", pattern: /[\w.+-]+@[\w-]+\.[a-z]{2,}|\+?\d[\d ()-]{6,}\d/i },
  { label: "experience section", pattern: /\b(work experience|experience|erfaring|arbejdserfaring)\b/i },
  { label: "education section", pattern: /\b(education|uddannelse)\b/i },
  { label: "skills section", pattern: /\b(skills|kompetencer)\b/i },
];

const COVER_SECTION_RULES: SectionRule[] = [
  { label: "salutation (greeting)", pattern: /\b(dear|kære|hej|hello|hi)\b/i },
  { label: "closing (sign-off)", pattern: /\b(kind regards|best regards|sincerely|med venlig hilsen|venlig hilsen)\b/i },
  { label: "date", pattern: /\b\d{1,2}\.?\s*(?:january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|marts|maj|juni|juli|oktober)\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/i },
];

/** Returns the labels of required sections that could not be found in the extracted text. */
export function findMissingSections(text: string, kind: DocumentKind): string[] {
  const rules = kind === "cv" ? CV_SECTION_RULES : COVER_SECTION_RULES;
  return rules.filter((rule) => !rule.pattern.test(text)).map((rule) => rule.label);
}

/** Heuristic check that the rendered content actually resembles the declared document kind. */
export function looksLikeDocumentType(text: string, kind: DocumentKind): boolean {
  if (kind === "cv") {
    const hits = CV_SECTION_RULES.filter((rule) => rule.pattern.test(text)).length;
    return hits >= 2;
  }
  const hasSalutation = COVER_SECTION_RULES[0].pattern.test(text);
  const hasClosing = COVER_SECTION_RULES[1].pattern.test(text);
  return hasSalutation && hasClosing;
}

// ── Report assembly ─────────────────────────────────────────────────────────

/** Builds the full deterministic report for one already-extracted PDF's text. */
export function buildPreflightReportFromText(
  file: string,
  kind: DocumentKind,
  expectedLanguage: DocumentLanguage,
  extracted: ExtractedPdfText,
): PdfPreflightReport {
  const { pages, pageCount, totalText } = extracted;
  const blankPages = pages
    .map((pageText, idx) => ({ idx: idx + 1, len: pageText.trim().length }))
    .filter((p) => p.len < BLANK_PAGE_CHAR_THRESHOLD)
    .map((p) => p.idx);

  const extractedCharCount = totalText.length;
  const textExtractable = extractedCharCount >= MIN_EXTRACTABLE_CHARS && blankPages.length < Math.max(pageCount, 1);
  const detectedLanguage = detectLanguage(totalText);
  const languageMismatch = detectedLanguage !== "unknown" && detectedLanguage !== expectedLanguage;
  const documentTypeMatch = looksLikeDocumentType(totalText, kind);
  const missingSections = findMissingSections(totalText, kind);
  const placeholders = detectPlaceholders(totalText);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (pageCount === 0) errors.push("No pages could be read from the PDF.");
  if (!textExtractable) errors.push("The PDF's text does not look reliably extractable (an ATS or recruiter tool may not be able to read it).");
  if (blankPages.length > 0) errors.push(`Blank or near-empty page(s) detected: ${blankPages.join(", ")}.`);
  if (missingSections.length > 0) errors.push(`Missing required section(s): ${missingSections.join(", ")}.`);
  if (placeholders.length > 0) errors.push(`Placeholder text left in the document: ${placeholders.join(", ")}.`);
  if (languageMismatch) errors.push(`Expected ${expectedLanguage.toUpperCase()} but detected ${String(detectedLanguage).toUpperCase()}.`);
  if (!documentTypeMatch) errors.push(`Content does not look like a ${kind === "cv" ? "CV" : "cover letter"}.`);

  if (kind === "cv" && pageCount > 2) warnings.push(`CV is ${pageCount} pages long; 1-2 pages is recommended.`);
  if (detectedLanguage === "unknown") warnings.push("Could not confidently detect the document's language.");

  return {
    file,
    kind,
    expectedLanguage,
    checkedAt: new Date().toISOString(),
    pageCount,
    blankPages,
    textExtractable,
    extractedCharCount,
    detectedLanguage,
    languageMismatch,
    documentTypeMatch,
    missingSections,
    placeholders,
    errors,
    warnings,
    passed: errors.length === 0,
  };
}

/** Reads a PDF from disk and runs the full deterministic preflight against it. */
export async function analyzePdfFile(
  filePath: string,
  kind: DocumentKind,
  expectedLanguage: DocumentLanguage,
): Promise<PdfPreflightReport> {
  const buffer = await fs.readFile(filePath);
  const extracted = extractTextFromPdfBuffer(buffer);
  return buildPreflightReportFromText(filePath, kind, expectedLanguage, extracted);
}

/** Aggregates per-document reports into the application-level preflight report. */
export function buildApplicationPreflightReport(documents: PdfPreflightReport[]): ApplicationPreflightReport {
  const overallPassed = documents.length > 0 && documents.every((d) => d.passed);
  const status: ApplicationStatus = overallPassed ? "sendable" : "draft";
  return {
    generatedAt: new Date().toISOString(),
    documents,
    overallPassed,
    status,
  };
}
