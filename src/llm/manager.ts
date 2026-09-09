import {
  providerOf,
  type LlmProvider,
  type LlmRunOptions,
} from "./types.js";

export interface ProviderModels {
  id: string;
  models: string[];
}

export interface LlmManagerOptions {
  providers: LlmProvider[];
  /** Canonical model ID used when nothing has been selected yet. */
  defaultModel: string;
}

/**
 * Facade over the registered {@link LlmProvider}s.
 *
 * Callers keep using a single `run()`/`listModels()`/`setModel()` surface and
 * address models by canonical ID (`<provider>/<model>`); the manager routes
 * each call to the owning provider.
 */
export class LlmManager {
  private readonly providers = new Map<string, LlmProvider>();
  private selectedModel: string | null = null;

  constructor(private readonly options: LlmManagerOptions) {
    for (const provider of options.providers) {
      this.providers.set(provider.id.toLowerCase(), provider);
    }
    if (this.providers.size === 0) {
      throw new Error("LlmManager requires at least one provider");
    }
  }

  /** Registered provider prefixes, in registration order. */
  get providerIds(): string[] {
    return [...this.providers.keys()];
  }

  /** Returns the provider that owns a canonical model ID. */
  providerFor(modelId: string): LlmProvider {
    const providerId = providerOf(modelId);
    const provider = providerId ? this.providers.get(providerId) : undefined;
    if (!provider) {
      throw new Error(
        `Unknown model "${modelId}". Known providers: ${this.providerIds.join(", ")}.`,
      );
    }
    return provider;
  }

  /** Runs a prompt on the provider that owns the requested (or current) model. */
  async run(opts: LlmRunOptions): Promise<string> {
    const model = (opts.model ?? this.getModel()).toLowerCase();
    const provider = this.providerFor(model);
    return provider.run({ ...opts, model });
  }

  /** Canonical model IDs across every provider. Providers that fail are skipped. */
  async listModels(): Promise<string[]> {
    const grouped = await this.listModelsByProvider();
    return grouped.flatMap((group) => group.models);
  }

  /** Canonical model IDs grouped by provider. Providers that fail report an empty list. */
  async listModelsByProvider(): Promise<ProviderModels[]> {
    const settled = await Promise.allSettled(
      [...this.providers.values()].map(async (provider) => ({
        id: provider.id,
        models: await provider.listModels(),
      })),
    );
    return settled.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : { id: [...this.providers.values()][index].id, models: [] },
    );
  }

  getModel(): string {
    return (this.selectedModel ?? this.options.defaultModel).toLowerCase();
  }

  setModel(model: string): void {
    const normalized = model.trim().toLowerCase();
    if (!normalized) throw new Error("Model name cannot be empty");
    this.providerFor(normalized); // throws for unknown providers
    this.selectedModel = normalized;
  }

  /** Health of the provider that owns the current model. */
  async health(): Promise<boolean> {
    try {
      return await this.providerFor(this.getModel()).health();
    } catch {
      return false;
    }
  }

  /** Health of every registered provider, keyed by provider prefix. */
  async healthByProvider(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      [...this.providers.entries()].map(async ([id, provider]) => {
        try {
          return [id, await provider.health()] as const;
        } catch {
          return [id, false] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.providers.values()].map((provider) => provider.stop().catch(() => {})),
    );
  }
}
