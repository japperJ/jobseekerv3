import test from "node:test";
import assert from "node:assert/strict";
import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { CopilotProvider } from "./copilot-provider.js";

interface StubSessionOptions {
  /** Whole-message snapshots emitted through `assistant.message`, in order. */
  messages?: string[];
  /** Final text returned by `sendAndWait`. Defaults to the last snapshot. */
  finalText?: string;
  failWith?: Error;
}

interface StubClient {
  sessions: Array<Record<string, unknown>>;
  stopped: boolean;
}

function stubClient(options: StubSessionOptions = {}): {
  client: CopilotClient;
  stub: StubClient;
} {
  const handlers = new Map<string, (event: unknown) => void>();
  const messages = options.messages ?? [];
  const finalText = options.finalText ?? messages[messages.length - 1] ?? "";

  const session = {
    on(event: string, handler: (event: unknown) => void) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    async sendAndWait() {
      for (const content of messages) {
        handlers.get("assistant.message")?.({ data: { content } });
      }
      if (options.failWith) throw options.failWith;
      return { data: { content: finalText } };
    },
    async disconnect() {},
  } as unknown as CopilotSession;

  const stub: StubClient = { sessions: [], stopped: false };
  const client = {
    createSession(config: Record<string, unknown>) {
      stub.sessions.push(config);
      return session;
    },
    async listModels() {
      return [
        { id: "gpt-5.6-luna" },
        { id: "github-copilot/gpt-5-mini" },
        { id: "opencode/anthropic/claude-sonnet-4.5" },
      ];
    },
    async stop() {
      stub.stopped = true;
    },
  } as unknown as CopilotClient;

  return { client, stub };
}

function providerWith(client: CopilotClient, defaultModel = "github-copilot/gpt-5.6-luna") {
  return new CopilotProvider(defaultModel, async () => client);
}

test("onChunk receives only the new suffix of each whole message", async () => {
  const { client } = stubClient({ messages: ["Hello", "Hello world", "Hello world!"] });
  const provider = providerWith(client);
  const chunks: string[] = [];

  const reply = await provider.run({ prompt: "hi", onChunk: (d) => chunks.push(d) });

  assert.equal(reply, "Hello world!");
  assert.deepEqual(chunks, ["Hello", " world", "!"]);
  assert.equal(chunks.join(""), reply);
});

test("a plain system prompt becomes a Copilot customize config", async () => {
  const { client, stub } = stubClient({ finalText: "ok" });
  const provider = providerWith(client);

  await provider.run({ prompt: "hi", systemPrompt: "be terse" });

  assert.deepEqual(stub.sessions[0].systemMessage, {
    mode: "customize",
    sections: { identity: { action: "replace", content: "be terse" } },
  });
});

test("no system prompt means no systemMessage override", async () => {
  const { client, stub } = stubClient({ finalText: "ok" });
  await providerWith(client).run({ prompt: "hi" });
  assert.equal(stub.sessions[0].systemMessage, undefined);
});

test("the provider prefix is stripped before reaching the SDK", async () => {
  const { client, stub } = stubClient({ finalText: "ok" });
  await providerWith(client).run({ prompt: "hi", model: "github-copilot/gpt-5-mini" });
  assert.equal(stub.sessions[0].model, "gpt-5-mini");
});

test("listModels qualifies bare IDs and drops other providers", async () => {
  const { client } = stubClient();
  assert.deepEqual(await providerWith(client).listModels(), [
    "github-copilot/gpt-5-mini",
    "github-copilot/gpt-5.6-luna",
  ]);
});

test("a failed run is retried once with a fresh client", async () => {
  const failing = stubClient({ failWith: new Error("connection lost") });
  const working = stubClient({ finalText: "recovered" });
  let call = 0;
  const provider = new CopilotProvider("github-copilot/gpt-5.6-luna", async () => {
    call += 1;
    return call === 1 ? failing.client : working.client;
  });

  const reply = await provider.run({ prompt: "hi" });

  assert.equal(reply, "recovered");
  assert.equal(call, 2);
  assert.equal(failing.stub.stopped, true);
});

test("setModel only accepts github-copilot models", () => {
  const { client } = stubClient();
  const provider = providerWith(client);

  provider.setModel("GitHub-Copilot/GPT-5-Mini");
  assert.equal(provider.getModel(), "github-copilot/gpt-5-mini");

  assert.throws(() => provider.setModel("opencode/openai/gpt-5"), /Only github-copilot/);
  assert.throws(() => provider.setModel(""), /cannot be empty/);
});
