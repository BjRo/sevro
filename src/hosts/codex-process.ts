import {
  awaitHostProcess,
  boundedProcessText,
  MAX_EVENT_BYTES,
  HostProcessInterruption,
} from "./process-lifecycle";
import type { HostResult } from "../evaluation-types";

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

export class CodexProcessFailure extends Error {
  readonly result: HostResult;
  constructor(
    phase: Phase,
    process: Result,
    reason: NonNullable<HostResult["processFailure"]>["reason"] = "exit",
    timeoutMs = 60_000,
  ) {
    const failure = { phase, reason, timeoutMs };
    super(
      codexFailureMessage({
        finalMessage: null,
        complete: false,
        processFailure: failure,
      }),
    );
    this.result = {
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
  }
}

/** Drain stderr even after the retained 64 KiB prefix is full. */
async function captureStderr(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const bytes of stream) {
    const retained = bytes.subarray(0, Math.max(0, 64 * 1024 - size));
    if (retained.byteLength) chunks.push(retained);
    size += retained.byteLength;
    truncated ||= retained.byteLength !== bytes.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

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

interface CodexProcessOptions {
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

function spawnCodexProcess(options: CodexProcessOptions) {
  return Bun.spawn(options.argv, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function processPhase(options: CodexProcessOptions): Phase {
  return options.phase ?? "execution";
}

export async function runCodexProcess(
  options: CodexProcessOptions,
): Promise<Result> {
  if (options.signal?.aborted) throw new Error("Codex run cancelled");
  const started = performance.now();
  const proc = spawnCodexProcess(options);
  const completed = Promise.all([
    boundedProcessText(
      proc.stdout,
      MAX_EVENT_BYTES,
      "Codex event stream exceeds the size limit",
    ),
    proc.exited,
    captureStderr(proc.stderr),
    writeCodexInput(proc, options.input),
  ]).then(([out, code, stderr]) => ({
    out,
    code,
    stderr: stderr.bytes,
    stderrTruncated: stderr.truncated,
    signal: proc.signalCode ?? null,
    durationMs: performance.now() - started,
  }));
  try {
    return await awaitHostProcess(proc, completed, {
      ...options,
      host: "Codex",
      stop: stopProcess,
    });
  } catch (cause) {
    if (!(cause instanceof HostProcessInterruption)) throw cause;
    throw new CodexProcessFailure(
      processPhase(options),
      await completed,
      cause.reason,
      options.timeoutMs,
    );
  }
}
