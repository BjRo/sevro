import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

export class RuntimeMetadataQueryError extends Error {
  constructor(
    message: string,
    readonly noActiveDeveloper = false,
  ) {
    super(message);
  }
}

function exitError(
  code: number | null,
  stderr: Buffer[],
): RuntimeMetadataQueryError {
  const noSelection =
    code === 2 &&
    Buffer.concat(stderr)
      .toString("utf8")
      .toLowerCase()
      .includes("unable to get active developer directory");
  return new RuntimeMetadataQueryError(`exit ${String(code)}`, noSelection);
}

function stopQuery(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Bound both output streams and stop every descendant of this metadata query. */
export function runtimeMetadataQuery(
  executable: string,
  argument: string,
  environment: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [argument], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...environment,
        HOME: homedir(),
        HOMEBREW_NO_AUTO_UPDATE: "1",
        LC_ALL: "C",
        LANG: "C",
      },
    });
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const fail = (reason: string, cause?: unknown) => {
      stopQuery(child);
      reject(new Error(reason, { cause }));
    };
    const timer = setTimeout(() => {
      fail("timeout exceeded");
    }, 3000);
    const consume = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192) fail("output limit exceeded");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      consume(chunk);
      if (bytes <= 8192) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      consume(chunk);
      if (bytes <= 8192) stderr.push(chunk);
    });
    child.on("error", (cause: Error) => {
      fail("provider unavailable", cause);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      stopQuery(child);
      if (code !== 0) reject(exitError(code, stderr));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
