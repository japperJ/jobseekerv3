/**
 * Shared types for the LLM provider abstraction.
 *
 * See docs/adr/0001-llm-provider-abstraction.md for the design rationale.
 *
 * Canonical model IDs are `<provider>/<model>`, split on the FIRST slash only,
 * because provider-local model IDs may themselves contain slashes
 * (e.g. `opencode/anthropic/claude-sonnet-4-20250514`).
 */

export interface TraceEvent {
  kind: "run-start" | "run-end" | "run-error";
  label?: string;
  model?: string;
  timestamp: number;
  prompt?: string;
  durationMs?: number;
  finalText?: string;
  error?: string;
}

/** A JSON Schema fragment, passed verbatim to providers that support structured output. */
export type JsonSchema = Record<string, unknown>;

export interface LlmRunOptions {
  prompt: string;
  /**
   * Plain-text system instructions. Providers translate this into whatever
   * shape their backend expects (Copilot: a `SystemMessageConfig`; opencode:
   * the `system` field on `session.prompt`).
   */
  systemPrompt?: string;
  timeoutMs?: number;
  /**
   * Called with *incremental* text as the assistant replies. Providers that
   * only expose whole messages (Copilot) synthesize deltas by tracking what
   * has already been emitted.
   */
  onChunk?: (delta: string) => void;
  /** Canonical model ID (`<provider>/<model>`). Defaults to the provider's current model. */
  model?: string;
  label?: string;
  onTrace?: (event: TraceEvent) => void;
  /**
   * Optional JSON Schema the reply must conform to. Providers without
   * structured-output support ignore it, so callers must still tolerate
   * fenced/loose JSON in the returned text.
   */
  jsonSchema?: JsonSchema;
}

export interface LlmProviderModel {
  /** Canonical ID: `<provider>/<model>`. */
  id: string;
  /** Human-readable name, when the backend provides one. */
  name?: string;
}

export interface LlmProvider {
  /** Provider prefix used in canonical model IDs, e.g. `github-copilot`. */
  readonly id: string;

  /** Runs a single prompt to completion and returns the final assistant text. */
  run(opts: LlmRunOptions): Promise<string>;

  /** Canonical model IDs offered by this provider. */
  listModels(): Promise<string[]>;

  /** The canonical model ID currently selected on this provider. */
  getModel(): string;

  /** Selects a canonical model ID belonging to this provider. */
  setModel(model: string): void;

  /** Whether the provider's backend is reachable. */
  health(): Promise<boolean>;

  /** Releases any resources held by the provider. */
  stop(): Promise<void>;
}

/** Splits a canonical model ID on the first slash. Returns null when unqualified. */
export function splitModelId(id: string): { provider: string; model: string } | null {
  const trimmed = id.trim().toLowerCase();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

/** Returns the provider prefix of a canonical model ID, or null when unqualified. */
export function providerOf(id: string): string | null {
  return splitModelId(id)?.provider ?? null;
}

/**
 * Strips a provider prefix from a canonical model ID, yielding the
 * provider-local ID. Returns the input unchanged when it has no prefix.
 */
export function stripProvider(id: string, provider: string): string {
  const trimmed = id.trim().toLowerCase();
  const prefix = `${provider.toLowerCase()}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

/** Joins a provider prefix and a provider-local model ID into a canonical ID. */
export function qualifyModel(provider: string, model: string): string {
  const local = model.trim().toLowerCase().replace(/^\/+/, "");
  return local ? `${provider.toLowerCase()}/${local}` : provider.toLowerCase();
}
