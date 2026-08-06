import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4173),
  COPILOT_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  COPILOT_CLI_PATH: z.string().optional(),
  KNOWLEDGE_DIR: z.string().default(path.join(PROJECT_ROOT, "knowledge")),
  APPLICATIONS_DIR: z.string().default(path.join(PROJECT_ROOT, "applications")),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

function normalizeCopilotModel(value: string): string {
  const model = value.trim().toLowerCase();
  if (model.startsWith("github-copilot/")) return model;
  if (model.includes("/")) {
    console.warn(`⚠️ Ignoring non-Copilot model "${value}"; using github-copilot/gpt-5.6-luna.`);
    return "github-copilot/gpt-5.6-luna";
  }
  return `github-copilot/${model}`;
}

export const config = {
  ...parsed.data,
  COPILOT_MODEL: normalizeCopilotModel(parsed.data.COPILOT_MODEL),
};
