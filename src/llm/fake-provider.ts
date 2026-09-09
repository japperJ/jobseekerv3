import type { JsonSchema, LlmProvider, LlmRunOptions } from "./types.js";

/** Recorded arguments of a single `run()` call on {@link FakeProvider}. */
export interface FakeRun {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  label?: string;
  timeoutMs?: number;
  jsonSchema?: JsonSchema;
}

export interface FakeProviderOptions {
  id: string;
  models?: string[];
  /** Produces the reply for a run. Defaults to a fixed string. */
  respond?: (run: FakeRun) => string | Promise<string>;
  /** When set, the reply is streamed to `onChunk` in slices of this many characters. */
  chunkSize?: number;
  healthy?: boolean;
}

/**
 * In-memory {@link LlmProvider} used by tests. It records every run so tests
 * can assert on routing, system prompts, and model IDs without a real backend.
 */
export class FakeProvider implements LlmProvider {
  readonly id: string;
  readonly runs: FakeRun[] = [];
  healthy: boolean;
  stopped = false;

  private readonly models: string[];
  private readonly respond: (run: FakeRun) => string | Promise<string>;
  private readonly chunkSize?: number;
  private selectedModel: string | null = null;

  constructor(options: FakeProviderOptions) {
    this.id = options.id;
    this.models = options.models ?? [`${options.id}/fake-model`];
    this.respond = options.respond ?? (() => "fake reply");
    this.chunkSize = options.chunkSize;
    this.healthy = options.healthy ?? true;
  }

  async run(opts: LlmRunOptions): Promise<string> {
    const run: FakeRun = {
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      label: opts.label,
      timeoutMs: opts.timeoutMs,
      jsonSchema: opts.jsonSchema,
    };
    this.runs.push(run);
    const reply = await this.respond(run);
    if (opts.onChunk) {
      if (this.chunkSize) {
        for (let i = 0; i < reply.length; i += this.chunkSize) {
          opts.onChunk(reply.slice(i, i + this.chunkSize));
        }
      } else {
        opts.onChunk(reply);
      }
    }
    return reply;
  }

  async listModels(): Promise<string[]> {
    return [...this.models];
  }

  getModel(): string {
    return this.selectedModel ?? this.models[0];
  }

  setModel(model: string): void {
    const normalized = model.trim().toLowerCase();
    if (!normalized) throw new Error("Model name cannot be empty");
    if (!normalized.startsWith(`${this.id}/`)) {
      throw new Error(`Only ${this.id} models can be selected`);
    }
    this.selectedModel = normalized;
  }

  async health(): Promise<boolean> {
    return this.healthy;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
