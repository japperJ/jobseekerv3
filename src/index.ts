import * as fs from "node:fs/promises";
import * as path from "node:path";
import express from "express";
import { config, PROJECT_ROOT } from "./config.js";
import { createLlmManager, type LlmManager, type TraceEvent } from "./llm/index.js";
import { TraceStore } from "./trace.js";
import {
  loadAllKnowledge,
  appendConfirmedSkill,
  isKnowledgeFile,
  listKnowledge,
  saveKnowledge,
} from "./knowledge.js";
import { analyzeJobListing } from "./analysis.js";
import { askGapQuestion, interpretAnswer } from "./interview.js";
import { generateApplicationDocuments } from "./generation.js";
import { markdownToPdf } from "./pdf.js";
import { saveApplication, readIndex, deleteApplication } from "./applications.js";
import { buildListingPreview } from "./listing-preview.js";
import {
  applyOverride,
  buildPendingKnowledgeItem,
  buildReviewMatrix,
  recomputeCoverageFromAssessments,
} from "./requirement-review.js";
import { analyzePdfFile, buildApplicationPreflightReport } from "./pdf-preflight.js";
import { DEFAULT_PROMPT_TEMPLATES, idleChatPrompt } from "./prompts.js";
import {
  isEditablePromptId,
  listPromptEntries,
  resetPrompt,
  savePrompt,
} from "./prompt-settings.js";
import type { ClientState, ListingPreview, MatchAssessment, ProfileCoverage } from "./types.js";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(PROJECT_ROOT, "src", "public")));

const manager: LlmManager = createLlmManager();
const clients = new Map<string, ClientState>();
const traces = new TraceStore();

function traceSink(clientId: string): (event: TraceEvent) => void {
  return (event) => traces.route(clientId, event);
}

function newState(): ClientState {
  return {
    phase: "idle",
    job: null,
    analysis: null,
    listingText: "",
    remaining: [],
    answers: [],
    confirmed: [],
    pendingListing: null,
    reviewMatrix: [],
    pendingKnowledge: [],
  };
}

function getState(clientId: string): ClientState {
  if (!clients.has(clientId)) clients.set(clientId, newState());
  const st = clients.get(clientId)!;
  // Lightweight memory guard.
  if (clients.size > 500) {
    const first = clients.keys().next().value;
    if (first !== undefined && first !== clientId) clients.delete(first);
  }
  return st;
}

// ── Message classification helpers ────────────────────────────────────────

function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

function looksLikeListing(text: string): boolean {
  const t = text.trim();
  if (t.length >= 120) return true;
  return /(we are looking|we'?re looking|ansøg|stilling|stillingsopslag|job title|responsibilities|qualifications|requirements|about the role|apply now|søg stillingen|om stillingen|dine opgaver|dine kvalifikationer)/i.test(t);
}

function isSkipInterviewIntent(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /^(skip|next|spring|næste|done|færdig|generate|kør|go)\b/i.test(t.trim()) ||
    /\b(skip the rest|spring resten over|go to generation|skip the interview|jump to pdfs)\b/.test(t)
  );
}

function isGenerateIntent(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/^(generate|go|kør|start|lav det|make it)$/.test(t)) return true;
  return (
    /\b(generate|generer|lav|opret|create|make)\b/.test(t) &&
    /\b(pdf|cv|ansøgning|cover|application|fil|document|dokument)\b/.test(t)
  );
}

function isResetIntent(text: string): boolean {
  return /^(reset|restart|nyt|new|clear|nulstil)$/i.test(text.trim());
}

function isCancelIntent(text: string): boolean {
  return /^(cancel|discard|nej|nej tak|no|afbryd|annull[ée]r)$/i.test(text.trim());
}

function isConfirmIntent(text: string): boolean {
  return /^(confirm|use this|use it|godkend|ja|yes|proceed|continue|analyze|analys[ée]r)$/i.test(text.trim());
}

function isApproveIntent(text: string): boolean {
  return /^(approve|approve all|godkend|godkend alle|save|save all|gem|gem alle)$/i.test(text.trim());
}

function isSkipSaveIntent(text: string): boolean {
  return /^(skip|discard|don'?t save|do not save|spring over|afvis|nej tak)$/i.test(text.trim());
}

function normalizeVerdict(value: unknown): MatchAssessment["verdict"] {
  return (["yes", "partial", "no", "uncertain", "not_relevant"] as const).includes(value as never)
    ? value as MatchAssessment["verdict"]
    : "uncertain";
}

/** Formats the extraction-preview payload as a chat message for the URL-ingestion review step. */
function buildPreviewMessage(preview: ListingPreview): string {
  const qualityLabel = { good: "✅ Good", fair: "⚠️ Fair", poor: "❌ Poor" }[preview.quality];
  const warnings = preview.warnings.length ? preview.warnings.map((w) => `- ${w}`).join("\n") : "- None";
  const g = preview.guess;
  return (
    `🔎 **Extraction preview** from ${preview.url}\n\n` +
    `Extraction quality: **${qualityLabel}**\n${warnings}\n\n` +
    `Guessed fields (edit if wrong):\n- Company: ${g.company ?? "_unknown_"}\n- Title: ${g.title ?? "_unknown_"}\n- Location: ${g.location ?? "_unknown_"}\n\n` +
    `Review the exact extracted text below, then **confirm** to analyze it, **cancel** to discard, or paste the listing text yourself to use that instead.`
  );
}

// ── Workflow steps ────────────────────────────────────────────────────────

interface MessageResponse {
  type:
    | "chat"
    | "listingPreview"
    | "analysis"
    | "question"
    | "answerSaved"
    | "review"
    | "ready"
    | "generated"
    | "error"
    | "reset";
  message: string;
  [k: string]: unknown;
}

function coverageHeadline(coverage: ProfileCoverage, job: { role: string; company: string | null; location: string | null }): string {
  return `📊 **Profile coverage: ${coverage.percentage}%** (${coverage.coveredCount}/${coverage.totalCount} requirements) for **${job.role}** at ${job.company ?? "the company"}${job.location ? ` — ${job.location}` : ""}.`;
}

interface ListingFieldOverrides {
  company?: string;
  title?: string;
  location?: string;
}

async function runAnalysis(
  state: ClientState,
  listingText: string,
  clientId: string,
  fieldOverrides?: ListingFieldOverrides,
): Promise<MessageResponse> {
  const knowledge = await loadAllKnowledge();
  const onTrace = traceSink(clientId);
  const analysis = await analyzeJobListing(listingText, knowledge, manager, onTrace);

  // User-edited fields from the extraction preview always win over the model's guess.
  if (fieldOverrides?.company?.trim()) analysis.job.company = fieldOverrides.company.trim();
  if (fieldOverrides?.title?.trim()) analysis.job.role = fieldOverrides.title.trim();
  if (fieldOverrides?.location?.trim()) analysis.job.location = fieldOverrides.location.trim();

  state.job = analysis.job;
  state.analysis = analysis;
  state.listingText = listingText;
  state.remaining = [...analysis.missing];
  state.answers = [];
  state.confirmed = [];
  state.pendingListing = null;
  state.reviewMatrix = buildReviewMatrix(analysis.job.requirements, analysis.assessments);
  state.pendingKnowledge = [];

  const job = analysis.job;
  const head = coverageHeadline(analysis.coverage, job);

  if (analysis.missing.length === 0) {
    state.phase = "ready";
    return {
      type: "ready",
      message: `${head}\n\nGreat news — your profile covers all the listed requirements! Type **generate** to create the CV and cover letter PDFs.`,
      job,
      coverage: analysis.coverage,
      matrix: state.reviewMatrix,
      covered: analysis.covered.map((r) => r.text),
      missing: [],
    };
  }

  state.phase = "interview";
  const next = state.remaining[0];
  const question = await askGapQuestion(next, job, 1, analysis.missing.length, manager, onTrace);
  return {
    type: "analysis",
    message: `${head}\n\nI found **${analysis.missing.length}** requirement${analysis.missing.length === 1 ? "" : "s"} your profile doesn't clearly cover. I'll ask about them one at a time. Anything you confirm is used for this application right away, and — only after you explicitly approve it in the review step — saved for future applications too.\n\n**${question}**`,
    job,
    coverage: analysis.coverage,
    matrix: state.reviewMatrix,
    covered: analysis.covered.map((r) => r.text),
    missing: analysis.missing.map((r) => r.text),
    question,
    remaining: analysis.missing.length,
    total: analysis.missing.length,
  };
}


async function processAnswer(
  state: ClientState,
  userMessage: string,
  clientId: string,
): Promise<MessageResponse> {
  const req = state.remaining[0];
  const onTrace = traceSink(clientId);
  const interpreted = await interpretAnswer(req, userMessage, manager, onTrace);

  state.answers.push({ requirement: req, ...interpreted });
  state.remaining.shift();

  const job = state.job!;
  let proposalNote = "";

  if (interpreted.has && !interpreted.unsure) {
    // Usable for THIS application's documents immediately, but writing it to
    // the knowledge folder permanently waits for explicit review + approval.
    state.confirmed.push(
      interpreted.evidence ? `${req.text} — ${interpreted.evidence}` : req.text,
    );
    const pending = buildPendingKnowledgeItem(req.text, interpreted.evidence, `${job.company ?? ""} ${job.role}`.trim());
    state.pendingKnowledge.push(pending);
    proposalNote = `📝 Noted for this application: *${req.text}*${interpreted.evidence ? ` — ${interpreted.evidence}` : ""} (you'll approve what gets saved permanently at the end).`;
  }

  if (state.remaining.length === 0) {
    if (state.pendingKnowledge.length === 0) {
      state.phase = "ready";
      return {
        type: "ready",
        message: `${proposalNote}\n✅ Interview complete — ${state.answers.length} question${state.answers.length === 1 ? "" : "s"} asked. Nothing new to save to your knowledge folder.\n\nType **generate** to create the CV and cover letter PDFs (Danish + English).`,
        confirmed: [...state.confirmed],
        remaining: 0,
        total: state.answers.length,
      };
    }
    state.phase = "review";
    return buildReviewResponse(
      state,
      `${proposalNote}\n✅ Interview complete — ${state.answers.length} question${state.answers.length === 1 ? "" : "s"} asked.\n\n` +
        `Below is what I'd add to your knowledge folder **permanently** (used for every future application). Review each item, uncheck anything you don't want kept, then approve.`,
    );
  }

  const next = state.remaining[0];
  const question = await askGapQuestion(
    next,
    job,
    state.answers.length + 1,
    state.answers.length + state.remaining.length,
    manager,
    onTrace,
  );
  return {
    type: "question",
    message: `${proposalNote}\n**${question}**`,
    question,
    remaining: state.remaining.length,
    total: state.answers.length + state.remaining.length,
    confirmed: [...state.confirmed],
  };
}

/** Builds the "review" phase payload: the compact matrix plus pending knowledge writes awaiting approval. */
function buildReviewResponse(state: ClientState, message: string): MessageResponse {
  return {
    type: "review",
    message,
    coverage: state.analysis?.coverage ?? null,
    matrix: state.reviewMatrix,
    pendingKnowledge: state.pendingKnowledge,
    confirmed: [...state.confirmed],
  };
}

/**
 * Applies the user's explicit review decisions: writes approved knowledge
 * items to disk (permanent mutation) and applies any requirement-verdict
 * overrides, recomputing coverage. This is the only path that permanently
 * mutates the knowledge folder from interview answers.
 */
async function applyReviewDecisions(
  state: ClientState,
  approvedIds: Set<string> | null,
  overrides: Array<{ index: number; verdict: MatchAssessment["verdict"]; note: string }> = [],
): Promise<{ savedCount: number; savedItems: string[] }> {
  const savedItems: string[] = [];
  for (const item of state.pendingKnowledge) {
    const approved = approvedIds ? approvedIds.has(item.id) : item.approved;
    if (!approved) continue;
    const result = await appendConfirmedSkill(item.requirementText, item.evidence, item.context);
    if (result.appended) savedItems.push(item.requirementText);
  }

  applyAssessmentOverrides(state, overrides);

  state.pendingKnowledge = [];
  state.phase = "ready";
  return { savedCount: savedItems.length, savedItems };
}

function applyAssessmentOverrides(
  state: ClientState,
  overrides: Array<{ index: number; verdict: MatchAssessment["verdict"]; note: string }>,
): void {
  if (overrides.length === 0 || !state.analysis) return;
  let assessments = state.analysis.assessments;
  for (const o of overrides) assessments = applyOverride(assessments, o.index, o.verdict, o.note);
  state.analysis.assessments = assessments;
  state.reviewMatrix = buildReviewMatrix(state.analysis.job.requirements, assessments);
  const coverage = recomputeCoverageFromAssessments(assessments, state.analysis.job.requirements.length);
  state.analysis.coverage = coverage;
  state.analysis.score = coverage.percentage;
  const byIndex = new Map(assessments.map((a) => [a.index, a.verdict]));
  state.analysis.covered = state.analysis.job.requirements.filter((_, i) => {
    const v = byIndex.get(i);
    return v === "yes" || v === "partial";
  });
  state.analysis.missing = state.analysis.job.requirements.filter((_, i) => {
    const v = byIndex.get(i);
    return !(v === "yes" || v === "partial");
  });
}

async function generatePdfs(state: ClientState, jobDescriptionText: string, clientId: string): Promise<MessageResponse> {
  if (!state.job || !state.analysis) {
    return { type: "error", message: "No job analysis found. Paste a job listing first." };
  }
  const knowledge = await loadAllKnowledge();
  const job = state.job;

  const docs = await generateApplicationDocuments(
    job,
    knowledge,
    state.confirmed,
    manager,
    undefined,
    traceSink(clientId),
  );

  // Render PDFs to a staging area, then move into the application folder.
  const staging = path.join(PROJECT_ROOT, "applications", ".staging", Date.now().toString());
  await fs.mkdir(staging, { recursive: true });
  const tmp = (name: string) => path.join(staging, name);

  await markdownToPdf(docs.cvEn, tmp("cv-en.pdf"), "cv");
  await markdownToPdf(docs.cvDa, tmp("cv-da.pdf"), "cv");
  await markdownToPdf(docs.coverEn, tmp("cover-en.pdf"), "cover");
  await markdownToPdf(docs.coverDa, tmp("cover-da.pdf"), "cover");

  // Deterministic preflight MUST run before saveApplication so a failing
  // check is caught, reported, and persisted before the files are archived
  // and the applications index is updated.
  const preflightDocs = await Promise.all([
    analyzePdfFile(tmp("cv-en.pdf"), "cv", "en"),
    analyzePdfFile(tmp("cv-da.pdf"), "cv", "da"),
    analyzePdfFile(tmp("cover-en.pdf"), "cover", "en"),
    analyzePdfFile(tmp("cover-da.pdf"), "cover", "da"),
  ]);
  const preflight = buildApplicationPreflightReport(preflightDocs);

  const files = await saveApplication(
    job,
    jobDescriptionText,
    {
      cvEn: tmp("cv-en.pdf"),
      cvDa: tmp("cv-da.pdf"),
      coverEn: tmp("cover-en.pdf"),
      coverDa: tmp("cover-da.pdf"),
    },
    state.analysis.score,
    preflight,
  );

  await fs.rm(staging, { recursive: true, force: true }).catch(() => {});

  const rel = (p: string) => p.slice(PROJECT_ROOT.length).replace(/\\/g, "/");
  const statusLine = preflight.overallPassed
    ? "✅ **Preflight passed — this package is sendable.**"
    : `⚠️ **Preflight found issues — saved as a DRAFT, review before sending.**\n${preflight.documents
        .filter((d) => !d.passed)
        .map((d) => `- ${path.basename(d.file)}: ${d.errors.join(" ")}`)
        .join("\n")}`;
  return {
    type: "generated",
    message: `🎉 **Done!** Your application package for **${job.role}** at **${job.company ?? "the company"}** is ready:\n\n📄 CV (English) · 📄 CV (Dansk) · 💌 Cover Letter (English) · 💌 Ansøgning (Dansk)\n\n${statusLine}\n\nOpen the **Applications** panel on the left to download your files.`,
    status: preflight.status,
    preflight,
    files: {
      folder: files.folder,
      cvEn: rel(files.cvEn),
      cvDa: rel(files.cvDa),
      coverEn: rel(files.coverEn),
      coverDa: rel(files.coverDa),
    },
  };
}

// ── Main chat handler ─────────────────────────────────────────────────────

async function handleMessage(clientId: string, userMessage: string): Promise<MessageResponse> {
  const state = getState(clientId);
  const msg = userMessage.trim();
  if (!msg) return { type: "error", message: "Empty message." };

  // Reset command works in any phase.
  if (isResetIntent(msg)) {
    clients.set(clientId, newState());
    traces.clear(clientId);
    return { type: "reset", message: "State cleared. Paste a new job listing to start over." };
  }

  switch (state.phase) {
    case "idle": {
      if (isUrl(msg)) {
        try {
          const preview = await buildListingPreview(msg);
          if (preview.text.length < 50) {
            return { type: "error", message: "Could not read any content from that URL. Try pasting the job description as text instead." };
          }
          state.pendingListing = preview;
          state.phase = "listingPreview";
          return { type: "listingPreview", message: buildPreviewMessage(preview), preview };
        } catch (err) {
          return { type: "error", message: `Failed to fetch that URL: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      if (looksLikeListing(msg)) {
        // Pasted-text path never goes through the URL extraction preview.
        return await runAnalysis(state, msg, clientId);
      }
      const reply = await manager.run({
        prompt: await idleChatPrompt(msg),
        timeoutMs: 60_000,
        label: "Chat reply",
        onTrace: traceSink(clientId),
      });
      return { type: "chat", message: reply || "Paste a job listing (or a URL) and I'll build your tailored CV and cover letter." };
    }

    case "listingPreview": {
      if (isCancelIntent(msg)) {
        state.pendingListing = null;
        state.phase = "idle";
        return { type: "chat", message: "Discarded. Paste a job listing or a URL to start over." };
      }
      if (isUrl(msg)) {
        try {
          const preview = await buildListingPreview(msg);
          if (preview.text.length < 50) {
            return { type: "error", message: "Could not read any content from that URL. Try pasting the job description as text instead." };
          }
          state.pendingListing = preview;
          return { type: "listingPreview", message: buildPreviewMessage(preview), preview };
        } catch (err) {
          return { type: "error", message: `Failed to fetch that URL: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      if (looksLikeListing(msg)) {
        // "Use pasted text" escape hatch: abandon the fetched preview entirely.
        state.pendingListing = null;
        return await runAnalysis(state, msg, clientId);
      }
      if (isConfirmIntent(msg) && state.pendingListing) {
        const preview = state.pendingListing;
        return await runAnalysis(state, preview.text, clientId);
      }
      return {
        type: "chat",
        message: "Use the preview panel to **confirm** or **cancel**, or paste the job listing text directly to use that instead.",
      };
    }

    case "interview": {
      if (isSkipInterviewIntent(msg) || state.remaining.length === 0) {
        const count = state.answers.length;
        if (state.pendingKnowledge.length > 0) {
          state.phase = "review";
          return buildReviewResponse(
            state,
            `✅ Interview skipped after ${count} question${count === 1 ? "" : "s"}.\n\nBelow is what I'd add to your knowledge folder **permanently**. Review, then approve.`,
          );
        }
        state.phase = "ready";
        return {
          type: "ready",
          message: `✅ Interview skipped after ${count} question${count === 1 ? "" : "s"}. Type **generate** to create the CV and cover letter PDFs.`,
          remaining: state.remaining.length,
        };
      }
      if (isGenerateIntent(msg)) {
        const savedCount = state.confirmed.length;
        if (state.pendingKnowledge.length > 0) {
          state.phase = "review";
          return buildReviewResponse(
            state,
            `✅ Moving on (${savedCount} item${savedCount === 1 ? "" : "s"} noted for this application).\n\nReview what to save permanently, then approve.`,
          );
        }
        state.phase = "ready";
        return {
          type: "ready",
          message: `✅ Moving on (${savedCount} item${savedCount === 1 ? "" : "s"} noted). Type **generate** to create the PDFs.`,
        };
      }
      return await processAnswer(state, msg, clientId);
    }

    case "review": {
      if (isApproveIntent(msg)) {
        const { savedCount, savedItems } = await applyReviewDecisions(state, null);
        return {
          type: "ready",
          message: `✅ Saved **${savedCount}** item${savedCount === 1 ? "" : "s"} to your knowledge folder${savedItems.length ? `: ${savedItems.join(", ")}` : ""}.\n\nType **generate** to create the CV and cover letter PDFs.`,
        };
      }
      if (isSkipSaveIntent(msg)) {
        state.pendingKnowledge = [];
        state.phase = "ready";
        return {
          type: "ready",
          message: "Okay — nothing new saved to your knowledge folder. Type **generate** to create the CV and cover letter PDFs.",
        };
      }
      return buildReviewResponse(
        state,
        "Review the items below, then type **approve** to save them permanently, or **skip** to discard without saving.",
      );
    }

    case "ready": {
      if (isGenerateIntent(msg)) {
        try {
          return await generatePdfs(state, state.listingText || msg, clientId);
        } catch (err) {
          return { type: "error", message: `Generation failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      return {
        type: "ready",
        message: "Type **generate** to create the CV and cover letter PDFs (Danish + English), or **reset** to start a new application.",
      };
    }

    default:
      return { type: "error", message: "Unknown state." };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

app.get("/api/health", async (_req, res) => {
  const providers = await manager.healthByProvider();
  res.json({
    ok: true,
    // Kept for backwards compatibility with older clients.
    copilot: providers["github-copilot"] ?? false,
    providers,
  });
});

app.get("/api/models", async (_req, res) => {
  try {
    const providers = await manager.listModelsByProvider();
    res.json({
      models: providers.flatMap((group) => group.models),
      providers,
      current: manager.getModel(),
    });
  } catch (err) {
    console.error("❌ /api/models error:", err);
    res.status(503).json({
      error: `Unable to list models: ${err instanceof Error ? err.message : String(err)}`,
      current: manager.getModel(),
    });
  }
});

app.post("/api/model", async (req, res) => {
  const requested = String(req.body?.model ?? "").trim().toLowerCase();
  if (!requested) return res.status(400).json({ error: "A model is required" });
  try {
    const models = await manager.listModels();
    if (!models.includes(requested)) {
      return res.status(400).json({ error: `Model is not available: ${requested}`, models });
    }
    manager.setModel(requested);
    res.json({ current: manager.getModel() });
  } catch (err) {
    console.error("❌ /api/model error:", err);
    res.status(400).json({
      error: `Unable to change model: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

app.post("/api/message", async (req, res) => {
  const clientId = String(req.body?.clientId ?? "default");
  const message = String(req.body?.message ?? "");
  try {
    const result = await handleMessage(clientId, message);
    res.json(result);
  } catch (err) {
    console.error("❌ /api/message error:", err);
    res.status(500).json({
      type: "error",
      message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

// Listing extraction preview: structured confirm/cancel with editable fields
// (the chat endpoint above also accepts free-text "confirm"/"cancel").
app.post("/api/listing/confirm", async (req, res) => {
  const clientId = String(req.body?.clientId ?? "default");
  const state = getState(clientId);
  if (state.phase !== "listingPreview" || !state.pendingListing) {
    return res.status(409).json({ error: "No pending listing preview for this client." });
  }
  const preview = state.pendingListing;
  const overrides: ListingFieldOverrides = {
    company: typeof req.body?.company === "string" ? req.body.company : undefined,
    title: typeof req.body?.title === "string" ? req.body.title : undefined,
    location: typeof req.body?.location === "string" ? req.body.location : undefined,
  };
  const useText = typeof req.body?.editedText === "string" && req.body.editedText.trim().length > 0
    ? req.body.editedText
    : preview.text;
  try {
    const result = await runAnalysis(state, useText, clientId, overrides);
    res.json(result);
  } catch (err) {
    console.error("❌ /api/listing/confirm error:", err);
    res.status(500).json({ error: `Analysis failed: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.post("/api/listing/cancel", (req, res) => {
  const clientId = String(req.body?.clientId ?? "default");
  const state = getState(clientId);
  state.pendingListing = null;
  if (state.phase === "listingPreview") state.phase = "idle";
  res.json({ type: "chat", message: "Discarded. Paste a job listing or a URL to start over." });
});

// Requirement-review approval: writes selected pending knowledge items to
// disk (the only path that permanently mutates the knowledge folder from an
// interview) and applies any requirement-verdict overrides.
app.post("/api/review/apply", async (req, res) => {
  const clientId = String(req.body?.clientId ?? "default");
  const state = getState(clientId);
  if (state.phase !== "review") {
    return res.status(409).json({ error: "No pending review for this client." });
  }
  const approvalsBody = Array.isArray(req.body?.approvals) ? req.body.approvals : null;
  const approvedIds = approvalsBody
    ? new Set<string>(
        approvalsBody
          .filter((a: unknown) => a && typeof a === "object" && (a as { approved?: unknown }).approved === true)
          .map((a: { id: unknown }) => String(a.id)),
      )
    : null;
  const overrides: Array<{ index: number; verdict: MatchAssessment["verdict"]; note: string }> = Array.isArray(req.body?.overrides)
    ? req.body.overrides
        .filter((o: unknown) => o && typeof o === "object")
        .map((o: { index: unknown; verdict: unknown; note?: unknown }) => ({
          index: Number(o.index),
          verdict: normalizeVerdict(o.verdict),
          note: typeof o.note === "string" ? o.note : "",
        }))
    : [];
  try {
    const { savedCount, savedItems } = await applyReviewDecisions(state, approvedIds, overrides);
    res.json({
      type: "ready",
      message: `✅ Saved **${savedCount}** item${savedCount === 1 ? "" : "s"} to your knowledge folder${savedItems.length ? `: ${savedItems.join(", ")}` : ""}.\n\nType **generate** to create the CV and cover letter PDFs.`,
      coverage: state.analysis?.coverage ?? null,
      matrix: state.reviewMatrix,
    });

  } catch (err) {
    console.error("❌ /api/review/apply error:", err);
    res.status(500).json({ error: `Could not apply review decisions: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.post("/api/analysis/apply-verdicts", (req, res) => {
  const clientId = String(req.body?.clientId ?? "default");
  const state = getState(clientId);
  if (state.phase !== "interview" || !state.analysis) {
    return res.status(409).json({ error: "No active requirement analysis for this client." });
  }
  const overrides: Array<{ index: number; verdict: MatchAssessment["verdict"]; note: string }> = Array.isArray(req.body?.overrides)
    ? req.body.overrides
        .filter((o: unknown) => o && typeof o === "object")
        .map((o: { index: unknown; verdict: unknown; note?: unknown }) => ({
          index: Number(o.index),
          verdict: normalizeVerdict(o.verdict),
          note: typeof o.note === "string" ? o.note : "",
        }))
        .filter((o: { index: number }) => Number.isInteger(o.index) && o.index >= 0 && o.index < state.analysis!.job.requirements.length)
    : [];
  applyAssessmentOverrides(state, overrides);
  state.remaining = [];
  state.pendingKnowledge = [];
  state.phase = "ready";
  res.json({
    type: "ready",
    message: "✅ Requirement verdicts saved for this application. Type **generate** to create the CV and cover letter PDFs.",
    coverage: state.analysis.coverage,
    matrix: state.reviewMatrix,
  });
});

app.get("/api/review", (req, res) => {
  const clientId = String(req.query?.clientId ?? "default");
  const state = getState(clientId);
  res.json({
    phase: state.phase,
    coverage: state.analysis?.coverage ?? null,
    matrix: state.reviewMatrix,
    pendingKnowledge: state.pendingKnowledge,
  });
});

app.post("/api/reset", (req, res) => {
  const clientId = String(req.body?.clientId ?? "default");
  clients.delete(clientId);
  traces.clear(clientId);
  res.json({ type: "reset", message: "State cleared." });
});

app.get("/api/trace/stream", (req, res) => {
  const clientId = String(req.query?.clientId ?? "default");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = () => res.write(`data: ${JSON.stringify({ snapshot: traces.snapshot(clientId) })}\n\n`);
  send();
  const unsubscribe = traces.subscribe(clientId, send);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});

app.post("/api/trace/clear", (req, res) => {
  const clientId = String(req.body?.clientId ?? "default");
  traces.clear(clientId);
  res.json({ ok: true });
});

app.get("/api/knowledge", async (_req, res) => {
  const entries = await listKnowledge();
  res.json({ entries });
});

app.put("/api/knowledge/:file", async (req, res) => {
  const file = String(req.params.file ?? "");
  const content = req.body?.content;
  if (!isKnowledgeFile(file)) {
    return res.status(400).json({ error: "Unsupported knowledge file" });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ error: "Knowledge content must be text" });
  }
  try {
    await saveKnowledge(file, content);
    res.json({ ok: true, file });
  } catch (err) {
    console.error(`❌ /api/knowledge/${file} error:`, err);
    res.status(500).json({
      error: `Unable to save knowledge file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

app.get("/api/prompts", async (_req, res) => {
  try {
    res.json({ entries: await listPromptEntries(DEFAULT_PROMPT_TEMPLATES) });
  } catch (err) {
    console.error("❌ /api/prompts error:", err);
    res.status(500).json({ error: `Unable to load prompts: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.put("/api/prompts/:id", async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!isEditablePromptId(id)) return res.status(400).json({ error: "Unsupported prompt" });
  if (typeof req.body?.content !== "string") {
    return res.status(400).json({ error: "Prompt content must be text" });
  }
  try {
    await savePrompt(id, req.body.content);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ error: `Unable to save prompt: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.post("/api/prompts/:id/reset", async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!isEditablePromptId(id)) return res.status(400).json({ error: "Unsupported prompt" });
  try {
    await resetPrompt(id);
    res.json({ ok: true, id, content: DEFAULT_PROMPT_TEMPLATES[id] });
  } catch (err) {
    console.error(`❌ /api/prompts/${id}/reset error:`, err);
    res.status(500).json({ error: `Unable to reset prompt: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.get("/api/applications", async (_req, res) => {
  res.json({ applications: await readIndex() });
});

app.delete("/api/applications/:folder", async (req, res) => {
  const folder = String(req.params.folder ?? "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(folder)) {
    return res.status(400).json({ error: "Invalid application folder" });
  }
  try {
    const deleted = await deleteApplication(folder);
    if (!deleted) return res.status(404).json({ error: "Application not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error(`❌ /api/applications/${folder} delete error:`, err);
    res.status(500).json({ error: `Unable to delete application: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.get("/api/state", (req, res) => {
  const clientId = String(req.query?.clientId ?? "default");
  const st = clients.get(clientId) ?? newState();
  res.json({
    phase: st.phase,
    job: st.job,
    score: st.analysis?.score ?? null,
    coverage: st.analysis?.coverage ?? null,
    remaining: st.remaining.length,
    total: (st.analysis?.missing.length ?? 0),
    confirmed: st.confirmed.length,
    pendingListing: st.pendingListing,
    pendingKnowledgeCount: st.pendingKnowledge.length,
  });
});

app.get("/api/download/*splat", async (req, res) => {
  const params = req.params as unknown as Record<string, string | string[]>;
  const raw = params.splat ?? [];
  const relPath = Array.isArray(raw) ? raw.join("/") : String(raw);
  if (!relPath || relPath.includes("..")) {
    return res.status(400).json({ error: "Bad path" });
  }
  const full = path.join(PROJECT_ROOT, relPath);
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new Error("not a file");
    res.download(full);
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────

app.listen(config.PORT, () => {
  console.log(`✅ Jobseeker v2 running at http://localhost:${config.PORT}`);
  console.log(`   Knowledge folder: ${config.KNOWLEDGE_DIR}`);
  console.log(`   Applications folder: ${config.APPLICATIONS_DIR}`);
  console.log(`   Model: ${config.LLM_MODEL}`);
});

process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  await manager.stop().catch(() => {});
  process.exit(0);
});
