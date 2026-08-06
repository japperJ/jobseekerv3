import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";

export type EditablePromptId =
  | "analyze-listing"
  | "match-requirements"
  | "interview-question"
  | "interpret-answer"
  | "generate-documents"
  | "idle-chat";

export interface PromptDefinition {
  id: EditablePromptId;
  file: string;
  title: string;
  description: string;
  placeholders: string[];
}

export interface PromptEntry extends PromptDefinition {
  content: string;
  customized: boolean;
}

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    id: "analyze-listing",
    file: "analyze-listing.txt",
    title: "Analyze job listing",
    description: "Extract the company, role, summary, and concrete requirements.",
    placeholders: ["{{listing}}", "{{knowledge}}"],
  },
  {
    id: "match-requirements",
    file: "match-requirements.txt",
    title: "Match requirements",
    description: "Compare listed requirements with the candidate knowledge.",
    placeholders: ["{{requirements}}", "{{knowledge}}"],
  },
  {
    id: "interview-question",
    file: "interview-question.txt",
    title: "Interview question",
    description: "Ask one focused question about a missing requirement.",
    placeholders: ["{{jobRole}}", "{{company}}", "{{index}}", "{{total}}", "{{requirement}}"],
  },
  {
    id: "interpret-answer",
    file: "interpret-answer.txt",
    title: "Interpret interview answer",
    description: "Classify the candidate's answer and extract factual evidence.",
    placeholders: ["{{requirement}}", "{{answer}}"],
  },
  {
    id: "generate-documents",
    file: "generate-documents.txt",
    title: "Generate CV and cover letters",
    description: "Produce the four tailored application documents.",
    placeholders: ["{{company}}", "{{role}}", "{{location}}", "{{summary}}", "{{requirements}}", "{{knowledge}}", "{{confirmed}}"],
  },
  {
    id: "idle-chat",
    file: "idle-chat.txt",
    title: "Idle chat guidance",
    description: "Respond when the user has not pasted a job listing yet.",
    placeholders: ["{{message}}"],
  },
];

export function isEditablePromptId(value: string): value is EditablePromptId {
  return PROMPT_DEFINITIONS.some((definition) => definition.id === value);
}

function promptDir(): string {
  return path.join(config.KNOWLEDGE_DIR, "prompts");
}

function definitionFor(id: string): PromptDefinition {
  const definition = PROMPT_DEFINITIONS.find((item) => item.id === id);
  if (!definition) throw new Error(`Unsupported prompt: ${id}`);
  return definition;
}

export function validatePromptContent(id: EditablePromptId, content: string): void {
  const definition = definitionFor(id);
  const placeholders = new Set(content.match(/\{\{[A-Za-z][A-Za-z0-9]*\}\}/g) ?? []);
  const allowed = new Set(definition.placeholders);
  const unknown = [...placeholders].filter((token) => !allowed.has(token));
  if (unknown.length > 0) {
    throw new Error(`Unknown placeholder(s): ${unknown.join(", ")}`);
  }
  const missing = definition.placeholders.filter((token) => !placeholders.has(token));
  if (missing.length > 0) {
    throw new Error(`Missing required placeholder(s): ${missing.join(", ")}`);
  }
}

export async function loadPromptTemplate(id: EditablePromptId, fallback: string): Promise<string> {
  const definition = definitionFor(id);
  try {
    const content = await fs.readFile(path.join(promptDir(), definition.file), "utf8");
    validatePromptContent(id, content);
    return content;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown placeholder")) throw error;
    if (error instanceof Error && error.message.startsWith("Missing required")) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function listPromptEntries(defaults: Record<EditablePromptId, string>): Promise<PromptEntry[]> {
  return Promise.all(
    PROMPT_DEFINITIONS.map(async (definition) => {
      const fallback = defaults[definition.id];
      const content = await loadPromptTemplate(definition.id, fallback);
      return {
        ...definition,
        content,
        customized: content !== fallback,
      };
    }),
  );
}

export async function savePrompt(id: EditablePromptId, content: string): Promise<void> {
  validatePromptContent(id, content);
  const definition = definitionFor(id);
  await fs.mkdir(promptDir(), { recursive: true });
  await fs.writeFile(path.join(promptDir(), definition.file), content, "utf8");
}

export async function resetPrompt(id: EditablePromptId): Promise<void> {
  const definition = definitionFor(id);
  try {
    await fs.unlink(path.join(promptDir(), definition.file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => {
    if (!(key in values)) throw new Error(`Missing value for placeholder: {{${key}}}`);
    return values[key];
  });
}
