import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  HttpOpencodeClient,
  type OpencodeClient,
  type OpencodeMessage,
  type OpencodeModelInfo,
} from "./opencode-client.js";
import {
  qualifyModel,
  stripProvider,
  type JsonSchema,
  type LlmProvider,
  type LlmRunOptions,
  type TraceEvent,
} from "./types.js";

const PROVIDER_ID = "opencode";

/** opencode's server authenticates with HTTP Basic; the username is fixed. */
const SERVER_USERNAME = "opencode";

/** The opencode CLI default HTTP port. Used only when spawning a server. */
const DEFAULT_PORT = 4096;

/**
 * opencode takes ~5-15s to boot on a cold start (Bun + config load + provider
 * catalog fetch). The SDK's own default is 5s, which fails on Windows.
 */
const DEFAULT_SPAWN_TIMEOUT_MS = 60_000;

/**
 * `opencode serve` prints its URL before it finishes loading, so for the first
 * few seconds `/api/health` 404s and `/api/model` returns an empty catalog.
 */
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** How often the session transcript is polled while waiting for a reply. */
const POLL_INTERVAL_MS = 400;

/** Default run timeout when the caller does not specify one. */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/**
 * Tools that must never be reachable. This app generates text only — all file
 * I/O happens server-side — so the model must not reach for file/shell tools.
 * An empty `tools` map means "no overrides" (i.e. everything stays enabled), so
 * every known tool is turned off by name instead.
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
    "websearch",
    "task",
    "skill",
    "lsp",
    "invalid",
  ].map((name) => [name, false]),
);

/** `permission: deny` for the same tool set, as a second line of defence. */
const NO_PERMISSIONS = {
  read: "deny",
  edit: "deny",
  glob: "deny",
  grep: "deny",
  list: "deny",
  bash: "deny",
  webfetch: "deny",
  websearch: "deny",
  task: "deny",
  lsp: "deny",
  skill: "deny",
} as const;

/**
 * Agent injected into every spawned server. opencode's prompt endpoint takes
 * only `{ text }` — no system prompt and no tool overrides — so tool
 * suppression has to come from the agent definition; the system prompt itself
 * is prepended to the user text.
 */
const AGENT_ID = "jobseeker";

export interface OpencodeProviderOptions {
  /**
   * Path to the `opencode` executable. Defaults to `opencode` on PATH, which on
   * Windows can resolve to an older build via PATHEXT — and opencode builds are
   * not schema-compatible with each other, so this may need to be explicit.
   */
  bin?: string;
  /** Base URL of an already-running opencode server. When unset, one is spawned. */
  baseUrl?: string;
  /**
   * Password for the server's HTTP Basic auth. Required when attaching to a
   * server; ignored when spawning (a random password is generated instead).
   * Falls back to `OPENCODE_SERVER_PASSWORD`, then to the CLI's
   * `~/.config/opencode/service.json`.
   */
  password?: string;
  /** Agent name to run prompts as. Unset uses the built-in tool-free agent. */
  agent?: string;
  /** Canonical model ID used when nothing has been selected yet. */
  defaultModel: string;
  /**
   * Working directory opencode scopes sessions to. Defaults to a scratch
   * directory so this app's sessions do not land in the user's projects.
   */
  directory?: string;
  /** How long to wait for a spawned server to report its URL. */
  spawnTimeoutMs?: number;
  /** How long to wait for the server to finish loading its model catalog. */
  readyTimeoutMs?: number;
  /** Overrides how the client is created; tests use it to inject a stub. */
  clientFactory?: (args: { baseUrl: string; password: string; directory: string }) => OpencodeClient;
  /** Overrides how a server process is started; tests use it to skip spawning. */
  serverFactory?: (args: { password: string }) => Promise<SpawnedServer>;
  /** Overrides the CLI's stored password lookup; tests use it to force a miss. */
  readServicePassword?: () => string;
}

interface SpawnedServer {
  url: string;
  close(): void;
}

export class OpencodeProvider implements LlmProvider {
  readonly id = PROVIDER_ID;

  private client: OpencodeClient | null = null;
  private server: SpawnedServer | null = null;
  private connectPromise: Promise<OpencodeClient> | null = null;
  private selectedModel: string | null = null;
  private catalog: OpencodeModelInfo[] | null = null;

  constructor(private readonly options: OpencodeProviderOptions) {}

  private get directory(): string {
    return this.options.directory ?? defaultScratchDirectory();
  }

  private async getClient(): Promise<OpencodeClient> {
    if (this.client) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<OpencodeClient> {
    const directory = this.directory;
    fs.mkdirSync(directory, { recursive: true });

    let baseUrl = this.options.baseUrl;
    let password = this.options.password ?? process.env.OPENCODE_SERVER_PASSWORD ?? "";

    if (!baseUrl) {
      // A spawned server is ours alone, so it gets a throwaway password.
      password = randomBytes(24).toString("hex");
      this.server = this.options.serverFactory
        ? await this.options.serverFactory({ password })
        : await spawnServer({
            bin: this.options.bin,
            password,
            timeoutMs: this.options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
          });
      baseUrl = this.server.url;
    } else if (!password) {
      password = this.options.readServicePassword
        ? this.options.readServicePassword()
        : readServicePassword();
    }

    if (!password) {
      throw new Error(
        `The opencode server at ${baseUrl} requires a password. Set OPENCODE_PASSWORD, ` +
          `OPENCODE_SERVER_PASSWORD, or run this app without OPENCODE_BASE_URL so it can spawn its own server.`,
      );
    }

    this.client = this.options.clientFactory
      ? this.options.clientFactory({ baseUrl, password, directory })
      : new HttpOpencodeClient({ baseUrl, password, directory });
    await this.awaitReady(this.client);
    return this.client;
  }

  /**
   * Waits until the server can actually answer questions. Without this the app
   * reports the provider as down and shows an empty model dropdown on a
   * perfectly healthy server that is still loading.
   */
  private async awaitReady(client: OpencodeClient): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    for (;;) {
      try {
        if (await client.health()) return;
        if ((await client.listModels()).length > 0) return;
      } catch {
        /* not listening yet */
      }
      if (Date.now() >= deadline) {
        // Proceed anyway: an empty catalog is a legitimate state (no signed-in
        // provider), and the caller's own error message will explain it.
        return;
      }
      await delay(500);
    }
  }

  /**
   * Maps a provider-local model ID (`<providerID>/<modelID>`) onto opencode's
   * `{ providerID, id }` pair, validating it against the live catalog so a typo
   * surfaces as an error instead of a silent fallback to another model.
   */
  private async resolveModelRef(
    client: OpencodeClient,
    localId: string,
  ): Promise<{ providerID: string; id: string } | undefined> {
    const wanted = localId.trim().toLowerCase();
    if (!wanted) return undefined;

    const catalog = await this.fetchCatalog(client);
    const exact = catalog.find((m) => `${m.providerID}/${m.id}`.toLowerCase() === wanted);
    if (exact) return { providerID: exact.providerID, id: exact.id };

    // A bare model ID is matched against every provider, first match wins.
    const bare = catalog.find((m) => m.id.toLowerCase() === wanted);
    if (bare) return { providerID: bare.providerID, id: bare.id };

    throw new Error(
      `Unknown opencode model "${localId}". Use one of: ` +
        catalog
          .slice(0, 10)
          .map((m) => `${m.providerID}/${m.id}`)
          .join(", ") +
        (catalog.length > 10 ? ", …" : ""),
    );
  }

  /**
   * Forwards streamed text deltas for one session to `onChunk`. Best-effort: a
   * streaming failure must never break the run, and the reply is always read
   * from the transcript rather than accumulated from deltas.
   */
  private async streamDeltas(
    client: OpencodeClient,
    sessionID: string,
    onChunk: (delta: string) => void,
  ): Promise<void> {
    try {
      const close = await client.subscribe((event) => {
        // 2.0.x names this `session.text.delta`; 1.18.x used
        // `session.next.text.delta`, so accept both.
        if (!/\.text\.delta$/.test(event.type ?? "")) return;
        if (event.data?.sessionID !== sessionID) return;
        if (event.data.delta) onChunk(event.data.delta);
      });
      this.closeStream = close;
    } catch {
      /* Streaming is best-effort. */
    }
  }

  private closeStream: (() => void) | null = null;

  /**
   * Polls the transcript until the assistant has produced a finished message.
   * Polling (rather than waiting on the event stream) keeps the final text
   * correct even when the stream is missed, and `session.wait` is not available
   * on every server build.
   */
  private async awaitReply(
    client: OpencodeClient,
    sessionID: string,
    timeoutMs: number,
    onTimeout: () => void,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const messages = await client.readMessages(sessionID).catch(() => [] as OpencodeMessage[]);
      let text = "";
      let finished = false;
      for (const message of messages) {
        if (message.type !== "assistant") continue;
        if (!message.finish) continue; // still streaming
        finished = true;
        for (const block of message.content ?? []) {
          if (block.type === "text") text += block.text;
        }
      }
      if (finished && text) return text;
      if (Date.now() >= deadline) {
        onTimeout();
        throw new Error(`opencode run timed out after ${timeoutMs}ms`);
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
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
    try {
      const modelRef = await this.resolveModelRef(client, stripProvider(model, PROVIDER_ID));
      sessionID = await client.createSession({
        ...(modelRef ? { model: modelRef } : {}),
        // The default opencode agent has shell and file tools this app must not
        // expose; the spawned server defines a tool-free one.
        agent: this.options.agent ?? (this.options.baseUrl ? undefined : AGENT_ID),
      });

      if (opts.onChunk) await this.streamDeltas(client, sessionID, opts.onChunk);

      await client.prompt(sessionID, buildPromptText(opts));

      const finalText = await this.awaitReply(
        client,
        sessionID,
        opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        () => {
          void client.interrupt(sessionID!);
        },
      );

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
      this.closeStream?.();
      this.closeStream = null;
    }
  }

  private async fetchCatalog(client: OpencodeClient, useCache = true): Promise<OpencodeModelInfo[]> {
    if (useCache && this.catalog) return this.catalog;
    this.catalog = await client.listModels();
    return this.catalog;
  }

  async listModels(): Promise<string[]> {
    const client = await this.getClient();
    const catalog = await this.fetchCatalog(client, false);
    const ids = catalog
      .filter((model) => model.enabled !== false)
      .map((model) => qualifyModel(PROVIDER_ID, `${model.providerID}/${model.id}`));
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
      return await (await this.getClient()).health();
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.closeStream?.();
    this.closeStream = null;
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
    this.catalog = null;
  }
}

/**
 * The opencode prompt endpoint carries only a user message, so the system
 * instructions and any requested JSON Schema are prepended to it. Callers
 * already tolerate JSON embedded in prose (`extractJson`).
 */
export function buildPromptText(opts: LlmRunOptions): string {
  const sections: string[] = [];
  if (opts.systemPrompt) {
    sections.push(`<system-instructions>\n${opts.systemPrompt}\n</system-instructions>`);
  }
  if (opts.jsonSchema) {
    sections.push(
      "Respond with a single JSON value that validates against this JSON Schema. " +
        "Output raw JSON only — no prose, no explanation, no code fences.\n" +
        `<json-schema>\n${JSON.stringify(opts.jsonSchema)}\n</json-schema>`,
    );
  }
  sections.push(opts.prompt);
  return sections.join("\n\n");
}

/** Scratch directory for opencode sessions, kept out of the user's projects. */
function defaultScratchDirectory(): string {
  return path.join(os.tmpdir(), "jobseeker-opencode");
}

/** The password the opencode CLI uses for its own background server. */
function readServicePassword(): string {
  const file = path.join(os.homedir(), ".config", "opencode", "service.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { password?: unknown };
    return typeof parsed.password === "string" ? parsed.password : "";
  } catch {
    return "";
  }
}

/**
 * Starts `opencode serve` and waits for it to print its URL.
 *
 * The process is spawned directly rather than through the SDK's
 * `createOpencode()`, which cannot be used here: it hard-codes a 5s start
 * timeout, never sets `OPENCODE_SERVER_PASSWORD` (so the server it spawns
 * rejects every API call with 401), and overrides `OPENCODE_CONFIG_CONTENT`
 * with an empty object, which would drop the tool-free agent definition.
 */
export async function spawnServer(options: {
  bin?: string;
  password: string;
  timeoutMs: number;
  port?: number;
}): Promise<SpawnedServer> {
  const bin = options.bin ?? "opencode";
  const args = ["serve", "--hostname=127.0.0.1", `--port=${options.port ?? DEFAULT_PORT}`];
  const config = {
    username: SERVER_USERNAME,
    agent: {
      [AGENT_ID]: {
        mode: "primary",
        description: "Text generation for the jobseeker app. No tools, no file or shell access.",
        tools: NO_TOOLS,
        permission: NO_PERMISSIONS,
      },
    },
  };

  const child: ChildProcess = spawn(bin, args, {
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: options.password,
      OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
  });

  return new Promise<SpawnedServer>((resolve, reject) => {
    let settled = false;
    let output = "";

    const finish = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        reject(err);
      } else {
        resolve({ url: url!, close: () => child.kill() });
      }
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `opencode server did not start within ${options.timeoutMs}ms. ` +
            `Is \`${bin}\` installed and on PATH?\nServer output:\n${output.trim()}`,
        ),
      );
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        // The banner differs between opencode builds ("opencode server
        // listening on <url>" vs "server listening on <url>"), so match loosely.
        const match = /listening on (https?:\/\/\S+)/.exec(line);
        if (!match) continue;
        finish(null, match[1]);
        return;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (err) => finish(new Error(`Could not start \`${bin}\`: ${err.message}`)));
    child.on("exit", (code) =>
      finish(new Error(`opencode server exited with code ${code}.\nServer output:\n${output.trim()}`)),
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
