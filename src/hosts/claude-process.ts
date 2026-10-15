import {
  awaitHostProcess,
  MAX_EVENT_BYTES,
  HostProcessInterruption,
} from "./process-lifecycle";
import {
  captureBoundedText,
  terminateOwnedProcessGroup,
} from "../process-lifecycle";
import {
  HostProcessDiagnostics,
  type HostDiagnostics,
} from "../host-diagnostics";

const MAX_STDERR_BYTES = 64 * 1024;

function stop(proc: Bun.Subprocess): void {
  if (process.platform !== "win32") {
    terminateOwnedProcessGroup(proc, { fallbackError: "propagate" });
    return;
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

interface ClaudeProcessOptions {
  diagnostics?: HostDiagnostics;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

function requireClaudeProcess(options: ClaudeProcessOptions): void {
  if (options.signal?.aborted) throw new Error("Claude run cancelled");
}

function spawnClaudeProcess(
  options: ClaudeProcessOptions,
  capture: HostProcessDiagnostics,
) {
  try {
    return Bun.spawn(options.argv, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    capture.recordUnstarted();
    throw cause;
  }
}

function claudeCompletion(
  proc: ReturnType<typeof spawnClaudeProcess>,
  capture: HostProcessDiagnostics,
) {
  const stdout = captureBoundedText(proc.stdout, {
    limit: MAX_EVENT_BYTES,
    overflow: "reject",
    exceeded: () => new Error("Claude process output exceeds its limit"),
    observe: (bytes) => {
      capture.stdout.add(bytes);
    },
  });
  const stderr = captureBoundedText(proc.stderr, {
    limit: MAX_STDERR_BYTES,
    overflow: "reject",
    exceeded: () => new Error("Claude process output exceeds its limit"),
    observe: (bytes) => {
      capture.stderr.add(bytes);
    },
  });
  const completed = Promise.all([stdout, stderr, proc.exited]).then(
    ([out, err, code]) => ({ out, err, code }),
  );
  return { completed, drains: [stdout, stderr] };
}

function claudeInterruptionReason(cause: unknown) {
  return cause instanceof HostProcessInterruption ? cause.reason : "error";
}

export async function runClaudeProcess(
  options: ClaudeProcessOptions,
): Promise<{ code: number; out: string; err: string }> {
  requireClaudeProcess(options);
  const capture = new HostProcessDiagnostics(options.diagnostics);
  const proc = spawnClaudeProcess(options, capture);
  const { completed, drains } = claudeCompletion(proc, capture);
  try {
    const result = await awaitHostProcess(proc, completed, {
      ...options,
      host: "Claude",
      stop,
    });
    await capture.record(proc);
    return result;
  } catch (cause) {
    await Promise.allSettled(drains);
    await capture.record(proc, claudeInterruptionReason(cause));
    throw cause;
  }
}
