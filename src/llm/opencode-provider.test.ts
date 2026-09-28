import test from "node:test";
import assert from "node:assert/strict";
import { basicAuth, type OpencodeClient, type OpencodeMessage } from "./opencode-client.js";
import { OpencodeProvider, buildPromptText } from "./opencode-provider.js";

interface StubOptions {
  catalog?: Array<{ id: string; providerID: string; enabled?: boolean }>;
  /** Assistant turns, in order. A turn without `finish` is "still streaming". */
  turns?: Array<{ text: string; finish?: string }>;
  /** Text deltas pushed through the event stream. */
  deltas?: string[];
  createError?: Error;
  promptError?: Error;
  health?: boolean;
  /** Number of `readMessages` calls before the first finished turn appears. */
  pollsBeforeDone?: number;
}

/** Records what the provider asked the server to do. */
interface Stub {
  client: OpencodeClient;
  created: Array<Record<string, unknown>>;
  prompted: Array<{ sessionID: string; text: string }>;
  interrupted: string[];
  closedStreams: number;
}

function stubClient(options: StubOptions = {}): Stub {
  const catalog = options.catalog ?? [
    { id: "space-bunny-free", providerID: "opencode-go" },
    { id: "gpt-5.6-luna", providerID: "opencode-go" },
    { id: "claude-sonnet-4.5", providerID: "anthropic" },
    { id: "retired-model", providerID: "opencode-go", enabled: false },
  ];
  const turns = options.turns ?? [{ text: "hello", finish: "stop" }];
  const deltas = options.deltas ?? [];
  const pollsBeforeDone = options.pollsBeforeDone ?? 0;

  const created: Array<Record<string, unknown>> = [];
  const prompted: Array<{ sessionID: string; text: string }> = [];
  const interrupted: string[] = [];
  const stub = { created, prompted, interrupted, closedStreams: 0 } as Stub;

  let reads = -1;

  const client: OpencodeClient = {
    async health() {
      return options.health ?? true;
    },
    async listModels() {
      return catalog;
    },
    async createSession(opts) {
      if (options.createError) throw options.createError;
      created.push(opts ?? {});
      return "ses_test";
    },
    async prompt(sessionID, text) {
      if (options.promptError) throw options.promptError;
      prompted.push({ sessionID, text });
      reads = 0;
    },
    async interrupt(sessionID) {
      interrupted.push(sessionID);
    },
    async readMessages() {
      if (reads < 0) return [];
      reads += 1;
      const current = turns[Math.min(reads, turns.length - 1)];
      // Stay unfinished for the first few polls so the retry loop is exercised.
      const finished = reads > pollsBeforeDone && current.finish !== undefined;
      return [
        { type: "user", id: "msg_user" },
        {
          type: "assistant",
          id: "msg_assistant",
          ...(finished ? { finish: current.finish } : {}),
          content: [{ type: "text", text: current.text } as const],
        },
      ] satisfies OpencodeMessage[];
    },
    async subscribe(onEvent) {
      // Traffic from other sessions must never reach the run.
      onEvent({ type: "session.text.delta", data: { sessionID: "ses_other", delta: "nope" } });
      queueMicrotask(() => {
        for (const delta of deltas) {
          onEvent({ type: "session.text.delta", data: { sessionID: "ses_test", delta } });
        }
      });
      return () => {
        stub.closedStreams += 1;
      };
    },
  };

  stub.client = client;
  return stub;
}

function makeProvider(
  stub: Stub,
  overrides: Partial<ConstructorParameters<typeof OpencodeProvider>[0]> = {},
): OpencodeProvider {
  return new OpencodeProvider({
    defaultModel: "opencode/",
    directory: ".",
    clientFactory: () => stub.client,
    serverFactory: async () => ({ url: "http://127.0.0.1:4096", close: () => {} }),
    ...overrides,
  });
}

test("listModels exposes the whole opencode catalog, minus disabled models", async () => {
  const provider = makeProvider(stubClient());
  assert.deepEqual(await provider.listModels(), [
    "opencode/anthropic/claude-sonnet-4.5",
    "opencode/opencode-go/gpt-5.6-luna",
    "opencode/opencode-go/space-bunny-free",
  ]);
});

test("health reflects the server", async () => {
  assert.equal(await makeProvider(stubClient({ health: true })).health(), true);
  assert.equal(await makeProvider(stubClient({ health: false })).health(), false);
});

test("a spawned server is given a generated password, not a configured one", async () => {
  let seen = "";
  const provider = makeProvider(stubClient(), {
    password: "from-env",
    clientFactory: ({ password }) => {
      seen = password;
      return stubClient().client;
    },
  });
  await provider.health();
  assert.notEqual(seen, "from-env");
  assert.ok(seen.length > 0);
});

test("attaching to a server with no discoverable password fails with guidance", async () => {
  const provider = new OpencodeProvider({
    defaultModel: "opencode/",
    directory: ".",
    baseUrl: "http://127.0.0.1:4096",
    password: "",
    readServicePassword: () => "",
    clientFactory: () => stubClient().client,
  });
  await assert.rejects(() => provider.listModels(), /requires a password/);
});

test("attaching reuses a password found in the CLI's service config", async () => {
  let seen = "";
  const provider = new OpencodeProvider({
    defaultModel: "opencode/",
    directory: ".",
    baseUrl: "http://127.0.0.1:4096",
    password: "",
    readServicePassword: () => "from-service-json",
    clientFactory: ({ password }) => {
      seen = password;
      return stubClient().client;
    },
  });
  await provider.health();
  assert.equal(seen, "from-service-json");
});

test("basicAuth encodes the fixed opencode username", () => {
  assert.equal(
    basicAuth("s3cret"),
    `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`,
  );
});

test("run resolves an opencode-go model and returns the assistant text", async () => {
  const stub = stubClient();
  const provider = makeProvider(stub);
  const text = await provider.run({
    prompt: "hi",
    model: "opencode/opencode-go/space-bunny-free",
  });
  assert.equal(text, "hello");
  assert.deepEqual(stub.created[0], {
    model: { providerID: "opencode-go", id: "space-bunny-free" },
    // A spawned server gets the tool-free agent.
    agent: "jobseeker",
  });
  assert.deepEqual(stub.prompted[0], { sessionID: "ses_test", text: "hi" });
});

test("an attached server is not forced onto the spawned server's agent", async () => {
  const stub = stubClient();
  const provider = makeProvider(stub, { baseUrl: "http://127.0.0.1:4096", password: "p" });
  await provider.run({ prompt: "hi", model: "opencode/opencode-go/space-bunny-free" });
  assert.equal(stub.created[0].agent, undefined);
});

test("run rejects a model the opencode catalog does not offer", async () => {
  const provider = makeProvider(stubClient());
  await assert.rejects(
    () => provider.run({ prompt: "hi", model: "opencode/opencode-go/nope" }),
    /Unknown opencode model "opencode-go\/nope"/,
  );
});

test("run polls until the assistant turn is finished", async () => {
  const stub = stubClient({ pollsBeforeDone: 3 });
  const provider = makeProvider(stub);
  assert.equal(
    await provider.run({ prompt: "hi", model: "opencode/opencode-go/space-bunny-free" }),
    "hello",
  );
});

test("onChunk receives only this session's deltas", async () => {
  const stub = stubClient({ deltas: ["he", "llo"] });
  const provider = makeProvider(stub);
  const chunks: string[] = [];
  await provider.run({
    prompt: "hi",
    model: "opencode/opencode-go/space-bunny-free",
    onChunk: (delta) => chunks.push(delta),
  });
  assert.deepEqual(chunks, ["he", "llo"]);
  assert.equal(stub.closedStreams, 1, "the event stream must be closed");
});

test("a prompt failure is surfaced and the stream still closed", async () => {
  const stub = stubClient({ promptError: new Error("no key") });
  const provider = makeProvider(stub);
  await assert.rejects(
    () =>
      provider.run({
        prompt: "hi",
        model: "opencode/opencode-go/space-bunny-free",
        onChunk: () => {},
      }),
    /no key/,
  );
  assert.equal(stub.closedStreams, 1);
});

test("a timeout interrupts the session", async () => {
  const stub = stubClient({ turns: [{ text: "never" }] });
  const provider = makeProvider(stub);
  await assert.rejects(
    () =>
      provider.run({
        prompt: "hi",
        model: "opencode/opencode-go/space-bunny-free",
        timeoutMs: 1,
      }),
    /timed out after 1ms/,
  );
  assert.deepEqual(stub.interrupted, ["ses_test"]);
});

test("buildPromptText inlines the system prompt and any JSON schema", () => {
  const text = buildPromptText({
    prompt: "extract this",
    systemPrompt: "be terse",
    jsonSchema: { type: "object" },
  });
  assert.match(text, /<system-instructions>\nbe terse\n<\/system-instructions>/);
  assert.match(text, /<json-schema>\n\{"type":"object"\}\n<\/json-schema>/);
  assert.ok(text.endsWith("extract this"));
  assert.equal(buildPromptText({ prompt: "plain" }), "plain");
});

test("setModel only accepts opencode-prefixed IDs", () => {
  const provider = makeProvider(stubClient());
  provider.setModel("opencode/opencode-go/space-bunny-free");
  assert.equal(provider.getModel(), "opencode/opencode-go/space-bunny-free");
  assert.throws(() => provider.setModel("github-copilot/gpt-5.6-luna"), /Only opencode/);
});
