import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

/** Provider prefixes that may appear in a canonical model ID. */
export const KNOWN_PROVIDERS = ["github-copilot", "opencode"] as const;

const DEFAULT_PROVIDER = "github-copilot";
const DEFAULT_MODEL = `${DEFAULT_PROVIDER}/gpt-5.6-luna`;

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4173),
  /** Provider used to qualify a bare model name. */
  LLM_PROVIDER: z.string().min(1).default(DEFAULT_PROVIDER),
  /** Canonical model ID (`<provider>/<model>`) used at startup. */
  LLM_MODEL: z.string().min(1).optional(),
  /** @deprecated Use LLM_MODEL instead. */
  COPILOT_MODEL: z.string().min(1).optional(),
  COPILOT_CLI_PATH: z.string().optional(),
  /** Base URL of an already-running opencode server; when unset, one is spawned. */
  OPENCODE_BASE_URL: z.string().optional(),
  /** opencode agent to run prompts as; unset uses the server default. */
  OPENCODE_AGENT: z.string().optional(),
  KNOWLEDGE_DIR: z.string().default(path.join(PROJECT_ROOT, "knowledge")),
  APPLICATIONS_DIR: z.string().default(path.join(PROJECT_ROOT, "applications")),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/**
 * Normalizes a configured model into a canonical `<provider>/<model>` ID.
 * Bare names are qualified with the default provider; IDs from unknown
 * providers are rewritten (with a warning) rather than silently accepted, so a
 * typo cannot masquerade as a working model.
 */
export function normalizeModelId(value: string, defaultProvider: string): string {
  const model = value.trim().toLowerCase();
  const provider = defaultProvider.trim().toLowerCase() || DEFAULT_PROVIDER;
  const slash = model.indexOf("/");
  if (slash === -1) return model ? `${provider}/${model}` : DEFAULT_MODEL;
  const prefix = model.slice(0, slash);
  const local = model.slice(slash + 1);
  if ((KNOWN_PROVIDERS as readonly string[]).includes(prefix)) {
    return local ? model : DEFAULT_MODEL;
  }
  console.warn(
    `⚠️ Unknown provider "${prefix}" in model "${value}"; using ${provider}/${local || "gpt-5.6-luna"}.`,
  );
  return `${provider}/${local || "gpt-5.6-luna"}`;
}

const env = parsed.data;
const defaultProvider = env.LLM_PROVIDER.trim().toLowerCase() || DEFAULT_PROVIDER;
const configuredModel = env.LLM_MODEL ?? env.COPILOT_MODEL;
if (env.COPILOT_MODEL && !env.LLM_MODEL) {
  console.warn("⚠️ COPILOT_MODEL is deprecated; use LLM_MODEL instead.");
}

export const config = {
  ...env,
  LLM_PROVIDER: defaultProvider,
  LLM_MODEL: configuredModel
    ? normalizeModelId(configuredModel, defaultProvider)
    : DEFAULT_MODEL,
  OPENCODE_BASE_URL: env.OPENCODE_BASE_URL?.trim().replace(/\/+$/, "") || undefined,
  OPENCODE_AGENT: env.OPENCODE_AGENT?.trim() || undefined,
};
