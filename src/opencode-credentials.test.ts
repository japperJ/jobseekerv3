import test from "node:test";
import assert from "node:assert/strict";
import {
  OpencodeCredentialStore,
  maskKey,
  validateKey,
  type CommandRunner,
  type StoredCredential,
} from "./opencode-credentials.js";

const CREDENTIAL: StoredCredential = {
  id: "cred_test123",
  integrationID: "opencode-go",
  label: "default",
  active: true,
  value: { type: "key", key: "oc_sk_example_abcdefgh" },
};

/** Records every CLI invocation and answers from canned responses. */
function fakeRunner(options: { exportStdout?: string; importCode?: number; logoutCode?: number } = {}) {
  const calls: Array<{ bin: string; args: string[]; stdin?: string }> = [];
  const runCommand: CommandRunner = async (bin, args, stdin) => {
    calls.push({ bin, args, stdin });
    if (args.includes("export")) {
      return { code: 0, stdout: options.exportStdout ?? JSON.stringify([CREDENTIAL]), stderr: "" };
    }
    if (args.includes("import")) {
      return { code: options.importCode ?? 0, stdout: "Imported 1 credential", stderr: "" };
    }
    if (args.includes("logout")) {
      return { code: options.logoutCode ?? 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
  };
  return { calls, runCommand };
}

function makeStore(runCommand: CommandRunner, bin = "opencode") {
  return new OpencodeCredentialStore({ bin, runCommand });
}

test("maskKey keeps only the last four characters", () => {
  assert.equal(maskKey("oc_sk_example_abcdefgh"), "…efgh");
  assert.equal(maskKey("  secret-ends-here9  "), "…ere9");
});

test("maskKey never exposes a short key", () => {
  assert.equal(maskKey("abc"), "****");
});

test("validateKey trims and rejects unusable input", () => {
  assert.equal(validateKey("  oc_sk_new  "), "oc_sk_new");
  assert.throws(() => validateKey("   "), /empty/);
  assert.throws(() => validateKey("oc_sk\nwith-newline"), /spaces or line breaks/);
});

test("get reports a stored key without revealing it", async () => {
  const { calls, runCommand } = fakeRunner();
  const summary = await makeStore(runCommand).get();

  assert.deepEqual(summary, { present: true, masked: "…efgh", credId: "cred_test123" });
  assert.equal(JSON.stringify(summary).includes("oc_sk_example"), false);
  assert.deepEqual(calls[0].args, ["auth", "export", "OpenCode Go"]);
});

test("get reports missing when nothing is stored", async () => {
  const { runCommand } = fakeRunner({ exportStdout: "[]" });
  assert.deepEqual(await makeStore(runCommand).get(), { present: false });
});

test("get treats unparseable CLI output as missing instead of crashing", async () => {
  const { runCommand } = fakeRunner({ exportStdout: "Try `opencode auth login`" });
  assert.deepEqual(await makeStore(runCommand).get(), { present: false });
});

test("get ignores credentials belonging to other integrations", async () => {
  const { runCommand } = fakeRunner({
    exportStdout: JSON.stringify([{ ...CREDENTIAL, integrationID: "azure" }]),
  });
  assert.deepEqual(await makeStore(runCommand).get(), { present: false });
});

test("set stores the key via auth import, without a prior logout", async () => {
  const { calls, runCommand } = fakeRunner({ exportStdout: "[]" });
  await makeStore(runCommand).set("  oc_sk_brand_new_key  ");

  assert.deepEqual(calls.map((call) => call.args.join(" ")), [
    "auth export OpenCode Go",
    "auth import",
    "auth export OpenCode Go",
  ], "no logout may run when no key is stored");
  assert.equal(calls[1].bin, "opencode");
  const [record] = JSON.parse(calls[1].stdin ?? "[]");
  assert.equal(record.integrationID, "opencode-go");
  assert.equal(record.value.key, "oc_sk_brand_new_key", "the key must be trimmed");
});

test("set logs the old credential out before importing the new one", async () => {
  const { calls, runCommand } = fakeRunner();
  await makeStore(runCommand).set("oc_sk_replacement_key");

  const order = calls.map((call) => call.args.join(" "));
  assert.deepEqual(order, [
    "auth export OpenCode Go",
    "auth logout opencode-go cred_test123",
    "auth import",
    "auth export OpenCode Go",
  ]);
});

test("set rejects an empty key before touching the credential store", async () => {
  const { calls, runCommand } = fakeRunner();
  await assert.rejects(() => makeStore(runCommand).set("   "), /empty/);
  assert.equal(calls.length, 0);
});

test("set surfaces a failed import", async () => {
  const { runCommand } = fakeRunner({ exportStdout: "[]", importCode: 1 });
  await assert.rejects(() => makeStore(runCommand).set("oc_sk_key"), /auth import failed/);
});

test("remove deletes the stored credential", async () => {
  const { calls, runCommand } = fakeRunner();
  await makeStore(runCommand).remove();
  assert.deepEqual(calls.map((call) => call.args), [
    ["auth", "export", "OpenCode Go"],
    ["auth", "logout", "opencode-go", "cred_test123"],
  ]);
});

test("remove is a no-op when nothing is stored", async () => {
  const { calls, runCommand } = fakeRunner({ exportStdout: "[]" });
  await makeStore(runCommand).remove();
  assert.equal(calls.length, 1, "only the export should run");
});

test("the configured binary is used for every call", async () => {
  const { calls, runCommand } = fakeRunner();
  await makeStore(runCommand, "C:\\tools\\opencode.exe").get();
  assert.equal(calls[0].bin, "C:\\tools\\opencode.exe");
});
