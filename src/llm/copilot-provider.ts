import {
  CopilotClient,
  approveAll,
  RuntimeConnection,
  type CopilotSession,
  type SystemMessageConfig,
} from "@github/copilot-sdk";
import { config, PROJECT_ROOT } from "../config.js";
import {
  qualifyModel,
  stripProvider,
  type LlmProvider,
  type LlmRunOptions,
  type TraceEvent,
} from "./types.js";

const PROVIDER_ID = "github-copilot";

/**
 * GitHub Copilot provider, backed by the Copilot SDK.
 *
 * Each `run()` creates a fresh short-lived session, sends one prompt, and
 * collects the final assistant message. Sessions are cheap and stateless here —
 * the app owns conversation state, so no session resumption is needed.
 */
export class CopilotProvider implements LlmProvider {
  readonly id = PROVIDER_ID;

  private client: CopilotClient | null = null;
  private starting = false;
  private startPromise: Promise<CopilotClient> | null = null;
  private selectedModel: string | null = null;

  /**
   * @param defaultModel canonical model ID used until one is selected.
   * @param clientFactory overrides how the SDK client is created; tests use it
   *   to inject a stub instead of spawning the Copilot CLI.
   */
  constructor(
    private readonly defaultModel: string = config.LLM_MODEL,
    private readonly clientFactory?: () => Promise<CopilotClient>,
  ) {}

  private async getClient(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    return this.startPromise;
  }

  private async start(): Promise<CopilotClient> {
    if (this.starting) return this.getClient();
    this.starting = true;
    try {
      if (this.clientFactory) {
        this.client = await this.clientFactory();
        return this.client;
      }
      // Default: use the runtime bundled with the SDK (@github/copilot).
      // If COPILOT_CLI_PATH is set (e.g. a global copilot install), use that.
      const client = new CopilotClient({
        connection: RuntimeConnection.forStdio(
          config.COPILOT_CLI_PATH ? { path: config.COPILOT_CLI_PATH } : {},
        ),
        workingDirectory: PROJECT_ROOT,
      });
      await client.start();
      this.client = client;
      return client;
    } finally {
      this.starting = false;
    }
  }

  /** Translates a plain-text system prompt into Copilot's `SystemMessageConfig`. */
  private toSystemMessage(systemPrompt: string | undefined): SystemMessageConfig | undefined {
    if (!systemPrompt) return undefined;
    return {
      mode: "customize",
      sections: {
        identity: { action: "replace", content: systemPrompt },
      },
    };
  }

  private async buildSession(
    client: CopilotClient,
    opts: LlmRunOptions,
  ): Promise<CopilotSession> {
    const canonical = (opts.model ?? this.getModel()).toLowerCase();
    // The UI uses provider-qualified IDs, while the Copilot SDK session API
    // expects the bare model ID.
    const sdkModel = stripProvider(canonical, PROVIDER_ID);
    return client.createSession({
      onPermissionRequest: approveAll,
      model: sdkModel,
      clientName: "jobseeker-v2",
      workingDirectory: PROJECT_ROOT,
      systemMessage: this.toSystemMessage(opts.systemPrompt),
      // No tools: this app generates text only; all file I/O happens server-side.
      tools: [],
      excludedTools: [],
    });
  }

  /**
   * Runs a single prompt to completion and returns the final assistant text.
   * Retries once with a fresh client if the connection fails.
   */
  async run(opts: LlmRunOptions): Promise<string> {
    const client = await this.getClient();
    try {
      return await this.runOnce(client, opts);
    } catch (err) {
      console.warn(`⚠️ Copilot run failed: ${err instanceof Error ? err.message : String(err)}`);
      console.warn("   Restarting client and retrying once…");
      try {
        await this.stop();
      } catch {
        /* ignore */
      }
      this.client = null;
      this.startPromise = null;
      const fresh = await this.getClient();
      return await this.runOnce(fresh, opts);
    }
  }

  private async runOnce(client: CopilotClient, opts: LlmRunOptions): Promise<string> {
    const session = await this.buildSession(client, opts);
    const startedAt = Date.now();
    const model = (opts.model ?? this.getModel()).toLowerCase();
    const emit = (event: Omit<TraceEvent, "timestamp">): void => {
      try {
        opts.onTrace?.({ ...event, timestamp: Date.now() });
      } catch {
        /* A trace sink must never break an LLM request. */
      }
    };
    emit({ kind: "run-start", label: opts.label, model, prompt: opts.prompt });
    try {
      let unsubscribe: (() => void) | undefined;
      if (opts.onChunk) {
        // Copilot emits whole messages, not deltas: forward only the new suffix.
        let emitted = 0;
        unsubscribe = session.on("assistant.message", (event) => {
          const content = event?.data?.content;
          if (typeof content !== "string" || content.length <= emitted) return;
          const delta = content.slice(emitted);
          emitted = content.length;
          if (delta) opts.onChunk?.(delta);
        });
      }
      const result = await session.sendAndWait(
        { prompt: opts.prompt },
        opts.timeoutMs ?? 120_000,
      );
      if (unsubscribe) unsubscribe();
      const finalText = result?.data?.content ?? "";
      emit({ kind: "run-end", label: opts.label, model, durationMs: Date.now() - startedAt, finalText });
      return finalText;
    } catch (err) {
      emit({
        kind: "run-error",
        label: opts.label,
        model,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      try {
        await session.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop().catch(() => {});
      this.client = null;
    }
  }

  async listModels(): Promise<string[]> {
    const client = await this.getClient();
    const models = await client.listModels();
    return models
      .map((model) => {
        const id = model.id.toLowerCase();
        // SDK versions may expose first-party Copilot IDs without a provider
        // prefix; normalize those to the canonical ID used by this app.
        return id.includes("/") ? id : qualifyModel(PROVIDER_ID, id);
      })
      // Exclude every explicitly routed third-party provider, especially
      // `opencode/*`.
      .filter((id) => id.startsWith(`${PROVIDER_ID}/`))
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort();
  }

  getModel(): string {
    return (this.selectedModel ?? this.defaultModel).toLowerCase();
  }

  setModel(model: string): void {
    const normalized = model.trim().toLowerCase();
    if (!normalized) throw new Error("Model name cannot be empty");
    if (!normalized.startsWith(`${PROVIDER_ID}/`)) {
      throw new Error(`Only ${PROVIDER_ID} models can be selected`);
    }
    this.selectedModel = normalized;
  }

  /** Checks whether the CLI is reachable. */
  async health(): Promise<boolean> {
    try {
      const client = await this.getClient();
      return client !== null;
    } catch {
      return false;
    }
  }
}
