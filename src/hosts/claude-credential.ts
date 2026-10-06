import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const MAX_CREDENTIAL_BYTES = 1024 * 1024;

async function savedClaudeCredential(): Promise<string | undefined> {
  const path = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    ".credentials.json",
  );
  try {
    await stat(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Claude saved credential is unreadable or unavailable");
  }
}

export const CLAUDE_AUTH_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** Keep the CLI's authentication separate from the candidate tool environment. */
export async function stageClaudeAuthentication(
  configRoot: string,
  sourceFile?: string,
) {
  const environment: Record<string, string> = {};
  if (sourceFile === undefined) {
    for (const name of CLAUDE_AUTH_VARIABLES) {
      const value = process.env[name];
      if (value) {
        if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES)
          throw new Error(
            "Claude environment credential exceeds the size limit",
          );
        environment[name] = value;
      }
    }
  }
  if (Object.keys(environment).length) {
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    return {
      credentialFile: join(configRoot, ".credentials.json"),
      environment,
    };
  }
  return {
    credentialFile: await stageClaudeCredential(configRoot, sourceFile),
    environment,
  };
}

async function keychainCredential(): Promise<Buffer> {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/security"))
    throw new Error("Claude keychain credential is unavailable");
  const account = process.env.USER ?? process.env.LOGNAME;
  const proc = Bun.spawn(
    [
      "/usr/bin/security",
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      ...(account ? ["-a", account] : []),
      "-w",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CREDENTIAL_BYTES)
        throw new Error("Claude credential exceeds the size limit");
      chunks.push(value);
    }
    if ((await proc.exited) !== 0)
      throw new Error("Claude keychain credential is unavailable");
    return Buffer.concat(chunks);
  } catch {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error("Claude keychain credential is unavailable");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** Copy only a bounded login credential into one private host state. */
export async function stageClaudeCredential(
  configRoot: string,
  sourceFile?: string,
): Promise<string> {
  sourceFile ??= await savedClaudeCredential();
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  let credential: Buffer;
  try {
    if (sourceFile) {
      if ((await stat(sourceFile)).size > MAX_CREDENTIAL_BYTES)
        throw new Error("oversized credential");
      credential = await readFile(sourceFile);
    } else credential = await keychainCredential();
  } catch {
    throw new Error("Claude credential is unreadable or unavailable");
  }
  if (
    credential.byteLength === 0 ||
    credential.byteLength > MAX_CREDENTIAL_BYTES ||
    !credential.toString("utf8").trim()
  )
    throw new Error("Claude credential is empty or oversized");
  const target = join(configRoot, ".credentials.json");
  await writeFile(target, credential, { flag: "wx", mode: 0o600 });
  return target;
}
