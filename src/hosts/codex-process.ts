import {
  awaitHostProcess,
  MAX_EVENT_BYTES,
  HostProcessInterruption,
} from "./process-lifecycle";
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

type Phase = NonNullable<HostResult["processFailure"]>["phase"];
type Result = {
  code: number;
  out: string;
  stderr: Uint8Array;
  stderrTruncated: boolean;
  signal: string | null;
  durationMs: number;
};

export function codexFailureMessage(result: HostResult): string | undefined {
  const failure = result.processFailure;
  if (!failure) return undefined;
  const labels = {
    "isolation-preflight": "Codex isolation preflight",
    "executable-preflight": "Codex executable preflight",
    execution: "Codex run",
  };
  if (!Object.hasOwn(labels, failure.phase)) return undefined;
  return `${labels[failure.phase]} ${failureSuffix(failure)}`;
}

function validTimeout(timeoutMs: number): boolean {
  return (
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30 * 60_000
  );
}

function failureSuffix(
  failure: NonNullable<HostResult["processFailure"]>,
): string {
  if (failure.reason === "timeout" && validTimeout(failure.timeoutMs))
    return `timed out after ${failure.timeoutMs / 1000} s`;
  return failure.reason === "cancelled" ? "cancelled" : "failed";
}

export class CodexProcessFailure extends HostExecutionFailure {
  constructor(
    phase: Phase,
    process: Result,
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
          id: "codex.process",
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
        { id: "codex.stderr", bytes: process.stderr },
      ],
    };
    super(codexFailureMessage(result), result);
  }
}

interface CodexProcessOptions {
  diagnostics?: HostDiagnostics;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  phase?: Phase;
}

async function writeCodexInput(
  proc: Bun.Subprocess,
  input?: string,
): Promise<void> {
  if (input === undefined) return;
  if (!proc.stdin || typeof proc.stdin === "number")
    throw new Error("Codex input pipe unavailable");
  await proc.stdin.write(input);
  await proc.stdin.end();
}

function spawnCodexProcess(
  options: CodexProcessOptions,
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

function processPhase(options: CodexProcessOptions): Phase {
  return options.phase ?? "execution";
}

function requireCodexProcess(options: CodexProcessOptions): void {
  if (options.signal?.aborted) throw new Error("Codex run cancelled");
}

function codexCompletion(
  proc: ReturnType<typeof spawnCodexProcess>,
  options: CodexProcessOptions,
  capture: HostProcessDiagnostics,
) {
  const started = performance.now();
  const stdout = captureBoundedText(proc.stdout, {
    limit: MAX_EVENT_BYTES,
    overflow: "reject",
    exceeded: () => new Error("Codex event stream exceeds the size limit"),
    observe: (bytes) => {
      capture.stdout.add(bytes);
    },
  });
  const stderr = captureBoundedBytes(proc.stderr, {
    limit: 64 * 1024,
    overflow: "truncate",
    cancelOnError: true,
    observe: (bytes) => {
      capture.stderr.add(bytes);
    },
  });
  const input = writeCodexInput(proc, options.input);
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
  return { completed, drains: [stdout, stderr, input] };
}

export async function runCodexProcess(
  options: CodexProcessOptions,
): Promise<Result> {
  requireCodexProcess(options);
  const capture = new HostProcessDiagnostics(options.diagnostics);
  const proc = spawnCodexProcess(options, capture);
  const { completed, drains } = codexCompletion(proc, options, capture);
  try {
    const result = await awaitHostProcess(proc, completed, {
      ...options,
      host: "Codex",
      stop: terminateOwnedProcessGroup,
    });
    await capture.record(proc);
    return result;
  } catch (cause) {
    if (!(cause instanceof HostProcessInterruption)) {
      await Promise.allSettled(drains);
      await capture.record(proc, "error");
      throw cause;
    }
    const result = await completed;
    await capture.record(proc, cause.reason);
    throw new CodexProcessFailure(
      processPhase(options),
      result,
      cause.reason,
      options.timeoutMs,
    );
  }
}
