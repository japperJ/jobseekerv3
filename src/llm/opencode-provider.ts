import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
  type Part,
  type Provider,
} from "@opencode-ai/sdk/v2";
import {
  qualifyModel,
  stripProvider,
  type JsonSchema,
  type LlmProvider,
  type LlmRunOptions,
  type TraceEvent,
} from "./types.js";

const PROVIDER_ID = "opencode";

/**
 * Explicit deny-list for opencode's built-in tools. This app generates text
 * only — all file I/O happens server-side — so the model must not reach for
 * file/shell tools. An empty `tools` map means "no overrides" (i.e. everything
 * stays enabled), so every known tool is turned off by name instead.
 */
const NO_TOOLS: Record<string, boolean> = Object.fromEntries(
  [
    "bash",
    "edit",
    "write",
    "read",
    "grep",
    "glob",
    "list",
    "patch",
    "multiedit",
    "todowrite",
    "todoread",
    "webfetch",
    "task",
    "skill",
    "lsp",
    "invalid",
  ].map((name) => [name, false]),
);

export interface OpencodeProviderOptions {
  /** Base URL of an already-running opencode server. When unset, one is spawned. */
  baseUrl?: string;
  /** Agent name to run prompts as. Unset uses the server default. */
  agent?: string;
  /** Canonical model ID used when nothing has been selected yet. */
  defaultModel: string;
  /** Working directory for the opencode server and its sessions. */
  directory?: string;
}

/**
 * opencode provider, backed by `@opencode-ai/sdk` (v2 API).
 *
 * Attaches to a running server when `baseUrl` is configured, otherwise spawns
 * a private one. Each `run()` creates a fresh session, sends one prompt, and
 * returns the assistant's text.
 */
export class OpencodeProvider implements LlmProvider {
  readonly id = PROVIDER_ID;

  private client: OpencodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private connectPromise: Promise<OpencodeClient> | null = null;
  private selectedModel: string | null = null;
  private providersCache: Provider[] | null = null;

  constructor(private readonly options: OpencodeProviderOptions) {}

  private async getClient(): Promise<OpencodeClient> {
    if (this.client) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<OpencodeClient> {
    if (this.options.baseUrl) {
      const client = createOpencodeClient({
        baseUrl: this.options.baseUrl,
        directory: this.options.directory,
      });
      this.client = client;
      return client;
    }
    // The spawned server inherits this process's working directory; there is no
    // per-server directory option in the SDK.
    const { client, server } = await createOpencode();
    this.server = server;
    this.client = client;
    return client;
  }

  private async fetchProviders(client: OpencodeClient, useCache = true): Promise<Provider[]> {
    if (useCache && this.providersCache) return this.providersCache;
    const { data, error } = await client.config.providers();
    if (error || !data) {
      throw new Error(
        `Unable to list opencode providers: ${error ? JSON.stringify(error) : "empty response"}`,
      );
    }
    this.providersCache = data.providers ?? [];
    return this.providersCache;
  }

  /**
   * Maps a provider-local model ID onto opencode's `{ providerID, modelID }`
   * pair. Local IDs are themselves `<providerID>/<modelID>`; a bare ID is
   * looked up in the server's provider list.
   */
  private async resolveModelRef(
    client: OpencodeClient,
    localId: string,
  ): Promise<{ providerID: string; modelID: string } | undefined> {
    if (!localId) return undefined;
    const slash = localId.indexOf("/");
    if (slash > 0 && slash < localId.length - 1) {
      return { providerID: localId.slice(0, slash), modelID: localId.slice(slash + 1) };
    }
    for (const provider of await this.fetchProviders(client)) {
      if (provider.models?.[localId]) {
        return { providerID: provider.id, modelID: localId };
      }
    }
    throw new Error(`Unknown opencode model "${localId}"`);
  }

  /**
   * Mirrors text-part updates for one session into incremental `onChunk`
   * deltas. opencode v2 events carry the whole part, not a delta, so the
   * previously seen text is tracked per part ID. Best-effort: a streaming
   * failure must never break the run.
   */
  private streamDeltas(
    client: OpencodeClient,
    sessionID: string,
    onChunk: (delta: string) => void,
  ): () => void {
    let stream: AsyncGenerator<unknown, void, unknown> | undefined;
    let cancelled = false;
    let closeRequested = false;

    const close = (): void => {
      cancelled = true;
      if (stream) void stream.return?.(undefined).catch?.(() => {});
      else closeRequested = true;
    };

    void (async () => {
      try {
        const events = await client.event.subscribe();
        stream = events.stream as AsyncGenerator<unknown, void, unknown>;
        if (closeRequested) {
          void stream.return?.(undefined).catch?.(() => {});
          return;
        }
        const seen = new Map<string, string>();
        for await (const event of stream) {
          if (cancelled) break;
          const props = (event as { properties?: { sessionID?: string; part?: Part } } | null)
            ?.properties;
          if (!props || props.sessionID !== sessionID) continue;
          const part = props.part;
          if (!part || part.type !== "text") continue;
          const text = typeof part.text === "string" ? part.text : "";
          const previous = seen.get(part.id) ?? "";
          if (text === previous) continue;
          seen.set(part.id, text);
          if (text.length > previous.length && text.startsWith(previous)) {
            onChunk(text.slice(previous.length));
          }
        }
      } catch {
        /* Streaming is best-effort. */
      }
    })();

    return close;
  }

  private async withTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(`opencode run timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async run(opts: LlmRunOptions): Promise<string> {
    const client = await this.getClient();
    const model = (opts.model ?? this.getModel()).toLowerCase();
    const startedAt = Date.now();
    const emit = (event: Omit<TraceEvent, "timestamp">): void => {
      try {
        opts.onTrace?.({ ...event, timestamp: Date.now() });
      } catch {
        /* A trace sink must never break an LLM request. */
      }
    };
    emit({ kind: "run-start", label: opts.label, model, prompt: opts.prompt });

    let sessionID: string | undefined;
    let stopStream: (() => void) | undefined;
    try {
      const created = await client.session.create({ title: opts.label });
      sessionID = created.data?.id;
      if (!sessionID) throw new Error("opencode did not return a session id");

      if (opts.onChunk) stopStream = this.streamDeltas(client, sessionID, opts.onChunk);

      const modelRef = await this.resolveModelRef(client, stripProvider(model, PROVIDER_ID));
      const result = await this.withTimeout(
        client.session.prompt({
          sessionID,
          parts: [{ type: "text", text: opts.prompt }],
          tools: NO_TOOLS,
          ...(modelRef ? { model: modelRef } : {}),
          ...(this.options.agent ? { agent: this.options.agent } : {}),
          ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
          ...(opts.jsonSchema
            ? {
                format: {
                  type: "json_schema",
                  schema: opts.jsonSchema as JsonSchema,
                  retryCount: 3,
                },
              }
            : {}),
        }),
        opts.timeoutMs ?? 120_000,
        () => {
          void client.session.abort({ sessionID: sessionID! }).catch(() => {});
        },
      );

      if (result.error) {
        throw new Error(`opencode prompt failed: ${JSON.stringify(result.error)}`);
      }
      const info = result.data?.info;
      if (info?.error) {
        throw new Error(`opencode returned an error message: ${JSON.stringify(info.error)}`);
      }
      // Prefer the validated structured payload when a schema was requested;
      // otherwise concatenate the assistant's text parts.
      const finalText =
        opts.jsonSchema && info?.structured !== undefined && info.structured !== null
          ? JSON.stringify(info.structured)
          : (result.data?.parts ?? [])
              .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
              .map((part) => part.text)
              .join("");

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
      stopStream?.();
      if (sessionID) {
        try {
          await client.session.delete({ sessionID });
        } catch {
          /* ignore */
        }
      }
    }
  }

  async listModels(): Promise<string[]> {
    const client = await this.getClient();
    const providers = await this.fetchProviders(client, false);
    const ids = providers.flatMap((provider) =>
      Object.keys(provider.models ?? {}).map((modelID) =>
        qualifyModel(PROVIDER_ID, `${provider.id}/${modelID}`),
      ),
    );
    return [...new Set(ids)].sort();
  }

  getModel(): string {
    return (this.selectedModel ?? this.options.defaultModel).toLowerCase();
  }

  setModel(model: string): void {
    const normalized = model.trim().toLowerCase();
    if (!normalized) throw new Error("Model name cannot be empty");
    if (!normalized.startsWith(`${PROVIDER_ID}/`)) {
      throw new Error(`Only ${PROVIDER_ID} models can be selected`);
    }
    this.selectedModel = normalized;
  }

  async health(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const { data, error } = await client.global.health();
      return !error && data?.healthy === true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    // Only close a server this provider spawned; an attached one is not ours.
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* ignore */
      }
      this.server = null;
    }
    this.client = null;
    this.providersCache = null;
  }
}
