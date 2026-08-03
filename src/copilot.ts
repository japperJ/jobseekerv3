import {
  CopilotClient,
  approveAll,
  RuntimeConnection,
  type CopilotSession,
  type SystemMessageConfig,
} from "@github/copilot-sdk";
import { config, PROJECT_ROOT } from "./config.js";

export interface RunOptions {
  prompt: string;
  systemMessage?: SystemMessageConfig;
  timeoutMs?: number;
  /** Called with streaming text chunks as the assistant replies. */
  onChunk?: (chunk: string) => void;
  model?: string;
}

/**
 * Thin wrapper around the GitHub Copilot SDK.
 *
 * Each `run()` creates a fresh short-lived session, sends one prompt, and
 * collects the final assistant message. Sessions are cheap and stateless here —
 * the app owns conversation state, so no session resumption is needed.
 */
export class CopilotManager {
  private client: CopilotClient | null = null;
  private starting = false;
  private startPromise: Promise<CopilotClient> | null = null;

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

  private async buildSession(
    client: CopilotClient,
    opts: RunOptions,
  ): Promise<CopilotSession> {
    return client.createSession({
      onPermissionRequest: approveAll,
      model: (opts.model ?? config.COPILOT_MODEL).toLowerCase(),
      clientName: "jobseeker-v2",
      workingDirectory: PROJECT_ROOT,
      systemMessage: opts.systemMessage,
      // No tools: this app generates text only; all file I/O happens server-side.
      tools: [],
      excludedTools: [],
    });
  }

  /**
   * Runs a single prompt to completion and returns the final assistant text.
   * Retries once with a fresh client if the connection fails.
   */
  async run(opts: RunOptions): Promise<string> {
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

  private async runOnce(client: CopilotClient, opts: RunOptions): Promise<string> {
    const session = await this.buildSession(client, opts);
    try {
      let unsubscribe: (() => void) | undefined;
      if (opts.onChunk) {
        unsubscribe = session.on("assistant.message", (event) => {
          const content = event?.data?.content;
          if (typeof content === "string" && content.length > 0) {
            opts.onChunk?.(content);
          }
        });
      }
      const result = await session.sendAndWait(
        { prompt: opts.prompt },
        opts.timeoutMs ?? 120_000,
      );
      if (unsubscribe) unsubscribe();
      return result?.data?.content ?? "";
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
