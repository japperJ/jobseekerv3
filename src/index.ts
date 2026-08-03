import * as fs from "node:fs/promises";
import * as path from "node:path";
import express from "express";
import { config, PROJECT_ROOT } from "./config.js";
import { CopilotManager } from "./copilot.js";
import { loadAllKnowledge, appendConfirmedSkill, listKnowledge } from "./knowledge.js";
import { analyzeJobListing } from "./analysis.js";
import { askGapQuestion, interpretAnswer } from "./interview.js";
import { generateApplicationDocuments } from "./generation.js";
import { markdownToPdf } from "./pdf.js";
import { saveApplication, readIndex } from "./applications.js";
import { fetchListingText } from "./fetch-listing.js";
import { idleChatPrompt } from "./prompts.js";
import type { ClientState } from "./types.js";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(PROJECT_ROOT, "src", "public")));

const manager = new CopilotManager();
const clients = new Map<string, ClientState>();

function newState(): ClientState {
  return {
    phase: "idle",
    job: null,
    analysis: null,
    listingText: "",
    remaining: [],
    answers: [],
    confirmed: [],
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

// ── Workflow steps ────────────────────────────────────────────────────────

interface MessageResponse {
  type:
    | "chat"
    | "analysis"
    | "question"
    | "answerSaved"
    | "ready"
    | "generated"
    | "error"
    | "reset";
  message: string;
  [k: string]: unknown;
}

async function runAnalysis(state: ClientState, listingText: string): Promise<MessageResponse> {
  const knowledge = await loadAllKnowledge();
  const analysis = await analyzeJobListing(listingText, knowledge, manager);

  state.job = analysis.job;
  state.analysis = analysis;
  state.listingText = listingText;
  state.remaining = [...analysis.missing];
  state.answers = [];
  state.confirmed = [];

  const job = analysis.job;
  const head = `📊 **Match: ${analysis.score}%** for **${job.role}** at ${job.company ?? "the company"}${job.location ? ` — ${job.location}` : ""}.`;

  if (analysis.missing.length === 0) {
    state.phase = "ready";
    return {
      type: "ready",
      message: `${head}\n\nGreat news — your profile covers all the listed requirements! Type **generate** to create the CV and cover letter PDFs.`,
      job,
      score: analysis.score,
      covered: analysis.covered.map((r) => r.text),
      missing: [],
    };
  }

  state.phase = "interview";
  const next = state.remaining[0];
  const question = await askGapQuestion(next, job, 1, analysis.missing.length, manager);
  return {
    type: "analysis",
    message: `${head}\n\nI found **${analysis.missing.length}** requirement${analysis.missing.length === 1 ? "" : "s"} your profile doesn't clearly cover. I'll ask about them one at a time — if you have the experience, I'll save it for all future applications.\n\n**${question}**`,
    job,
    score: analysis.score,
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
): Promise<MessageResponse> {
  const req = state.remaining[0];
  const interpreted = await interpretAnswer(req, userMessage, manager);

  state.answers.push({ requirement: req, ...interpreted });
  state.remaining.shift();

  const job = state.job!;
  const savedNote =
    interpreted.has && !interpreted.unsure
      ? await persistConfirmedSkill(req.text, interpreted.evidence, `${job.company ?? ""} ${job.role}`)
      : "";

  if (interpreted.has && !interpreted.unsure) {
    state.confirmed.push(
      interpreted.evidence ? `${req.text} — ${interpreted.evidence}` : req.text,
    );
  }

  if (state.remaining.length === 0) {
    state.phase = "ready";
    const savedCount = state.confirmed.length;
    return {
      type: "ready",
      message: `${savedNote}\n✅ Interview complete — ${state.answers.length} questions asked, **${savedCount}** new item${savedCount === 1 ? "" : "s"} saved to your knowledge folder.\n\nType **generate** to create the CV and cover letter PDFs (Danish + English).`,
      confirmed: [...state.confirmed],
      remaining: 0,
      total: state.answers.length,
    };
  }

  const next = state.remaining[0];
  const question = await askGapQuestion(
    next,
    job,
    state.answers.length + 1,
    state.answers.length + state.remaining.length,
    manager,
  );
  return {
    type: "question",
    message: `${savedNote}\n**${question}**`,
    question,
    remaining: state.remaining.length,
    total: state.answers.length + state.remaining.length,
    confirmed: [...state.confirmed],
  };
}

async function persistConfirmedSkill(
  skillText: string,
  evidence: string,
  context: string,
): Promise<string> {
  const result = await appendConfirmedSkill(skillText, evidence, context);
  if (result.appended) {
    statefulNote(`Saved to knowledge/skills.md: ${skillText}`);
    return `📥 **Saved to your knowledge folder:** *${skillText}*${evidence ? ` — ${evidence}` : ""}`;
  }
  return "";
}

// Small dedup guard: avoid duplicate logging of saves.
const _savedLog = new Set<string>();
function statefulNote(s: string): void {
  if (!_savedLog.has(s)) {
    _savedLog.add(s);
    console.log(s);
  }
}

async function generatePdfs(state: ClientState, jobDescriptionText: string): Promise<MessageResponse> {
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
  );

  // Render PDFs to a staging area, then move into the application folder.
  const staging = path.join(PROJECT_ROOT, "applications", ".staging", Date.now().toString());
  await fs.mkdir(staging, { recursive: true });
  const tmp = (name: string) => path.join(staging, name);

  await markdownToPdf(docs.cvEn, tmp("cv-en.pdf"), "cv");
  await markdownToPdf(docs.cvDa, tmp("cv-da.pdf"), "cv");
  await markdownToPdf(docs.coverEn, tmp("cover-en.pdf"), "cover");
  await markdownToPdf(docs.coverDa, tmp("cover-da.pdf"), "cover");

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
  );

  await fs.rm(staging, { recursive: true, force: true }).catch(() => {});

  const rel = (p: string) => p.slice(PROJECT_ROOT.length).replace(/\\/g, "/");
  return {
    type: "generated",
    message: `🎉 **Done!** Your application package for **${job.role}** at **${job.company ?? "the company"}** is ready:\n\n📄 CV (English) · 📄 CV (Dansk) · 💌 Cover Letter (English) · 💌 Ansøgning (Dansk)\n\nFiles are in \`applications/${files.folder}/\``,
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
    return { type: "reset", message: "State cleared. Paste a new job listing to start over." };
  }

  switch (state.phase) {
    case "idle": {
      if (isUrl(msg)) {
        try {
          const listing = await fetchListingText(msg);
          if (listing.length < 50) {
            return { type: "error", message: "Could not read any content from that URL. Try pasting the job description as text instead." };
          }
          return await runAnalysis(state, listing);
        } catch (err) {
          return { type: "error", message: `Failed to fetch that URL: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      if (looksLikeListing(msg)) {
        return await runAnalysis(state, msg);
      }
      const reply = await manager.run({
        prompt: idleChatPrompt(msg),
        timeoutMs: 60_000,
      });
      return { type: "chat", message: reply || "Paste a job listing (or a URL) and I'll build your tailored CV and cover letter." };
    }

    case "interview": {
      if (isSkipInterviewIntent(msg) || state.remaining.length === 0) {
        state.phase = "ready";
        const count = state.answers.length;
        return {
          type: "ready",
          message: `✅ Interview skipped after ${count} question${count === 1 ? "" : "s"}. Type **generate** to create the CV and cover letter PDFs.`,
          remaining: state.remaining.length,
        };
      }
      if (isGenerateIntent(msg)) {
        state.phase = "ready";
        const savedCount = state.confirmed.length;
        return {
          type: "ready",
          message: `✅ Moving on (${savedCount} item${savedCount === 1 ? "" : "s"} saved). Type **generate** to create the PDFs.`,
        };
      }
      return await processAnswer(state, msg);
    }

    case "ready": {
      if (isGenerateIntent(msg)) {
        try {
          return await generatePdfs(state, state.listingText || msg);
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
  res.json({ ok: true, copilot: await manager.health() });
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

app.post("/api/reset", (req, res) => {
  const clientId = String(req.body?.clientId ?? "default");
  clients.delete(clientId);
  res.json({ type: "reset", message: "State cleared." });
});

app.get("/api/knowledge", async (_req, res) => {
  const entries = await listKnowledge();
  res.json({ entries });
});

app.get("/api/applications", async (_req, res) => {
  res.json({ applications: await readIndex() });
});

app.get("/api/state", (req, res) => {
  const clientId = String(req.query?.clientId ?? "default");
  const st = clients.get(clientId) ?? newState();
  res.json({
    phase: st.phase,
    job: st.job,
    score: st.analysis?.score ?? null,
    remaining: st.remaining.length,
    total: (st.analysis?.missing.length ?? 0),
    confirmed: st.confirmed.length,
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
  console.log(`   Model: ${config.COPILOT_MODEL}`);
});

process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  await manager.stop().catch(() => {});
  process.exit(0);
});
