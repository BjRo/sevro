import { randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
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

/**
 * Select a configuration directory's Keychain login, or none when it has no
 * item. Only the macOS module supplies one; a Keychain that cannot be read
 * yields to an existing saved file, as Claude Code does.
 */
export type ClaudeKeychainStore = (
  configRoot: string,
  savedFile: string,
) => Promise<ClaudeLoginStore | undefined>;

/** Resolve the store Claude Code itself uses for the selected login. */
export async function claudeLoginStore(
  sourceFile: string | undefined,
  keychainStore: ClaudeKeychainStore,
): Promise<ClaudeLoginStore> {
  if (sourceFile) return fileLoginStore(sourceFile, dirname(sourceFile));
  const configRoot = claudeConfigRoot();
  const file = join(configRoot, ".credentials.json");
  const saved = await keychainStore(configRoot, file);
  if (saved) return saved;
  await requireSavedFile(file);
  return fileLoginStore(file, configRoot);
}

function claudeConfigRoot(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
  ).normalize("NFC");
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
