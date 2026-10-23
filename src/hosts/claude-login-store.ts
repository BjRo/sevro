import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const MAX_CREDENTIAL_BYTES = 1024 * 1024;

/** The authoritative store that holds one saved Claude login. */
export interface ClaudeLoginStore {
  /** Credential-free identity of the store, used in errors and recovery. */
  origin: string;
  /** Claude configuration directory whose refresh lock guards this store. */
  lockRoot: string;
  read(): Promise<Buffer>;
  write(bytes: Buffer): Promise<void>;
}

/** Keychain operations; the macOS module supplies them only on Darwin. */
export interface ClaudeKeychain {
  read(service: string, account: string): Promise<Buffer | undefined>;
  write(service: string, account: string, bytes: Buffer): Promise<void>;
}

/** Resolve the store Claude Code itself uses for the selected login. */
export async function claudeLoginStore(
  sourceFile?: string,
  keychain?: ClaudeKeychain,
): Promise<ClaudeLoginStore> {
  if (sourceFile) return fileLoginStore(sourceFile, dirname(sourceFile));
  const configRoot = claudeConfigRoot();
  const file = join(configRoot, ".credentials.json");
  const saved = await keychainLoginStore(configRoot, keychain).catch(
    async (cause: unknown) => {
      // Claude falls back to its saved file when the Keychain cannot be read.
      if (await savedFileExists(file)) return undefined;
      throw cause;
    },
  );
  if (saved) return saved;
  await requireSavedFile(file);
  return fileLoginStore(file, configRoot);
}

async function savedFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function claudeConfigRoot(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
  ).normalize("NFC");
}

/** Claude keys a non-default configuration's Keychain item by its path. */
export function claudeKeychainService(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (!configured) return "Claude Code-credentials";
  const digest = createHash("sha256")
    .update(configured.normalize("NFC"))
    .digest("hex");
  return `Claude Code-credentials-${digest.substring(0, 8)}`;
}

export function claudeKeychainAccount(): string {
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
  keychain: ClaudeKeychain | undefined,
): Promise<ClaudeLoginStore | undefined> {
  if (!keychain) return undefined;
  const service = claudeKeychainService();
  const account = claudeKeychainAccount();
  if (!(await keychain.read(service, account))) return undefined;
  return {
    origin: `macOS Keychain item "${service}"`,
    lockRoot: configRoot,
    read: async () => requireStoredLogin(await keychain.read(service, account)),
    write: (bytes) => keychain.write(service, account, bytes),
  };
}

async function requireSavedFile(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? "Claude saved login is unavailable; run claude and /login"
        : "Claude saved credential is unreadable or unavailable",
      { cause },
    );
  }
}

function requireStoredLogin(bytes: Buffer | undefined): Buffer {
  if (!bytes) throw new Error("Claude credential is unreadable or unavailable");
  return bytes;
}

export function requireBoundedCredential(credential: Buffer): Buffer {
  if (
    credential.byteLength === 0 ||
    credential.byteLength > MAX_CREDENTIAL_BYTES ||
    !credential.toString("utf8").trim()
  )
    throw new Error("Claude credential is empty or oversized");
  return credential;
}

function fileLoginStore(path: string, lockRoot: string): ClaudeLoginStore {
  return {
    origin: path,
    lockRoot,
    read: () => readLoginFile(path),
    write: (bytes) => replaceLoginFile(path, bytes),
  };
}

async function readLoginFile(path: string): Promise<Buffer> {
  try {
    if ((await stat(path)).size > MAX_CREDENTIAL_BYTES)
      throw new Error("oversized credential");
    return await readFile(path);
  } catch (cause) {
    throw new Error("Claude credential is unreadable or unavailable", {
      cause,
    });
  }
}

/** Replace atomically so concurrent Claude readers never see a partial login. */
async function replaceLoginFile(path: string, bytes: Buffer): Promise<void> {
  const target = await realpath(path);
  const temporary = join(dirname(target), `.sevro-login-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
