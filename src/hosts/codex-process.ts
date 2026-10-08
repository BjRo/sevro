const MAX_EVENT_BYTES = 8 * 1024 * 1024;

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

async function boundedText(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit)
      throw new Error("Codex event stream exceeds the size limit");
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const written = (async () => {
      if (options.input === undefined) return;
      if (!proc.stdin || typeof proc.stdin === "number")
        throw new Error("Codex input pipe unavailable");
      await proc.stdin.write(options.input);
      await proc.stdin.end();
    })();
    const completed = Promise.all([
      boundedText(proc.stdout, MAX_EVENT_BYTES),
      proc.exited,
      written,
    ]).then(([out, code]) => ({ out, code }));
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Codex run timed out"));
      }, options.timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return;
      cancel = () => {
        reject(new Error("Codex run cancelled"));
      };
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    });
    return await Promise.race([completed, timeout, aborted]);
  } catch (error) {
    stopProcess(proc);
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
