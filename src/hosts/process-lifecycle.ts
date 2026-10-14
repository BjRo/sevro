import { ProcessDeadline } from "../process-lifecycle";

export const MAX_EVENT_BYTES = 8 * 1024 * 1024;
export class HostProcessInterruption extends Error {
  constructor(
    host: string,
    readonly reason: "timeout" | "cancelled",
  ) {
    super(`${host} run ${reason === "timeout" ? "timed out" : "cancelled"}`);
  }
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
  const deadline = new ProcessDeadline({
    ...options,
    interruption: (reason) => new HostProcessInterruption(options.host, reason),
  });
  try {
    return await deadline.wait(completed);
  } catch (error) {
    options.stop(proc);
    await proc.exited;
    throw error;
  } finally {
    deadline.dispose();
  }
}
