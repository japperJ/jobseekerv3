import test from "node:test";
import assert from "node:assert/strict";
import { LlmManager } from "./manager.js";
import { FakeProvider } from "./fake-provider.js";
import { providerOf, qualifyModel, splitModelId, stripProvider } from "./types.js";

function makeManager() {
  const copilot = new FakeProvider({
    id: "github-copilot",
    models: ["github-copilot/gpt-5.6-luna", "github-copilot/gpt-5-mini"],
  });
  const opencode = new FakeProvider({
    id: "opencode",
    models: ["opencode/anthropic/claude-sonnet-4.5", "opencode/openai/gpt-5"],
  });
  const manager = new LlmManager({
    providers: [copilot, opencode],
    defaultModel: "github-copilot/gpt-5.6-luna",
  });
  return { manager, copilot, opencode };
}

test("splitModelId splits on the first slash only", () => {
  assert.deepEqual(splitModelId("opencode/anthropic/claude-sonnet-4.5"), {
    provider: "opencode",
    model: "anthropic/claude-sonnet-4.5",
  });
  assert.equal(splitModelId("gpt-5"), null);
  assert.equal(splitModelId("/gpt-5"), null);
  assert.equal(splitModelId("opencode/"), null);
});

test("providerOf, stripProvider and qualifyModel round-trip", () => {
  assert.equal(providerOf("OPENCODE/anthropic/claude"), "opencode");
  assert.equal(stripProvider("opencode/anthropic/claude", "opencode"), "anthropic/claude");
  assert.equal(stripProvider("anthropic/claude", "opencode"), "anthropic/claude");
  assert.equal(qualifyModel("opencode", "/anthropic/claude"), "opencode/anthropic/claude");
});

test("run routes to the provider named by the model prefix", async () => {
  const { manager, copilot, opencode } = makeManager();

  await manager.run({ prompt: "a" });
  await manager.run({ prompt: "b", model: "opencode/anthropic/claude-sonnet-4.5" });

  assert.equal(copilot.runs.length, 1);
  assert.equal(opencode.runs.length, 1);
  assert.equal(opencode.runs[0].model, "opencode/anthropic/claude-sonnet-4.5");
});

test("run passes the system prompt and JSON schema through untouched", async () => {
  const { manager, opencode } = makeManager();
  const schema = { type: "object", properties: { has: { type: "boolean" } } };

  await manager.run({
    prompt: "p",
    model: "opencode/openai/gpt-5",
    systemPrompt: "be terse",
    jsonSchema: schema,
    label: "interpret",
  });

  assert.equal(opencode.runs[0].systemPrompt, "be terse");
  assert.deepEqual(opencode.runs[0].jsonSchema, schema);
  assert.equal(opencode.runs[0].label, "interpret");
});

test("run rejects models from unregistered providers", async () => {
  const { manager } = makeManager();
  await assert.rejects(() => manager.run({ prompt: "p", model: "anthropic/claude" }), /Unknown model/);
  await assert.rejects(() => manager.run({ prompt: "p", model: "gpt-5" }), /Unknown model/);
});

test("setModel accepts any registered provider and rejects others", () => {
  const { manager } = makeManager();

  manager.setModel("opencode/anthropic/claude-sonnet-4.5");
  assert.equal(manager.getModel(), "opencode/anthropic/claude-sonnet-4.5");

  manager.setModel("GitHub-Copilot/GPT-5-Mini");
  assert.equal(manager.getModel(), "github-copilot/gpt-5-mini");

  assert.throws(() => manager.setModel("anthropic/claude"), /Unknown model/);
  assert.throws(() => manager.setModel("   "), /cannot be empty/);
  assert.equal(manager.getModel(), "github-copilot/gpt-5-mini");
});

test("listModels aggregates every provider, listModelsByProvider groups them", async () => {
  const { manager } = makeManager();

  assert.deepEqual(await manager.listModels(), [
    "github-copilot/gpt-5.6-luna",
    "github-copilot/gpt-5-mini",
    "opencode/anthropic/claude-sonnet-4.5",
    "opencode/openai/gpt-5",
  ]);

  assert.deepEqual(await manager.listModelsByProvider(), [
    { id: "github-copilot", models: ["github-copilot/gpt-5.6-luna", "github-copilot/gpt-5-mini"] },
    { id: "opencode", models: ["opencode/anthropic/claude-sonnet-4.5", "opencode/openai/gpt-5"] },
  ]);
});

test("a failing provider degrades to an empty model list instead of throwing", async () => {
  const broken = new FakeProvider({ id: "github-copilot" });
  broken.listModels = async () => {
    throw new Error("cli missing");
  };
  const ok = new FakeProvider({ id: "opencode", models: ["opencode/openai/gpt-5"] });
  const manager = new LlmManager({ providers: [broken, ok], defaultModel: "opencode/openai/gpt-5" });

  assert.deepEqual(await manager.listModels(), ["opencode/openai/gpt-5"]);
  assert.deepEqual(await manager.listModelsByProvider(), [
    { id: "github-copilot", models: [] },
    { id: "opencode", models: ["opencode/openai/gpt-5"] },
  ]);
});

test("healthByProvider reports each provider and survives failures", async () => {
  const { manager, opencode } = makeManager();
  opencode.healthy = false;

  assert.deepEqual(await manager.healthByProvider(), {
    "github-copilot": true,
    opencode: false,
  });
  assert.equal(await manager.health(), true);

  manager.setModel("opencode/openai/gpt-5");
  assert.equal(await manager.health(), false);
});

test("stop fans out to every provider", async () => {
  const { manager, copilot, opencode } = makeManager();
  await manager.stop();
  assert.equal(copilot.stopped, true);
  assert.equal(opencode.stopped, true);
});

test("onChunk receives incremental deltas that reassemble the reply", async () => {
  const { manager } = makeManager();
  const chunks: string[] = [];

  const reply = await manager.run({
    prompt: "p",
    model: "github-copilot/gpt-5.6-luna",
    onChunk: (delta) => chunks.push(delta),
  });

  assert.equal(reply, "fake reply");
  assert.equal(chunks.join(""), reply);
});

test("a manager requires at least one provider", () => {
  assert.throws(() => new LlmManager({ providers: [], defaultModel: "x/y" }), /at least one provider/);
});
