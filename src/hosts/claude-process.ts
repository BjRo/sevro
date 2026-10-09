import {
  awaitHostProcess,
  boundedProcessText,
  MAX_EVENT_BYTES,
} from "./process-lifecycle";

const MAX_STDERR_BYTES = 64 * 1024;

function stop(proc: Bun.Subprocess): void {
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
    else proc.kill("SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

export async function runClaudeProcess(options: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ code: number; out: string; err: string }> {
  if (options.signal?.aborted) throw new Error("Claude run cancelled");
  const proc = Bun.spawn(options.argv, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const completed = Promise.all([
    boundedProcessText(
      proc.stdout,
      MAX_EVENT_BYTES,
      "Claude process output exceeds its limit",
    ),
    boundedProcessText(
      proc.stderr,
      MAX_STDERR_BYTES,
      "Claude process output exceeds its limit",
    ),
    proc.exited,
  ]).then(([out, err, code]) => ({ out, err, code }));
  return awaitHostProcess(proc, completed, {
    ...options,
    host: "Claude",
    stop,
  });
}
