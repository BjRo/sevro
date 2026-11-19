import { spawn } from "../platform/index";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import {
  MAX_CREDENTIAL_BYTES,
  requireBoundedCredential,
  type ClaudeKeychainStore,
  type ClaudeLoginStore,
} from "./claude-login-store";

const SECURITY = "/usr/bin/security";
/** `security` reports errSecItemNotFound with this exit status. */
const ITEM_NOT_FOUND = 44;
/** Claude Code's bound for one `security -i` command line. */
const INTERACTIVE_LINE_LIMIT = 4032;
const KEYCHAIN_TIMEOUT_MS = 10_000;

function requireSecurity(): void {
  if (process.platform !== "darwin" || !existsSync(SECURITY))
    throw new Error("Claude keychain credential is unavailable");
}

async function boundedCredentialStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CREDENTIAL_BYTES)
      throw new Error("Claude credential exceeds the size limit");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function findItem(
  service: string,
  account: string,
): Promise<Buffer | undefined> {
  requireSecurity();
  const proc = spawn(
    [SECURITY, "find-generic-password", "-a", account, "-s", service, "-w"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, KEYCHAIN_TIMEOUT_MS);
  const reader = proc.stdout.getReader();
  try {
    const credential = await boundedCredentialStream(reader);
    const code = await proc.exited;
    if (code === ITEM_NOT_FOUND) return undefined;
    if (code !== 0)
      throw new Error("Claude keychain credential is unavailable");
    return requireBoundedCredential(credential);
  } catch (error) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error("Claude credential is unreadable or unavailable", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** Mirror Claude Code's update so the secret stays off argv when it fits. */
function updateCommand(service: string, account: string, bytes: Buffer) {
  const hex = bytes.toString("hex");
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  return line.length <= INTERACTIVE_LINE_LIMIT
    ? { command: [SECURITY, "-i"], stdin: Buffer.from(line) }
    : {
        command: [
          SECURITY,
          "add-generic-password",
          "-U",
          "-a",
          account,
          "-s",
          service,
          "-X",
          hex,
        ],
        stdin: undefined,
      };
}

async function updateItem(
  service: string,
  account: string,
  bytes: Buffer,
): Promise<void> {
  requireSecurity();
  const { command, stdin } = updateCommand(service, account, bytes);
  const proc = spawn(command, {
    stdin: stdin ?? "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, KEYCHAIN_TIMEOUT_MS);
  try {
    if ((await proc.exited) !== 0)
      throw new Error("Claude keychain login could not be updated");
  } finally {
    clearTimeout(timer);
  }
}

/** Claude keys a non-default configuration's Keychain item by its path. */
function claudeKeychainService(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (!configured) return "Claude Code-credentials";
  const digest = createHash("sha256")
    .update(configured.normalize("NFC"))
    .digest("hex");
  return `Claude Code-credentials-${digest.substring(0, 8)}`;
}

function claudeKeychainAccount(): string {
  let account: string;
  try {
    account = process.env.USER || userInfo().username;
  } catch {
    return "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/.test(account) ? account : "claude-code-user";
}

async function keychainLoginStore(
  configRoot: string,
): Promise<ClaudeLoginStore | undefined> {
  const service = claudeKeychainService();
  const account = claudeKeychainAccount();
  if (!(await findItem(service, account))) return undefined;
  return {
    origin: `macOS Keychain item "${service}"`,
    lockRoot: configRoot,
    read: async () => requireStoredLogin(await findItem(service, account)),
    write: (bytes) => updateItem(service, account, bytes),
  };
}

function requireStoredLogin(bytes: Buffer | undefined): Buffer {
  if (!bytes) throw new Error("Claude credential is unreadable or unavailable");
  return bytes;
}

async function savedFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Select the configuration's own Keychain item, as Claude Code does. */
export const claudeKeychainStore: ClaudeKeychainStore = (
  configRoot,
  savedFile,
) =>
  keychainLoginStore(configRoot).catch(async (cause: unknown) => {
    // Claude falls back to its saved file when the Keychain cannot be read.
    if (await savedFileExists(savedFile)) return undefined;
    throw cause;
  });
