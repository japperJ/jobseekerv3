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

export const config = parsed.data;
