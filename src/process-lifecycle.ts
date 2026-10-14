export type ProcessInterruptionReason = "timeout" | "cancelled";

interface DeadlineOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  interruption: (reason: ProcessInterruptionReason) => Error;
}

/** Keep the deadline active until the caller has finished failure cleanup. */
export class ProcessDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancel: (() => void) | undefined;

  constructor(private readonly options: DeadlineOptions) {}

  wait<T>(completed: Promise<T> | (() => Promise<T>)): Promise<T> {
    const timeout = this.timeout();
    const aborted = this.aborted();
    const completion =
      typeof completed === "function" ? completed() : completed;
    return Promise.race([completion, timeout, aborted]);
  }

  private timeout(): Promise<never> {
    return new Promise((_resolve, reject) => {
      this.timer = setTimeout(() => {
        reject(this.options.interruption("timeout"));
      }, this.options.timeoutMs);
    });
  }

  private aborted(): Promise<never> {
    return new Promise((_resolve, reject) => {
      const signal = this.options.signal;
      if (!signal) return;
      this.cancel = () => {
        reject(this.options.interruption("cancelled"));
      };
      if (signal.aborted) this.cancel();
      else signal.addEventListener("abort", this.cancel, { once: true });
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.cancel)
      this.options.signal?.removeEventListener("abort", this.cancel);
  }
}

interface OwnedProcess {
  pid: number;
  kill: (signal: "SIGKILL") => unknown;
}

interface TerminationOptions {
  alwaysGroup?: boolean;
  fallbackError?: "ignore" | "propagate";
}

function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    // The owned process group may already be gone.
    return false;
  }
}

function useProcessGroup(options: TerminationOptions): boolean {
  return options.alwaysGroup === true || process.platform !== "win32";
}

function killOwnedProcess(
  proc: OwnedProcess,
  options: TerminationOptions,
): void {
  if (options.fallbackError === "propagate") {
    proc.kill("SIGKILL");
    return;
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // The owned process may already have exited.
  }
}

/** Only use for children spawned in a new, runner-owned process group. */
export function terminateOwnedProcessGroup(
  proc: OwnedProcess,
  options: TerminationOptions = {},
): void {
  if (useProcessGroup(options) && killGroup(proc.pid)) return;
  killOwnedProcess(proc, options);
}

type RejectedCapture = {
  overflow: "reject";
  exceeded: () => Error;
};

interface CaptureOptions {
  limit: number;
  observe?: (bytes: Uint8Array) => void;
  cancelOnError?: boolean;
}

type ByteCaptureOptions = CaptureOptions &
  (RejectedCapture | { overflow: "truncate" });

function retainedChunk(
  bytes: Uint8Array,
  size: number,
  options: ByteCaptureOptions,
): Uint8Array {
  if (options.overflow === "reject" && size + bytes.byteLength > options.limit)
    throw options.exceeded();
  return bytes.subarray(0, Math.max(0, options.limit - size));
}

/** Truncation retains a byte prefix while still draining the entire stream. */
export async function captureBoundedBytes(
  stream: ReadableStream<Uint8Array>,
  options: ByteCaptureOptions,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const bytes of stream.values({
    preventCancel: !options.cancelOnError,
  })) {
    options.observe?.(bytes);
    const retained = retainedChunk(bytes, size, options);
    if (retained.byteLength) chunks.push(retained);
    size += retained.byteLength;
    truncated ||= retained.byteLength !== bytes.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

/** Reject oversize output before strictly decoding the complete UTF-8 stream. */
export async function captureBoundedText(
  stream: ReadableStream<Uint8Array>,
  options: CaptureOptions & RejectedCapture,
): Promise<string> {
  const { bytes } = await captureBoundedBytes(stream, options);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
