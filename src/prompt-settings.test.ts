import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROMPT_TEMPLATES } from "./prompts.js";
import {
  PROMPT_DEFINITIONS,
  renderPrompt,
  validatePromptContent,
} from "./prompt-settings.js";

test("all built-in prompt templates contain their required placeholders", () => {
  for (const definition of PROMPT_DEFINITIONS) {
    assert.doesNotThrow(() =>
      validatePromptContent(definition.id, DEFAULT_PROMPT_TEMPLATES[definition.id]),
    );
  }
});

test("prompt validation rejects unknown and missing placeholders", () => {
  assert.throws(
    () => validatePromptContent("idle-chat", "Message: {{message}}\n{{unknown}}"),
    /Unknown placeholder/,
  );
  assert.throws(
    () => validatePromptContent("idle-chat", "Please paste a listing."),
    /Missing required placeholder/,
  );
});

test("renderPrompt replaces values and rejects missing values", () => {
  assert.equal(renderPrompt("Role: {{role}}", { role: "Engineer" }), "Role: Engineer");
  assert.throws(() => renderPrompt("Role: {{role}}", {}), /Missing value/);
});
