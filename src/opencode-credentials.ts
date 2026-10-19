import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * Storage for the OpenCode Go API key.
 *
 * The key is kept in **opencode's own credential store** (the one behind
 * `opencode auth list`), because that is where the spawned `opencode serve`
 * reads provider credentials from. This app never persists the key itself:
 * it shells out to the `opencode auth` CLI, the same interface a human uses.
 */

/** Integration ID of opencode's hosted provider in the credential store. */
export const OPENCODE_GO_INTEGRATION = "opencode-go";

/** Name the `opencode auth` CLI uses for that integration. */
const OPENCODE_GO_LABEL = "OpenCode Go";

/** One credential record as printed by `opencode auth export`. */
export interface StoredCredential {
  id: string;
  integrationID: string;
  label?: string;
  active?: boolean;
  value?: { type?: string; key?: string };
}

/** What the app is allowed to know about the stored key. */
export interface CredentialSummary {
  present: boolean;
  /** Last four characters only; the full key is never exposed. */
  masked?: string;
  /** Credential record id, needed to remove it again. */
  credId?: string;
}

/** Result of one `opencode auth …` invocation. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the opencode CLI; tests inject a stub. */
export type CommandRunner = (bin: string, args: string[], stdin?: string) => Promise<CommandResult>;

/** Renders a key for display: only the last four characters survive. */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? "****" : `…${trimmed.slice(-4)}`;
}

/** Rejects keys that are clearly wrong before the credential store is touched. */
export function validateKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw new Error("The API key is empty.");
  if (/\s/.test(key)) throw new Error("The API key must not contain spaces or line breaks.");
  return key;
}

export class OpencodeCredentialStore {
  private readonly runCommand: CommandRunner;

  constructor(options: { bin?: string; runCommand?: CommandRunner } = {}) {
    this.bin = options.bin?.trim() || "opencode";
    this.runCommand = options.runCommand ?? spawnCommand;
  }

  private readonly bin: string;

  /** The stored OpenCode Go credential, if any. */
  async get(): Promise<CredentialSummary> {
    const result = await this.exec(["export", OPENCODE_GO_LABEL]);
    let records: StoredCredential[] = [];
    try {
      const parsed = JSON.parse(result.stdout || "[]");
      if (Array.isArray(parsed)) records = parsed;
    } catch {
      // No credential stored: the CLI may print nothing or a non-JSON hint.
      records = [];
    }
    const credential = records.find(
      (record) => record.integrationID === OPENCODE_GO_INTEGRATION && record.value?.key,
    );
    if (!credential?.value?.key) return { present: false };
    return { present: true, masked: maskKey(credential.value.key), credId: credential.id };
  }

  /**
   * Replaces the stored credential (logging the old one out first) and returns
   * the resulting summary. The key passes through this process only — it is
   * never written to disk or logged by this app.
   */
  async set(rawKey: string): Promise<CredentialSummary> {
    const key = validateKey(rawKey);
    const existing = await this.get();
    if (existing.present && existing.credId) {
      await this.removeCredential(existing.credId);
    }
    const record: StoredCredential = {
      id: `cred_${randomBytes(12).toString("hex").toUpperCase()}`,
      integrationID: OPENCODE_GO_INTEGRATION,
      label: "default",
      active: true,
      value: { type: "key", key },
    };
    const imported = await this.exec(["import"], JSON.stringify([record]));
    if (imported.code !== 0) {
      throw new Error(`opencode auth import failed: ${summarize(imported)}`);
    }
    return this.get();
  }

  /** Deletes the stored credential, if any. */
  async remove(): Promise<void> {
    const existing = await this.get();
    if (existing.present && existing.credId) {
      await this.removeCredential(existing.credId);
    }
  }

  private async removeCredential(credId: string): Promise<void> {
    // Passing the id explicitly keeps this non-interactive: the CLI would
    // otherwise open an account picker, which a spawned process cannot answer.
    const result = await this.exec(["logout", OPENCODE_GO_INTEGRATION, credId]);
    if (result.code !== 0) {
      throw new Error(`opencode auth logout failed: ${summarize(result)}`);
    }
  }

  private exec(args: string[], stdin?: string): Promise<CommandResult> {
    return this.runCommand(this.bin, ["auth", ...args], stdin);
  }
}

/** Default runner: spawns the opencode CLI directly (no shell). */
const spawnCommand: CommandRunner = (bin, args, stdin) =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`\`${bin} ${args.join(" ")}\` timed out`));
    }, 60_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not run \`${bin}\`: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }
  });

function summarize(result: CommandResult): string {
  const text = (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
