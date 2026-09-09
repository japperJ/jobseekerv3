import { config, PROJECT_ROOT } from "../config.js";
import { CopilotProvider } from "./copilot-provider.js";
import { LlmManager } from "./manager.js";
import { OpencodeProvider } from "./opencode-provider.js";
import { providerOf } from "./types.js";

export { CopilotProvider } from "./copilot-provider.js";
export { FakeProvider } from "./fake-provider.js";
export type { FakeProviderOptions, FakeRun } from "./fake-provider.js";
export { LlmManager } from "./manager.js";
export type { LlmManagerOptions, ProviderModels } from "./manager.js";
export { OpencodeProvider } from "./opencode-provider.js";
export type { OpencodeProviderOptions } from "./opencode-provider.js";
export * from "./types.js";

/**
 * Default model for a provider: the configured model when it belongs to that
 * provider, otherwise an empty provider-local ID so the provider falls back to
 * its own backend default.
 */
function defaultModelFor(providerId: string): string {
  return providerOf(config.LLM_MODEL) === providerId ? config.LLM_MODEL : `${providerId}/`;
}

/** Builds the manager with every provider this app supports. */
export function createLlmManager(): LlmManager {
  return new LlmManager({
    providers: [
      new CopilotProvider(defaultModelFor("github-copilot")),
      new OpencodeProvider({
        baseUrl: config.OPENCODE_BASE_URL,
        agent: config.OPENCODE_AGENT,
        defaultModel: defaultModelFor("opencode"),
        directory: PROJECT_ROOT,
      }),
    ],
    defaultModel: config.LLM_MODEL,
  });
}
