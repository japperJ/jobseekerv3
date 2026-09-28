/**
 * Minimal HTTP client for the opencode server API (`/api/*`).
 *
 * This deliberately does **not** use `@opencode-ai/sdk`. That package is
 * generated from the opencode 1.18.x OpenAPI document, and the installed CLI is
 * 2.0.x, which disagrees on the routes this app needs:
 *
 * | Operation | SDK (1.18.x spec) | CLI 2.0.x |
 * |---|---|---|
 * | Send a prompt | `POST /api/session/{id}/prompt` with a nested `{ prompt: { text } }` body | same route, **flat** `{ text }` body |
 * | Read the transcript | `GET /api/session/{id}/messages` | `GET /api/session/{id}/message` (singular) |
 * | Text deltas | `session.next.text.delta` | `session.text.delta` |
 *
 * A hand-rolled client is a few dozen lines and removes the version coupling;
 * see docs/adr/0002-opencode-v2-api.md.
 */

export interface OpencodeModelInfo {
  id: string;
  providerID: string;
  enabled?: boolean;
}

export interface OpencodeTextPart {
  type: "text";
  text: string;
}

export interface OpencodeMessage {
  type: string;
  id?: string;
  /** Set on assistant messages once the turn has finished. */
  finish?: string;
  content?: OpencodeTextPart[];
  data?: { sessionID?: string; delta?: string };
}

export interface OpencodeClient {
  /** Whether the server is up and fully loaded. */
  health(): Promise<boolean>;
  /** Every model the connected server can run. */
  listModels(): Promise<OpencodeModelInfo[]>;
  /**
   * Creates a session and returns its id. `agent` selects an agent defined in
   * the server's config; the default opencode agent has shell and file tools.
   */
  createSession(options?: { model?: { providerID: string; id: string }; agent?: string }): Promise<string>;
  /** Admits one prompt and schedules the agent loop. */
  prompt(sessionID: string, text: string): Promise<void>;
  /** The session transcript, oldest first. */
  readMessages(sessionID: string): Promise<OpencodeMessage[]>;
  /** Cancels an in-flight turn. */
  interrupt(sessionID: string): Promise<void>;
  /**
   * Streams server events, invoking `onEvent` for each. Returns a function that
   * closes the stream. Best-effort: callers must not depend on it.
   */
  subscribe(onEvent: (event: OpencodeMessage) => void): Promise<() => void>;
}

export interface HttpClientOptions {
  baseUrl: string;
  password: string;
  /** Directory opencode scopes sessions to, sent as the `directory` query param. */
  directory: string;
  fetchImpl?: typeof fetch;
}

/** HTTP Basic credential for the opencode server (username is fixed). */
export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

export class HttpOpencodeClient implements OpencodeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Issues a request and returns the parsed body, or throws a readable error. */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(this.options.baseUrl + path);
    // The API takes the project scope as a query parameter rather than a header.
    url.searchParams.set("directory", this.options.directory);

    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: basicAuth(this.options.password),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`opencode ${method} ${path} failed (${res.status}): ${summarize(text)}`);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A SPA fallback means the route does not exist on this server version.
      if (text.trimStart().startsWith("<")) {
        throw new Error(
          `opencode ${method} ${path} returned HTML: this server does not expose the /api surface this app needs.`,
        );
      }
      throw new Error(`opencode ${method} ${path} returned a non-JSON body: ${summarize(text)}`);
    }
  }

  async health(): Promise<boolean> {
    try {
      const body = await this.request<{ data?: { healthy?: boolean } }>("GET", "/api/health");
      return body.data?.healthy === true;
    } catch {
      // `/api/health` only exists once the server has finished loading, so fall
      // back to a route that always does.
      try {
        await this.request("GET", "/api/model");
        return true;
      } catch {
        return false;
      }
    }
  }

  async listModels(): Promise<OpencodeModelInfo[]> {
    const body = await this.request<{ data?: OpencodeModelInfo[] }>("GET", "/api/model");
    return body.data ?? [];
  }

  async createSession(options?: {
    model?: { providerID: string; id: string };
    agent?: string;
  }): Promise<string> {
    const body = await this.request<{ data?: { id?: string } }>("POST", "/api/session", {
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.agent ? { agent: options.agent } : {}),
    });
    if (!body.data?.id) throw new Error("opencode did not return a session id");
    return body.data.id;
  }

  async prompt(sessionID: string, text: string): Promise<void> {
    // 2.0.x takes the prompt input as the request body itself.
    await this.request("POST", `/api/session/${sessionID}/prompt`, {
      text,
      delivery: "queue",
      resume: true,
    });
  }

  async readMessages(sessionID: string): Promise<OpencodeMessage[]> {
    const body = await this.request<{ data?: OpencodeMessage[] }>(
      "GET",
      `/api/session/${sessionID}/message?order=asc&limit=100`,
    );
    return body.data ?? [];
  }

  async interrupt(sessionID: string): Promise<void> {
    try {
      await this.request("POST", `/api/session/${sessionID}/interrupt`, {});
    } catch {
      /* cancelling is best-effort */
    }
  }

  async subscribe(onEvent: (event: OpencodeMessage) => void): Promise<() => void> {
    const url = new URL(this.options.baseUrl + "/api/event");
    url.searchParams.set("directory", this.options.directory);
    const controller = new AbortController();
    const res = await this.fetchImpl(url, {
      headers: { authorization: basicAuth(this.options.password), accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`opencode event stream failed (${res.status})`);

    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              onEvent(JSON.parse(payload) as OpencodeMessage);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      } catch {
        /* aborted or closed */
      }
    })();

    return () => controller.abort();
  }
}

function summarize(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
