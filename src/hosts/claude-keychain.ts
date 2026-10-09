import { existsSync } from "node:fs";

const MAX_CREDENTIAL_BYTES = 1024 * 1024;

function keychainProcess() {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/security"))
    throw new Error("Claude keychain credential is unavailable");
  const account = process.env.USER ?? process.env.LOGNAME;
  return Bun.spawn(
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

export async function keychainCredential(): Promise<Buffer> {
  const proc = keychainProcess();
  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, 10_000);
  const reader = proc.stdout.getReader();
  try {
    const credential = await boundedCredentialStream(reader);
    if ((await proc.exited) !== 0)
      throw new Error("Claude keychain credential is unavailable");
    return credential;
  } catch (error) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error("Claude keychain credential is unavailable", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
