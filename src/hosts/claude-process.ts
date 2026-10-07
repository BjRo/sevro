const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function stop(proc: Bun.Subprocess): void {
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
    else proc.kill("SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

async function boundedStream(
  stream: ReadableStream<Uint8Array>,
  limit = MAX_EVENT_BYTES,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit)
      throw new Error("Claude process output exceeds its limit");
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const completed = Promise.all([
      boundedStream(proc.stdout),
      boundedStream(proc.stderr, MAX_STDERR_BYTES),
      proc.exited,
    ]).then(([out, err, code]) => ({ out, err, code }));
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Claude run timed out"));
      }, options.timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return;
      cancel = () => {
        reject(new Error("Claude run cancelled"));
      };
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    });
    return await Promise.race([completed, timeout, aborted]);
  } catch (error) {
    stop(proc);
    await proc.exited;
    throw error;
  } finally {
    releaseProcessListeners(timer, cancel, options.signal);
  }
}

function releaseProcessListeners(
  timer: ReturnType<typeof setTimeout> | undefined,
  cancel: (() => void) | undefined,
  signal: AbortSignal | undefined,
): void {
  if (timer) clearTimeout(timer);
  if (cancel) signal?.removeEventListener("abort", cancel);
}
