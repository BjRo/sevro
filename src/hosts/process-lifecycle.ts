export const MAX_EVENT_BYTES = 8 * 1024 * 1024;

/** Bound bytes before decoding a host's output with strict UTF-8. */
export async function boundedProcessText(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  exceededMessage: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) throw new Error(exceededMessage);
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

/** Race completion against the host deadline and cancellation, then release listeners. */
export async function awaitHostProcess<T>(
  proc: Bun.Subprocess,
  completed: Promise<T>,
  options: {
    host: "Codex" | "Claude";
    timeoutMs: number;
    signal?: AbortSignal;
    stop: (proc: Bun.Subprocess) => void;
  },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${options.host} run timed out`));
      }, options.timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return;
      cancel = () => {
        reject(new Error(`${options.host} run cancelled`));
      };
      if (options.signal.aborted) cancel();
      else options.signal.addEventListener("abort", cancel, { once: true });
    });
    return await Promise.race([completed, timeout, aborted]);
  } catch (error) {
    options.stop(proc);
    await proc.exited;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
  }
}
