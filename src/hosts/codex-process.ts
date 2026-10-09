import {
  awaitHostProcess,
  boundedProcessText,
  MAX_EVENT_BYTES,
} from "./process-lifecycle";

function stopProcess(proc: Bun.Subprocess): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // The group may have exited before cancellation.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

export async function runCodexProcess(options: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ code: number; out: string }> {
  if (options.signal?.aborted) throw new Error("Codex run cancelled");
  const proc = Bun.spawn(options.argv, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const written = (async () => {
    if (options.input === undefined) return;
    if (!proc.stdin || typeof proc.stdin === "number")
      throw new Error("Codex input pipe unavailable");
    await proc.stdin.write(options.input);
    await proc.stdin.end();
  })();
  const completed = Promise.all([
    boundedProcessText(
      proc.stdout,
      MAX_EVENT_BYTES,
      "Codex event stream exceeds the size limit",
    ),
    proc.exited,
    written,
  ]).then(([out, code]) => ({ out, code }));
  return awaitHostProcess(proc, completed, {
    ...options,
    host: "Codex",
    stop: stopProcess,
  });
}
