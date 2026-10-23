import { validHostTimeout } from "./native-request";
import { ProcessDeadline } from "../process-lifecycle";
import {
  captureBoundedBytes,
  captureBoundedText,
  terminateOwnedProcessGroup,
} from "../process-lifecycle";
import { HostExecutionFailure, type HostResult } from "../evaluation/types";
import {
  HostProcessDiagnostics,
  type HostDiagnostics,
} from "../host-diagnostics";

export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;
class HostProcessInterruption extends Error {
  constructor(
    host: string,
    readonly reason: "timeout" | "cancelled",
  ) {
    super(`${host} run ${reason === "timeout" ? "timed out" : "cancelled"}`);
  }
}

/** Race completion against the host deadline and cancellation, then release listeners. */
async function awaitHostProcess<T>(
  proc: Bun.Subprocess,
  completed: Promise<T>,
  options: HostProcessOptions,
): Promise<T> {
  const deadline = new ProcessDeadline({
    ...options,
    interruption: (reason) => new HostProcessInterruption(options.host, reason),
  });
  try {
    return await deadline.wait(completed);
  } catch (error) {
    terminateOwnedProcessGroup(proc);
    await proc.exited;
    throw error;
  } finally {
    deadline.dispose();
  }
}

export type Phase = NonNullable<HostResult["processFailure"]>["phase"];
export type HostProcessResult = {
  code: number;
  out: string;
  stderr: Uint8Array;
  stderrTruncated: boolean;
  signal: string | null;
  durationMs: number;
};

export function hostFailureMessage(
  result: HostResult,
  host: string,
): string | undefined {
  const failure = result.processFailure;
  if (!failure) return undefined;
  const labels = {
    "isolation-preflight": `${host} isolation preflight`,
    "executable-preflight": `${host} executable preflight`,
    execution: `${host} run`,
  };
  if (!Object.hasOwn(labels, failure.phase)) return undefined;
  return `${labels[failure.phase]} ${failureSuffix(failure)}`;
}

function failureSuffix(
  failure: NonNullable<HostResult["processFailure"]>,
): string {
  if (failure.reason === "timeout" && validHostTimeout(failure.timeoutMs))
    return `timed out after ${failure.timeoutMs / 1000} s`;
  return failure.reason === "cancelled" ? "cancelled" : "failed";
}

export class HostProcessFailure extends HostExecutionFailure {
  constructor(
    host: "Codex" | "Claude",
    phase: Phase,
    process: HostProcessResult,
    reason: NonNullable<HostResult["processFailure"]>["reason"] = "exit",
    timeoutMs = 60_000,
  ) {
    const failure = { phase, reason, timeoutMs };
    const result: HostResult = {
      finalMessage: null,
      complete: false,
      executionFailed: true,
      actualCondition: "passive",
      processFailure: failure,
      artifacts: [
        {
          id: `${host.toLowerCase()}.process`,
          bytes: Buffer.from(
            JSON.stringify({
              ...failure,
              code: process.code,
              signal: process.signal,
              durationMs: process.durationMs,
              stderrTruncated: process.stderrTruncated,
            }),
          ),
        },
        { id: `${host.toLowerCase()}.stderr`, bytes: process.stderr },
      ],
    };
    super(hostFailureMessage(result, host), result);
  }
}

export interface HostProcessOptions {
  host: "Codex" | "Claude";
  diagnostics: HostDiagnostics;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  phase?: Phase;
}

async function writeHostInput(
  proc: Bun.Subprocess,
  input?: string,
): Promise<void> {
  if (input === undefined) return;
  if (!proc.stdin || typeof proc.stdin === "number")
    throw new Error("Codex input pipe unavailable");
  await proc.stdin.write(input);
  await proc.stdin.end();
}

function spawnHostProcess(
  options: HostProcessOptions,
  capture: HostProcessDiagnostics,
) {
  try {
    return Bun.spawn(options.argv, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdin: options.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    capture.recordUnstarted();
    throw cause;
  }
}

function processPhase(options: HostProcessOptions): Phase {
  return options.phase ?? "execution";
}

function requireHostProcess(options: HostProcessOptions): void {
  if (options.signal?.aborted) throw new Error(`${options.host} run cancelled`);
}

function hostCompletion(
  proc: ReturnType<typeof spawnHostProcess>,
  options: HostProcessOptions,
  capture: HostProcessDiagnostics,
) {
  const started = performance.now();
  const stdout = captureBoundedText(proc.stdout, {
    limit: MAX_EVENT_BYTES,
    overflow: "reject",
    exceeded: () =>
      new Error(`${options.host} event stream exceeds the size limit`),
    observe: (bytes) => {
      capture.stdout.add(bytes);
    },
  });
  const stderr = captureBoundedBytes(proc.stderr, {
    limit: MAX_STDERR_BYTES,
    overflow: "truncate",
    cancelOnError: true,
    observe: (bytes) => {
      capture.stderr.add(bytes);
    },
  });
  const input = writeHostInput(proc, options.input);
  const completed = Promise.all([stdout, proc.exited, stderr, input]).then(
    ([out, code, err]) => ({
      out,
      code,
      stderr: err.bytes,
      stderrTruncated: err.truncated,
      signal: proc.signalCode ?? null,
      durationMs: performance.now() - started,
    }),
  );
  return { completed, drains: [stdout, stderr, input], started };
}

export async function runHostProcess(
  options: HostProcessOptions,
): Promise<HostProcessResult> {
  requireHostProcess(options);
  const capture = new HostProcessDiagnostics(options.diagnostics);
  const proc = spawnHostProcess(options, capture);
  const { completed, drains, started } = hostCompletion(proc, options, capture);
  try {
    const result = await awaitHostProcess(proc, completed, {
      ...options,
    });
    await capture.record(proc);
    return result;
  } catch (cause) {
    await Promise.allSettled(drains);
    if (!(cause instanceof HostProcessInterruption)) {
      await capture.record(proc, "error");
      throw cause;
    }
    await capture.record(proc, cause.reason);
    throw new HostProcessFailure(
      options.host,
      processPhase(options),
      {
        code: await proc.exited,
        out: capture.stdout.bytes().toString("utf8"),
        stderr: capture.stderr.bytes(),
        stderrTruncated: capture.stderr.truncated,
        signal: proc.signalCode ?? null,
        durationMs: performance.now() - started,
      },
      cause.reason,
      options.timeoutMs,
    );
  }
}
