import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";

const KNOWLEDGE_FILES = [
  "profile.md",
  "experience.md",
  "skills.md",
  "achievements.md",
  "preferences.md",
];

export interface KnowledgeEntry {
  file: string;
  title: string;
  content: string;
}

/** Returns every knowledge file with its name and content. */
export async function listKnowledge(): Promise<KnowledgeEntry[]> {
  const dir = config.KNOWLEDGE_DIR;
  const entries: KnowledgeEntry[] = [];
  for (const file of KNOWLEDGE_FILES) {
    const p = path.join(dir, file);
    try {
      const content = await fs.readFile(p, "utf8");
      entries.push({ file, title: file.replace(".md", ""), content });
    } catch {
      // File missing — skip (the app should still work).
    }
  }
  return entries;
}

/** Concatenates all knowledge into one prompt-friendly block. */
export async function loadAllKnowledge(): Promise<string> {
  const entries = await listKnowledge();
  return entries
    .map((e) => `# ${e.title}\n${e.content}`)
    .join("\n\n---\n\n");
}

/**
 * Appends a newly confirmed skill/experience to knowledge/skills.md so it is
 * used in all future applications. De-duplicates against existing content.
 */
export async function appendConfirmedSkill(
  skillText: string,
  evidence: string,
  context?: string,
): Promise<{ appended: boolean }> {
  const dir = config.KNOWLEDGE_DIR;
  const file = path.join(dir, "skills.md");
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    current = "# Skills\n";
  }

  const trimmed = skillText.trim();
  if (!trimmed) return { appended: false }; // nothing to append
  const needle = trimmed.toLowerCase();
  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|\\W)${escapedNeedle}(?=$|\\W)`, "i").test(current)) {
    return { appended: false }; // already known — skip
  }

  const date = new Date().toISOString().slice(0, 10);
  const evidenceLine = evidence.trim() ? ` — Evidence: ${evidence.trim()}` : "";
  const contextLine = context?.trim() ? ` (from: ${context.trim()})` : "";
  const line = `- ${skillText.trim()}${contextLine}${evidenceLine} [confirmed ${date}]`;

  const appendTarget = "## Confirmed from job applications\n";
  if (current.includes(appendTarget)) {
    current = current.replace(appendTarget, appendTarget + line + "\n");
  } else {
    current = current.trimEnd() + "\n\n" + appendTarget + line + "\n";
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, current, "utf8");
  return { appended: true };
}
