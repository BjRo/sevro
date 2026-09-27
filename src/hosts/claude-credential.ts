import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_CREDENTIAL_BYTES = 1024 * 1024;

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
